import * as oidc from 'openid-client';
import { SAML } from '@node-saml/node-saml';
import { Client as LdapClient } from 'ldapts';
import { config } from '../config.js';
import { cache } from '../cache/index.js';
import { getDb } from '../db/index.js';
import { newId, randomToken } from '../lib/ids.js';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
} from './users.js';

const SSO_TTL_SECONDS = 10 * 60;
let discoveredOidc;
let samlClient;

export function resetEnterpriseAuthClients() {
  discoveredOidc = undefined;
  samlClient = undefined;
}

export function enterpriseAuthProviders() {
  return [
    ...(oidcEnabled() ? [{ id: 'oidc', label: config.oidc.label, mode: 'redirect' }] : []),
    ...(samlEnabled() ? [{ id: 'saml', label: config.saml.label, mode: 'redirect' }] : []),
    ...(ldapEnabled() ? [{ id: 'ldap', label: config.ldap.label, mode: 'credentials' }] : []),
  ];
}

export async function oidcStart() {
  if (!oidcEnabled()) throw badRequest('OIDC is not configured.');
  const client = await oidcConfiguration();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  await cache.set(`sso:oidc:${state}`, { verifier, nonce }, SSO_TTL_SECONDS);
  return oidc
    .buildAuthorizationUrl(client, {
      redirect_uri: oidcCallbackUrl(),
      scope: config.oidc.scopes,
      response_type: 'code',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    .href;
}

export async function oidcCallback(currentUrl) {
  if (!oidcEnabled()) throw badRequest('OIDC is not configured.');
  const state = currentUrl.searchParams.get('state');
  const pending = state ? await cache.get(`sso:oidc:${state}`) : null;
  if (!state || !pending) throw unauthorized('The SSO request expired or is invalid.');
  await cache.del(`sso:oidc:${state}`);

  const client = await oidcConfiguration();
  const tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  let claims = tokens.claims();
  if ((!claims?.email || claims.email_verified !== true) && tokens.access_token && claims?.sub) {
    claims = await oidc.fetchUserInfo(client, tokens.access_token, claims.sub);
  }
  if (!claims?.sub || !claims.email || claims.email_verified !== true) {
    throw forbidden('The identity provider must return a verified email address.');
  }
  return linkOrProvisionExternalIdentity({
    provider: 'oidc',
    subject: claims.sub,
    email: claims.email,
    displayName: claims.name || claims.preferred_username || claims.email,
    username: claims.preferred_username,
    profile: {
      issuer: claims.iss,
      tenant: claims.tid,
      groups: Array.isArray(claims.groups) ? claims.groups.slice(0, 100) : undefined,
    },
    autoProvision: config.oidc.autoProvision,
    allowedDomains: config.oidc.allowedDomains,
  });
}

export async function samlStart() {
  const client = getSamlClient();
  const relayState = randomToken(24);
  await cache.set(`sso:saml:relay:${relayState}`, true, SSO_TTL_SECONDS);
  return client.getAuthorizeUrlAsync(relayState, undefined, {});
}

export async function samlCallback(body) {
  const relayState = String(body.RelayState ?? '');
  const pending = relayState ? await cache.get(`sso:saml:relay:${relayState}`) : null;
  if (!pending) throw unauthorized('The SAML request expired or is invalid.');
  await cache.del(`sso:saml:relay:${relayState}`);
  const result = await getSamlClient().validatePostResponseAsync(body);
  if (result.loggedOut || !result.profile?.nameID) throw unauthorized('SAML authentication failed.');
  const profile = result.profile;
  const email = first(profile.email ?? profile.mail ?? profile.nameID);
  return linkOrProvisionExternalIdentity({
    provider: 'saml',
    subject: profile.nameID,
    email,
    displayName: first(profile.displayName ?? profile.cn ?? email),
    username: first(profile.uid ?? profile.username),
    profile: {
      issuer: profile.issuer,
      sessionIndex: profile.sessionIndex,
    },
    autoProvision: config.saml.autoProvision,
    allowedDomains: config.saml.allowedDomains,
  });
}

export function samlMetadata() {
  const client = getSamlClient();
  return client.generateServiceProviderMetadata(
    null,
    config.saml.publicCert || null,
  );
}

export async function ldapAuthenticate(identifier, password) {
  if (!ldapEnabled()) throw badRequest('LDAP is not configured.');
  if (!password) throw unauthorized('Incorrect credentials.');
  if (!config.ldap.url.startsWith('ldaps://') && !config.ldap.allowInsecure) {
    throw new Error('LDAP authentication requires LDAPS unless LDAP_ALLOW_INSECURE is explicitly enabled.');
  }

  const directory = ldapClient();
  let entry;
  try {
    await directory.bind(config.ldap.bindDn, config.ldap.bindPassword);
    const escaped = escapeLdapFilter(identifier);
    const filter = config.ldap.searchFilter.replaceAll('{{username}}', escaped);
    const result = await directory.search(config.ldap.searchBase, {
      scope: 'sub',
      filter,
      sizeLimit: 2,
      attributes: [
        config.ldap.emailAttribute,
        config.ldap.displayNameAttribute,
        config.ldap.usernameAttribute,
      ],
    });
    if (result.searchEntries.length !== 1) throw unauthorized('Incorrect credentials.');
    entry = result.searchEntries[0];
  } finally {
    await directory.unbind().catch(() => {});
  }

  const userBind = ldapClient();
  try {
    await userBind.bind(entry.dn, password);
  } catch {
    throw unauthorized('Incorrect credentials.');
  } finally {
    await userBind.unbind().catch(() => {});
  }

  const email = first(entry[config.ldap.emailAttribute]);
  return linkOrProvisionExternalIdentity({
    provider: 'ldap',
    subject: entry.dn,
    email,
    displayName: first(entry[config.ldap.displayNameAttribute] ?? email),
    username: first(entry[config.ldap.usernameAttribute]),
    profile: { dn: entry.dn },
    autoProvision: config.ldap.autoProvision,
    allowedDomains: config.ldap.allowedDomains,
  });
}

async function linkOrProvisionExternalIdentity({
  provider,
  subject,
  email,
  displayName,
  username,
  profile,
  autoProvision,
  allowedDomains,
}) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail.includes('@')) throw forbidden('The directory did not provide a valid email.');
  const domain = normalizedEmail.split('@').at(-1);
  if (allowedDomains.length && !allowedDomains.includes(domain)) {
    throw forbidden('This email domain is not allowed.');
  }

  const existingIdentity = await getDb().get(
    'SELECT user_id FROM external_identities WHERE provider = ? AND subject = ?',
    [provider, String(subject)],
  );
  let user = existingIdentity ? await findUserById(existingIdentity.user_id) : null;
  if (!user) user = await findUserByEmail(normalizedEmail);
  if (!user) {
    if (!autoProvision) {
      throw forbidden('Your identity is valid, but an administrator must provision your account.');
    }
    const derivedUsername = await availableUsername(username || normalizedEmail.split('@')[0]);
    user = await createUser({
      email: normalizedEmail,
      username: derivedUsername,
      displayName: String(displayName || derivedUsername).slice(0, 48),
      password: `${randomToken(32)}Aa1!`,
      mustChangePassword: false,
    });
  }
  if (!user.is_active || user.banned_at) throw forbidden('This account is not active.');

  const now = Date.now();
  await getDb().run(
    `INSERT INTO external_identities
      (id, user_id, provider, subject, email, profile, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, subject) DO UPDATE SET
       user_id = excluded.user_id, email = excluded.email,
       profile = excluded.profile, last_login_at = excluded.last_login_at`,
    [
      newId(),
      user.id,
      provider,
      String(subject),
      normalizedEmail,
      JSON.stringify(profile ?? {}),
      now,
      now,
    ],
  );
  return user;
}

