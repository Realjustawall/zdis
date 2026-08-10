import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

const DEFINITIONS = {
  'smtp.host': { type: 'string' },
  'smtp.port': { type: 'number' },
  'smtp.secure': { type: 'boolean' },
  'smtp.user': { type: 'string' },
  'smtp.pass': { type: 'string', secret: true },
  'smtp.from': { type: 'string' },
  'oidc.issuer': { type: 'string' },
  'oidc.clientId': { type: 'string' },
  'oidc.clientSecret': { type: 'string', secret: true },
  'oidc.label': { type: 'string' },
  'oidc.scopes': { type: 'string' },
  'oidc.autoProvision': { type: 'boolean' },
  'oidc.allowedDomains': { type: 'csv' },
  'fishAudio.apiKey': { type: 'string', secret: true },
  'fishAudio.model': { type: 'enum', values: ['s1', 's2-pro'] },
  'fishAudio.referenceId': { type: 'string' },
};

const encryptionKey = crypto.createHash('sha256').update(config.secret).digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value) {
  const [iv, tag, body] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

function normalize(key, value) {
  const definition = DEFINITIONS[key];
  if (!definition) throw new Error(`Unsupported runtime configuration key: ${key}`);
  if (definition.type === 'boolean') return Boolean(value);
  if (definition.type === 'number') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${key} is invalid.`);
    return number;
  }
  if (definition.type === 'csv') {
    return Array.isArray(value)
      ? value.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean)
      : String(value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  }
  if (definition.type === 'enum') {
    const normalized = String(value ?? '').trim();
    if (!definition.values.includes(normalized)) throw new Error(`${key} is invalid.`);
    return normalized;
  }
  return String(value ?? '').trim();
}

function apply(key, value) {
  const [section, property] = key.split('.');
  const changed = JSON.stringify(config[section][property]) !== JSON.stringify(value);
  config[section][property] = value;
  return changed;
}

export async function loadRuntimeConfiguration() {
  const rows = await getDb().all('SELECT key, encrypted_value FROM runtime_configuration');
  let changed = false;
  for (const row of rows) {
    if (!DEFINITIONS[row.key]) continue;
    try {
      changed = apply(row.key, normalize(row.key, decrypt(row.encrypted_value))) || changed;
    } catch {
      // A rotated APP_SECRET intentionally makes stale runtime secrets unusable.
    }
  }
  return { changed };
}

export async function updateRuntimeConfiguration(patch, actorId) {
  const now = Date.now();
  for (const [key, raw] of Object.entries(patch)) {
    if (!DEFINITIONS[key]) continue;
    // Empty secret means "keep the current secret", not erase it accidentally.
    if (DEFINITIONS[key].secret && !String(raw ?? '').trim()) continue;
    const value = normalize(key, raw);
    await getDb().run(
      `INSERT INTO runtime_configuration (key, encrypted_value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET encrypted_value = excluded.encrypted_value,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [key, encrypt(value), actorId, now],
    );
    apply(key, value);
  }
  return runtimeConfigurationView();
}

export function runtimeConfigurationView() {
  const result = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    const [section, property] = key.split('.');
    const value = config[section][property];
    result[key] = definition.secret ? '' : value;
    if (definition.secret) result[`${key}Configured`] = Boolean(value);
  }
  return result;
}
