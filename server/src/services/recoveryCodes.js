import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const DEFAULT_COUNT = 10;

function normalize(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code, key = config.recoverySigningKey || config.secret) {
  return crypto
    .createHmac('sha256', key)
    .update(`mfa-recovery:${normalize(code)}`)
    .digest('hex');
}

function createCode() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let index = 0; index < 16; index += 1) {
    raw += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return raw.match(/.{1,4}/g).join('-');
}

/**
 * Replaces every existing recovery code. Plaintext is returned once and never
 * stored; only a keyed digest is persisted.
 */
export async function replaceRecoveryCodes(userId, count = DEFAULT_COUNT) {
  const codes = Array.from({ length: count }, createCode);
  const now = Date.now();
  await getDb().tx(async (tx) => {
    await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
    for (const code of codes) {
      await tx.run(
        `INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
         VALUES (?, ?, ?, ?)`,
        [newId(), userId, hashCode(code), now],
      );
    }
  });
  return codes;
}

export async function consumeRecoveryCode(userId, code) {
  const normalized = normalize(code);
  if (normalized.length !== 16) return false;
  const hashes = [
    config.recoverySigningKey || config.secret,
    ...config.recoveryPreviousSigningKeys,
  ].map((key) => hashCode(normalized, key));
  return getDb().tx(async (tx) => {
    const row = await tx.get(
      `SELECT id FROM recovery_codes
       WHERE user_id = ? AND code_hash IN (${hashes.map(() => '?').join(', ')})
         AND used_at IS NULL`,
      [userId, ...hashes],
    );
    if (!row) return false;
    const result = await tx.run(
      'UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
      [Date.now(), row.id],
    );
    return result.changes === 1;
  });
}

export async function recoveryCodeStatus(userId) {
  const row = await getDb().get(
    `SELECT COUNT(*) AS total,
      SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS remaining
     FROM recovery_codes WHERE user_id = ?`,
    [userId],
  );
  return {
    total: Number(row?.total ?? 0),
    remaining: Number(row?.remaining ?? 0),
  };
}

export async function deleteRecoveryCodes(userId) {
  await getDb().run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
}
