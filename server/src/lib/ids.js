import crypto from 'node:crypto';

/**
 * Sortable, collision-resistant id: 48-bit timestamp + 80 bits of randomness,
 * base32 encoded (Crockford-ish, lowercase). Lexicographic order == time order,
 * which lets us paginate messages with a plain `id < ?` cursor.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newId() {
  const time = Date.now();
  const buf = Buffer.alloc(16);
  buf.writeUIntBE(time, 0, 6);
  crypto.randomFillSync(buf, 6, 10);
  return encode(buf);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Short human-typable invite code. */
export function inviteCode() {
  const buf = crypto.randomBytes(8);
  let out = '';
  for (const byte of buf) out += ALPHABET[byte & 31];
  return out;
}