async function availableUsername(candidate) {
  const base =
    String(candidate ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 24) || 'member';
  const padded = base.length >= 3 ? base : `${base}-user`;
  if (!(await findUserByUsername(padded))) return padded;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = `${padded.slice(0, 25)}-${randomToken(4).slice(0, 6).toLowerCase()}`;
    if (!(await findUserByUsername(next))) return next;
  }
  throw new Error('Could not allocate a unique username.');
}

async function oidcConfiguration() {
  discoveredOidc ??= oidc.discovery(
    new URL(config.oidc.issuer),
    config.oidc.clientId,
    config.oidc.clientSecret,
  );
  return discoveredOidc;
}

function getSamlClient() {
  if (!samlEnabled()) throw badRequest('SAML is not configured.');
  if (!samlClient) {
    samlClient = new SAML({
      callbackUrl: samlCallbackUrl(),
      entryPoint: config.saml.entryPoint,
      issuer: config.saml.issuer,
      audience: config.saml.issuer,
      idpIssuer: config.saml.idpIssuer || undefined,
      idpCert: config.saml.idpCert,
      privateKey: config.saml.privateKey || undefined,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      validateInResponseTo: 'always',
      acceptedClockSkewMs: 120_000,
      maxAssertionAgeMs: 5 * 60_000,
      cacheProvider: samlCacheProvider,
    });
  }
  return samlClient;
}

const samlCacheProvider = {
  async saveAsync(key, value) {
    await cache.set(`sso:saml:request:${key}`, value, SSO_TTL_SECONDS);
    return { value, createdAt: Date.now() };
  },
  async getAsync(key) {
    return key ? cache.get(`sso:saml:request:${key}`) : null;
  },
  async removeAsync(key) {
    if (!key) return null;
    const cacheKey = `sso:saml:request:${key}`;
    const value = await cache.get(cacheKey);
    await cache.del(cacheKey);
    return value;
  },
};

function ldapClient() {
  return new LdapClient({
    url: config.ldap.url,
    timeout: 8_000,
    connectTimeout: 5_000,
    strictDN: true,
    tlsOptions: {
      minVersion: 'TLSv1.2',
      ...(config.ldap.ca ? { ca: [config.ldap.ca] } : {}),
    },
  });
}

function oidcEnabled() {
  return Boolean(config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret);
}

function samlEnabled() {
  return Boolean(config.saml.entryPoint && config.saml.issuer && config.saml.idpCert);
}

function ldapEnabled() {
  return Boolean(
    config.ldap.url &&
      config.ldap.bindDn &&
      config.ldap.bindPassword &&
      config.ldap.searchBase,
  );
}

function oidcCallbackUrl() {
  return new URL('/api/auth/sso/oidc/callback', config.publicUrl).href;
}

function samlCallbackUrl() {
  return new URL('/api/auth/sso/saml/callback', config.publicUrl).href;
}

function escapeLdapFilter(value) {
  return String(value).replace(/[\0()*\\]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${code}`;
  });
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
