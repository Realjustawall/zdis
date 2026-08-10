import dns from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config.js';
import { storageHealth } from '../services/storage.js';
import { antivirusHealth } from '../services/antivirus.js';
import { searchHealth } from '../services/search.js';

const checks = {};

async function check(name, required, fn) {
  try {
    const detail = await fn();
    const ok = detail?.ok !== false;
    checks[name] = { required, ok, ...detail };
  } catch (error) {
    checks[name] = { required, ok: false, error: error.message };
  }
}

await check('publicDns', true, async () => {
  const url = new URL(config.publicUrl);
  const addresses = await dns.lookup(url.hostname, { all: true });
  return { ok: addresses.length > 0, hostname: url.hostname, addresses: addresses.length };
});
await check('objectStorage', config.storageDriver === 's3', () => storageHealth());
await check('antivirus', config.clamav.required, () => antivirusHealth());
await check('search', config.openSearch.required, () => searchHealth());
await check('livekit', Boolean(config.livekit.url), async () => {
  if (!config.livekit.url) return { ok: true, configured: false };
  const client = new RoomServiceClient(
    config.livekit.apiUrl.replace(/^ws/, 'http'),
    config.livekit.apiKey,
    config.livekit.apiSecret,
  );
  await client.listRooms();
  return { ok: true, configured: true, regions: config.livekit.regions.length || 1 };
});
await check('smtp', Boolean(config.smtp.host), async () => {
  if (!config.smtp.host) return { ok: true, configured: false };
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transport.verify();
  transport.close();
  return { ok: true, configured: true };
});
await check('oidcDiscovery', Boolean(config.oidc.issuer), async () => {
  if (!config.oidc.issuer) return { ok: true, configured: false };
  const issuer = config.oidc.issuer.replace(/\/$/, '');
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  return { ok: response.ok, configured: true, status: response.status };
});
await check('turn', Boolean(config.turnUrl), async () => ({
  ok: !config.turnUrl || Boolean(config.turnSharedSecret || (config.turnUsername && config.turnPassword)),
  configured: Boolean(config.turnUrl),
  credentialsConfigured: Boolean(
    config.turnSharedSecret || (config.turnUsername && config.turnPassword),
  ),
}));
await check('push', false, async () => ({
  ok: true,
  configured: Boolean(config.vapid.publicKey && config.vapid.privateKey),
}));
await check('auditSigning', true, async () => ({
  ok: Boolean(config.auditSigningKey),
  dedicatedKey: Boolean(config.auditSigningKey),
}));

const failed = Object.entries(checks)
  .filter(([, value]) => value.required && !value.ok)
  .map(([name]) => name);
console.log(JSON.stringify({ ok: failed.length === 0, failed, checks }, null, 2));
if (failed.length) process.exitCode = 1;
