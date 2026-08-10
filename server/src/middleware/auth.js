import { config } from '../config.js';
import { unauthorized, forbidden, asyncRoute } from '../lib/errors.js';
import { resolveSession, touchSession, csrfMatches } from '../services/sessions.js';
import { findUserById } from '../services/users.js';
import { resolveApiKey } from '../services/integrations.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Attaches `req.session` and `req.user` when a valid session cookie is
 * present. Does not reject — use `requireAuth` for that.
 */
export const loadSession = asyncRoute(async (req, _res, next) => {
  const authorization = req.get('authorization') ?? '';
  if (authorization.startsWith('Bearer ')) {
    const apiKey = await resolveApiKey(authorization.slice(7).trim());
    if (!apiKey) return next();
    const user = await findUserById(apiKey.userId);
    if (!user || !user.is_active) return next();
    req.apiKey = apiKey;
    req.user = user;
    return next();
  }
  const token = req.cookies?.[config.cookieName];
  const session = await resolveSession(token);
  if (!session) return next();

  const user = await findUserById(session.userId);
  if (!user || !user.is_active) return next();

  req.session = session;
  req.user = user;

  // Cheap last-seen bookkeeping, at most once a minute per session.
  if (!SAFE_METHODS.has(req.method) || Math.random() < 0.05) {
    touchSession(session.id, clientIp(req)).catch(() => {});
  }
  return next();
});

export function enforceApiKeyScope(req, _res, next) {
  if (!req.apiKey) return next();
  const required = req.path.startsWith('/api/admin')
    ? 'admin'
    : SAFE_METHODS.has(req.method)
      ? 'read'
      : 'write';
  if (!req.apiKey.scopes.includes(required) && !req.apiKey.scopes.includes('admin')) {
    return next(forbidden(`API key is missing the "${required}" scope.`));
  }
  return next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  return next();
}

/** Cookie-backed session required for operations that manage that session. */
export function requireSession(req, _res, next) {
  if (!req.user || !req.session) {
    return next(unauthorized('A signed-in browser session is required.'));
  }
  return next();
}

/**
 * A user whose password was reset by an admin can only reach the endpoints
 * needed to set a new one.
 */
export function requirePasswordCurrent(req, _res, next) {
  if (req.user?.must_change_password) {
    return next(forbidden('You must change your password before continuing.'));
  }
  return next();
}

export function moderationProtection(req, _res, next) {
  if (!req.user) return next();
  if (req.user.banned_at) return next(forbidden('This account is banned.'));
  if (
    !SAFE_METHODS.has(req.method) &&
    req.user.suspended_until &&
    Number(req.user.suspended_until) > Date.now()
  ) {
    return next(
      forbidden(`This account is timed out until ${new Date(Number(req.user.suspended_until)).toISOString()}.`),
    );
  }
  return next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };
}

export const requireAdmin = requireRole('admin');

/**
 * Double-submit CSRF check on every state-changing request. Cookies are
 * SameSite=Strict already; this is the second layer.
 */
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.session) return next();

  const presented = req.get('x-csrf-token') || req.body?._csrf;
  if (!csrfMatches(req.session.csrfSecret, presented)) {
    return next(forbidden('Invalid or missing CSRF token.'));
  }
  return next();
}

export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}
