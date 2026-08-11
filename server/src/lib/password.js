import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// Memory-hard parameters: ~64 MB per hash. Deliberately expensive so that an
// offline attacker with the database still faces a hard wall.
const PARAMS = { N: 2 ** 16, r: 8, p: 1, keylen: 64 };
const MAX_MEM = 132 * 1024 * 1024;

/**
 * scrypt from Node's own crypto module — no native addon to build, and a
 * stronger choice than plain bcrypt against GPU cracking.
 * Format: scrypt$N$r$p$salt$hash (all base64url).
 */
export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(normalize(plain), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = await scrypt(normalize(plain), salt, expected.length, { N, r, p, maxmem: MAX_MEM });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

/** Unicode-normalise so the same typed password always maps to the same bytes. */
function normalize(plain) {
  return Buffer.from(String(plain).normalize('NFKC'), 'utf8');
}

const COMMON = new Set([
  'password', '12345678', '123456789', 'qwerty123', 'password1', 'admin123',
  'welcome1', 'letmein1', 'iloveyou', 'password123', '11111111', 'abc12345',
]);

/**
 * Password policy for admin-created accounts. Returns a list of problems;
 * empty means acceptable.
 */
export function passwordProblems(plain) {
  const problems = [];
  const value = String(plain ?? '');
  if (value.length < 10) problems.push('Password must be at least 10 characters.');
  if (value.length > 200) problems.push('Password must be at most 200 characters.');
  if (!/[a-z]/.test(value)) problems.push('Password must contain a lowercase letter.');
  if (!/[A-Z]/.test(value)) problems.push('Password must contain an uppercase letter.');
  if (!/[0-9]/.test(value)) problems.push('Password must contain a digit.');
  if (!/[^A-Za-z0-9]/.test(value)) problems.push('Password must contain a symbol.');
  if (COMMON.has(value.toLowerCase())) problems.push('Password is too common.');
  if (/^(.)\1+$/.test(value)) problems.push('Password must not be a single repeated character.');
  return problems;
}

/** Suggests a strong password for the admin "create user" form. */
export function suggestPassword() {
  const sets = [
    'abcdefghijkmnopqrstuvwxyz',
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    '23456789',
    '!@#$%^&*-_=+?',
  ];
  const all = sets.join('');
  const chars = sets.map((set) => set[crypto.randomInt(set.length)]);
  while (chars.length < 18) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
