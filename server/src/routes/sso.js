import express from 'express';
import { config } from '../config.js';
import { asyncRoute } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { createSession, csrfTokenFor } from '../services/sessions.js';
import { audit } from '../services/audit.js';
import { invalidateUser, toSelfUser, withBadges } from '../services/users.js';
import { getPublicSettings } from '../services/settings.js';
import { clientIp } from '../middleware/auth.js';
import { loginIpLimiter, loginLimiter } from '../middleware/rateLimit.js';
import { recordSecurityEvent } from '../services/securityEvents.js';
import {
  enterpriseAuthProviders,
  ldapAuthenticate,
  oidcCallback,
  oidcStart,
  samlCallback,
  samlMetadata,
  samlStart,
} from '../services/enterpriseAuth.js';
import { getDb } from '../db/index.js';

export const ssoRouter = express.Router();

ssoRouter.get('/providers', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  return res.json({ providers: enterpriseAuthProviders() });
});

ssoRouter.get(
  '/oidc/start',
  asyncRoute(async (_req, res) => res.redirect(302, await oidcStart())),
);

ssoRouter.get(
  '/oidc/callback',
  asyncRoute(async (req, res) => {
    const user = await oidcCallback(new URL(req.originalUrl, config.publicUrl));
    await completeEnterpriseLogin(req, res, user, 'oidc');
    return res.redirect(302, ssoResultUrl());
  }),
);

ssoRouter.get(
  '/saml/start',
  asyncRoute(async (_req, res) => res.redirect(302, await samlStart())),
);

ssoRouter.post(
  '/saml/callback',
  asyncRoute(async (req, res) => {
    const user = await samlCallback(req.body);
    await completeEnterpriseLogin(req, res, user, 'saml');
    return res.redirect(303, ssoResultUrl());
  }),
);

ssoRouter.get(
  '/saml/metadata',
  asyncRoute(async (_req, res) => {
    res.type('application/samlmetadata+xml');
    return res.send(samlMetadata());
  }),
);

ssoRouter.post(
  '/ldap/login',
  loginIpLimiter,
  loginLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        identifier: z.string().trim().min(1).max(254),
        password: z.string().min(1).max(512),
      }),
      req.body,
    );
    const user = await ldapAuthenticate(body.identifier, body.password);
    const session = await completeEnterpriseLogin(req, res, user, 'ldap');
    return res.json({
      user: toSelfUser(await withBadges(user)),
      csrfToken: csrfTokenFor(session.csrfSecret),
      settings: await getPublicSettings(),
    });
  }),
);

async function completeEnterpriseLogin(req, res, user, provider) {
  const ip = clientIp(req);
  const userAgent = req.get('user-agent');
  const now = Date.now();
  await getDb().run(
    `UPDATE users SET failed_logins = 0, locked_until = NULL,
      last_login_at = ?, last_seen_at = ? WHERE id = ?`,
    [now, now, user.id],
  );
  await invalidateUser(user.id);
  const session = await createSession({ userId: user.id, userAgent, ip });
  setAuthCookies(res, session);
  await audit({
    actorId: user.id,
    action: 'auth.enterprise_login',
    targetType: 'user',
    targetId: user.id,
    meta: { provider },
    ip,
  });
  await recordSecurityEvent({
    userId: user.id,
    event: 'auth.new_login',
    severity: 'info',
    ip,
    userAgent,
    meta: { provider },
    notifyUser: true,
  });
  return session;
}

function setAuthCookies(res, session) {
  res.cookie(config.cookieName, session.token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    expires: new Date(session.expiresAt),
  });
  res.cookie(config.csrfCookieName, csrfTokenFor(session.csrfSecret), {
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    expires: new Date(session.expiresAt),
  });
}

function ssoResultUrl() {
  const base = config.clientOrigins[0] || config.publicUrl;
  const target = new URL('/', base);
  target.searchParams.set('sso', 'success');
  return target.href;
}
