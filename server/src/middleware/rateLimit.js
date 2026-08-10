import rateLimit from 'express-rate-limit';
import { clientIp } from './auth.js';
import { tooMany } from '../lib/errors.js';

function make({ windowMs, max, message, byUser = false, key }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) =>
      key?.(req) ?? (byUser && req.user ? `u:${req.user.id}` : `i:${clientIp(req)}`),
    handler: (_req, _res, next) => next(tooMany(message)),
  });
}

/** Broad ceiling so one client cannot saturate the API. */
export const globalLimiter = make({
  windowMs: 60_000,
  max: 600,
  message: 'Too many requests. Please slow down.',
});

/** A broad per-address ceiling protects the service without punishing a NAT
 * shared by a whole office after only a handful of legitimate sign-ins. */
export const loginIpLimiter = make({
  windowMs: 10 * 60_000,
  max: 100,
  message: 'Too many login attempts from this address. Try again later.',
});

/** The tighter ceiling is per address + account identifier. The database also
 * locks a real account after repeated failures, so both known and unknown
 * identifiers are bounded without leaking which kind was submitted. */
export const loginLimiter = make({
  windowMs: 10 * 60_000,
  max: 20,
  message: 'Too many login attempts for this account. Try again later.',
  key: (req) =>
    `login:${clientIp(req)}:${String(req.body?.identifier ?? '').trim().toLowerCase().slice(0, 254)}`,
});

export const writeLimiter = make({
  windowMs: 60_000,
  max: 240,
  message: 'You are sending messages too quickly.',
  byUser: true,
});

export const uploadLimiter = make({
  windowMs: 60_000,
  max: 30,
  message: 'Too many uploads. Please wait a moment.',
  byUser: true,
});

/** TTS calls incur third-party usage charges, so keep their ceiling separate
 * from ordinary chat writes. */
export const ttsLimiter = make({
  windowMs: 60_000,
  max: 20,
  message: 'Too many text-to-speech requests. Please wait a moment.',
  byUser: true,
});

export const adminLimiter = make({
  windowMs: 60_000,
  max: 120,
  message: 'Too many admin operations.',
  byUser: true,
});
