import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { asyncRoute, unauthorized, forbidden, badRequest } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { verifyPassword, passwordProblems, hashPassword } from '../lib/password.js';
import { randomToken } from '../lib/ids.js';
import { verifyTotp, generateSecret, otpauthUri } from '../lib/totp.js';
import {
  findUserByIdentifier,
  findUserById,
  createUser,
  toSelfUser,
  setPassword,
  updateUser,
  invalidateUser,
  withBadges,
} from '../services/users.js';
import {
  createSession,
  revokeSessionByToken,
  revokeAllSessions,
  listSessions,
  revokeSession,
  csrfTokenFor,
} from '../services/sessions.js';
import { getDb } from '../db/index.js';
import { cache } from '../cache/index.js';
import { audit } from '../services/audit.js';
import { getPublicSettings, getSettings } from '../services/settings.js';
import { loginIpLimiter, loginLimiter } from '../middleware/rateLimit.js';
import { requireAuth, requireSession, clientIp } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { memoryUpload, storeUpload, deleteAttachments } from '../services/uploads.js';
import {
  consumeRecoveryCode,
  deleteRecoveryCodes,
  recoveryCodeStatus,
  replaceRecoveryCodes,
} from '../services/recoveryCodes.js';
import {
  acknowledgeSecurityEvent,
  isNewLoginContext,
  listSecurityEvents,
  recordSecurityEvent,
} from '../services/securityEvents.js';
import {
  createAppeal,
  createAppealToken,
  listAppeals,
  verifyAppealToken,
} from '../services/moderation.js';

export const authRouter = express.Router();

authRouter.get(
  '/public-settings',
  asyncRoute(async (_req, res) => res.json({ settings: await getPublicSettings() })),
);

const registerSchema = z.object({
  phone: z.string().trim().regex(/^\+?[0-9]{7,20}$/, 'Enter a valid phone number.'),
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(1).max(48),
  lastName: z.string().trim().min(1).max(48),
  username: z.string().trim().toLowerCase().min(3).max(32)
    .regex(/^[a-z0-9._-]+$/, 'Username contains unsupported characters.'),
  nickname: z.string().trim().min(1).max(48),
  password: z.string().min(1).max(200),
});

authRouter.post(
  '/register',
  loginIpLimiter,
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    if (!settings.registration_enabled) throw forbidden('Public registration is disabled.');
    const body = parse(registerSchema, req.body);
    const problems = passwordProblems(body.password);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);
    const user = await createUser({
      ...body,
      displayName: body.nickname,
      role: 'member',
      createdBy: null,
    });
    await audit({
      actorId: user.id,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
    });
    return res.status(201).json({ ok: true, username: user.username });
  }),
);

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or username is required.').max(254),
  password: z.string().min(1, 'Password is required.').max(200),
  totp: z.string().trim().max(32).optional(),
});

function setSessionCookie(res, token, expiresAt) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt),
  });
}

function setCsrfCookie(res, csrfSecret, expiresAt) {
  // Readable by JS on purpose — the client echoes it back in a header.
  res.cookie(config.csrfCookieName, csrfTokenFor(csrfSecret), {
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt),
  });
}

function clearAuthCookies(res) {
  const options = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/' };
  res.clearCookie(config.cookieName, options);
  res.clearCookie(config.csrfCookieName, { ...options, httpOnly: false });
}

/** Uniform failure so the response never reveals whether an account exists. */
const GENERIC_LOGIN_FAILURE = 'Incorrect credentials.';

authRouter.post(
  '/login',
  loginIpLimiter,
  loginLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const ip = clientIp(req);

    // Per-account throttle on top of the per-IP limiter, so a botnet spraying
    // one account still trips the lockout.
    const accountKey = `login:attempt:${body.identifier.toLowerCase()}`;
    const attempts = await cache.incr(accountKey, 900);

    const user = await findUserByIdentifier(body.identifier);

    // Always spend roughly the same time whether or not the account exists.
    const ok = user ? await verifyPassword(body.password, user.password_hash) : await burnTime();

    if (!user || !ok) {
      if (user) {
        const failed = Number(user.failed_logins ?? 0) + 1;
        const locked = failed >= config.loginMaxAttempts ? Date.now() + config.loginLockoutMs : null;
        await getDb().run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [
          failed,
          locked,
          user.id,
        ]);
      }
      await audit({
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        meta: { identifier: body.identifier, attempts },
        ip,
      });
      throw unauthorized(GENERIC_LOGIN_FAILURE);
    }

    if (!user.is_active) {
      await audit({ action: 'auth.login_disabled', targetType: 'user', targetId: user.id, ip });
      throw forbidden('This account has been disabled. Contact an administrator.');
    }
    if (user.banned_at) {
      await audit({ action: 'auth.login_banned', targetType: 'user', targetId: user.id, ip });
      const action = await getDb().get(
        `SELECT id FROM moderation_actions
         WHERE target_user_id = ? AND action = 'ban'
         ORDER BY created_at DESC LIMIT 1`,
        [user.id],
      );
      throw forbidden('This account is banned. You may submit an appeal.', {
        actionId: action?.id ?? null,
        appealToken: createAppealToken(user.id),
      });
    }

    if (user.locked_until && Number(user.locked_until) > Date.now()) {
      const minutes = Math.ceil((Number(user.locked_until) - Date.now()) / 60000);
      throw forbidden(`Account temporarily locked. Try again in ${minutes} minute(s).`);
    }

    let recoveryCodeUsed = false;
    if (user.totp_enabled) {
      if (!body.totp) {
        return res.status(200).json({ mfaRequired: true });
      }
      const totpValid = verifyTotp(user.totp_secret, body.totp);
      recoveryCodeUsed = !totpValid && (await consumeRecoveryCode(user.id, body.totp));
      if (!totpValid && !recoveryCodeUsed) {
        await audit({ action: 'auth.totp_failed', targetType: 'user', targetId: user.id, ip });
        throw unauthorized('Incorrect authentication code.');
      }
    }

    const settings = await getSettings();
    if (settings.require_2fa_for_admins && user.role === 'admin' && !user.totp_enabled) {
      // Let them in, but the client will force enrolment before anything else.
      await audit({ action: 'auth.admin_missing_2fa', targetType: 'user', targetId: user.id, ip });
    }

    const now = Date.now();
    await getDb().run(
      'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_seen_at = ? WHERE id = ?',
      [now, now, user.id],
    );
    await cache.del(accountKey);
    await invalidateUser(user.id);

    const userAgent = req.get('user-agent');
    const newLoginContext = await isNewLoginContext(user.id, ip, userAgent);
    const session = await createSession({
      userId: user.id,
      userAgent,
      ip,
    });
    setSessionCookie(res, session.token, session.expiresAt);
    setCsrfCookie(res, session.csrfSecret, session.expiresAt);

    await audit({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip });
    if (recoveryCodeUsed) {
      await audit({
        actorId: user.id,
        action: 'auth.recovery_code_used',
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      await recordSecurityEvent({
        userId: user.id,
        event: 'auth.recovery_code_used',
        severity: 'warning',
        ip,
        userAgent,
        notifyUser: true,
      });
    }
    if (newLoginContext) {
      await recordSecurityEvent({
        userId: user.id,
        event: 'auth.new_login',
        severity: 'info',
        ip,
        userAgent,
        notifyUser: true,
      });
    }

    const fresh = await findUserById(user.id);
    return res.json({
      user: toSelfUser(await withBadges(fresh)),
      csrfToken: csrfTokenFor(session.csrfSecret),
      settings: await getPublicSettings(),
      needsTotpEnrolment: settings.require_2fa_for_admins && user.role === 'admin' && !user.totp_enabled,
    });
  }),
);

/**
 * Equalises response time for unknown accounts: without this, "no such user"
 * returns far faster than "wrong password" and leaks which emails are real.
 */
let decoyHash = null;
async function burnTime() {
  decoyHash ??= await hashPassword(randomToken(24));
  await verifyPassword('timing-equalisation', decoyHash);
  return false;
}

authRouter.post(
  '/logout',
  asyncRoute(async (req, res) => {
    const token = req.cookies?.[config.cookieName];
    if (token) await revokeSessionByToken(token);
    if (req.user) {
      await audit({ actorId: req.user.id, action: 'auth.logout', ip: clientIp(req) });
    }
    clearAuthCookies(res);
    return res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    if (!req.user) return res.json({ user: null, settings: await getPublicSettings() });
    return res.json({
      user: toSelfUser(await withBadges(req.user)),
      csrfToken: req.session ? csrfTokenFor(req.session.csrfSecret) : undefined,
      settings: await getPublicSettings(),
      ice: iceServers(req.user.id),
      voice: {
        mode: config.livekit.url ? 'sfu' : 'mesh',
        livekitUrl: config.livekit.url || null,
      },
    });
  }),
);

authRouter.post(
  '/moderation-appeals',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        actionId: idSchema,
        reason: z.string().trim().min(10).max(2000),
        appealToken: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const token = body.appealToken ? verifyAppealToken(body.appealToken) : null;
    const userId = req.user?.id ?? token?.userId;
    if (!userId) throw unauthorized('A valid appeal token or session is required.');
    const appeal = await createAppeal({
      actionId: body.actionId,
      userId,
      reason: body.reason,
    });
    await audit({
      actorId: req.user?.id ?? null,
      action: 'moderation.appeal_created',
      targetType: 'appeal',
      targetId: appeal.id,
      meta: { userId, actionId: body.actionId },
      ip: clientIp(req),
    });
    return res.status(201).json({ appeal });
  }),
);

authRouter.get(
  '/moderation-appeals',
  requireAuth,
  asyncRoute(async (req, res) => {
    return res.json({ appeals: await listAppeals({ userId: req.user.id, limit: 100 }) });
  }),
);

export function iceServers(userId) {
  const servers = config.stunUrls.map((urls) => ({ urls }));
  if (config.turnUrl) {
    let username = config.turnUsername;
    let credential = config.turnPassword;
    if (config.turnSharedSecret) {
      username = `${Math.floor(Date.now() / 1000) + config.turnCredentialTtlSeconds}:${userId}`;
      credential = crypto
        .createHmac('sha1', config.turnSharedSecret)
        .update(username)
        .digest('base64');
    }
    servers.push({
      urls: config.turnUrl,
      username,
      credential,
    });
  }
  return servers;
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

authRouter.post(
  '/password',
  requireSession,
  asyncRoute(async (req, res) => {
    const body = parse(changePasswordSchema, req.body);

    const ok = await verifyPassword(body.currentPassword, req.user.password_hash);
    if (!ok) throw unauthorized('Current password is incorrect.');

    if (body.newPassword === body.currentPassword) {
      throw badRequest('New password must be different from the current one.');
    }
    const problems = passwordProblems(body.newPassword);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);

    await setPassword(req.user.id, body.newPassword);
    // Every other device is signed out; the current one stays.
    await revokeAllSessions(req.user.id, { exceptSessionId: req.session.id });
    await audit({
      actorId: req.user.id,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: req.user.id,
      ip: clientIp(req),
    });
    await recordSecurityEvent({
      userId: req.user.id,
      event: 'auth.password_changed',
      severity: 'warning',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      notifyUser: true,
    });

    const fresh = await findUserById(req.user.id);
    return res.json({ ok: true, user: toSelfUser(await withBadges(fresh)) });
  }),
);

authRouter.get(
  '/sessions',
  requireSession,
  asyncRoute(async (req, res) => {
    const sessions = await listSessions(req.user.id);
    return res.json({
      sessions: sessions.map((s) => ({ ...s, current: s.id === req.session.id })),
    });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireSession,
  asyncRoute(async (req, res) => {
    const owned = await getDb().get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!owned) throw forbidden('That session does not belong to you.');
    await revokeSession(req.params.id);
    await audit({
      actorId: req.user.id,
      action: 'auth.session_revoked',
      targetType: 'session',
      targetId: req.params.id,
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  }),
);

authRouter.post(
  '/sessions/revoke-others',
  requireSession,
  asyncRoute(async (req, res) => {
    const count = await revokeAllSessions(req.user.id, { exceptSessionId: req.session.id });
    await audit({ actorId: req.user.id, action: 'auth.revoke_other_sessions', meta: { count } });
    return res.json({ ok: true, revoked: count });
  }),
);

// ---------------------------------------------------------------- 2FA (TOTP)

authRouter.post(
  '/totp/setup',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.user.totp_enabled) throw badRequest('Two-factor authentication is already enabled.');
    const secret = generateSecret();
    // Held in cache, not the users table, until it is confirmed with a code.
    await cache.set(`totp:pending:${req.user.id}`, secret, 600);
    return res.json({
      secret,
      uri: otpauthUri({ secret, account: req.user.email, issuer: config.appName }),
    });
  }),
);

authRouter.post(
  '/totp/enable',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ token: z.string().trim().min(6).max(10) }), req.body);
    const secret = await cache.get(`totp:pending:${req.user.id}`);
    if (!secret) throw badRequest('Setup expired. Start again.');
    if (!verifyTotp(secret, body.token)) throw badRequest('That code is not valid.');

    await getDb().run('UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = ? WHERE id = ?', [
      secret,
      Date.now(),
      req.user.id,
    ]);
    await cache.del(`totp:pending:${req.user.id}`);
    await invalidateUser(req.user.id);
    const recoveryCodes = await replaceRecoveryCodes(req.user.id);
    await audit({ actorId: req.user.id, action: 'auth.totp_enabled', targetId: req.user.id });
    await recordSecurityEvent({
      userId: req.user.id,
      event: 'auth.mfa_changed',
      severity: 'warning',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      meta: { enabled: true },
      notifyUser: true,
    });

    const fresh = await findUserById(req.user.id);
    return res.json({
      ok: true,
      user: toSelfUser(await withBadges(fresh)),
      recoveryCodes,
    });
  }),
);

authRouter.post(
  '/totp/disable',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({ password: z.string().min(1).max(200), token: z.string().trim().max(10).optional() }),
      req.body,
    );
    if (!(await verifyPassword(body.password, req.user.password_hash))) {
      throw unauthorized('Password is incorrect.');
    }
    if (req.user.totp_enabled && !verifyTotp(req.user.totp_secret, body.token ?? '')) {
      throw badRequest('A valid authentication code is required.');
    }

    const settings = await getSettings();
    if (settings.require_2fa_for_admins && req.user.role === 'admin') {
      throw forbidden('Two-factor authentication is mandatory for administrators.');
    }

    await getDb().run(
      'UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?',
      [Date.now(), req.user.id],
    );
    await deleteRecoveryCodes(req.user.id);
    await invalidateUser(req.user.id);
    await audit({ actorId: req.user.id, action: 'auth.totp_disabled', targetId: req.user.id });
    await recordSecurityEvent({
      userId: req.user.id,
      event: 'auth.mfa_changed',
      severity: 'warning',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      meta: { enabled: false },
      notifyUser: true,
    });

    const fresh = await findUserById(req.user.id);
    return res.json({ ok: true, user: toSelfUser(await withBadges(fresh)) });
  }),
);

authRouter.get(
  '/totp/recovery-codes',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.user.totp_enabled) throw badRequest('Two-factor authentication is not enabled.');
    return res.json(await recoveryCodeStatus(req.user.id));
  }),
);

authRouter.post(
  '/totp/recovery-codes/regenerate',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        password: z.string().min(1).max(200),
        token: z.string().trim().min(6).max(10),
      }),
      req.body,
    );
    if (!(await verifyPassword(body.password, req.user.password_hash))) {
      throw unauthorized('Password is incorrect.');
    }
    if (!req.user.totp_enabled || !verifyTotp(req.user.totp_secret, body.token)) {
      throw badRequest('A valid authentication code is required.');
    }
    const recoveryCodes = await replaceRecoveryCodes(req.user.id);
    await audit({
      actorId: req.user.id,
      action: 'auth.recovery_codes_regenerated',
      targetType: 'user',
      targetId: req.user.id,
      ip: clientIp(req),
    });
    return res.json({ recoveryCodes });
  }),
);

authRouter.get(
  '/security-events',
  requireAuth,
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before: idSchema.optional(),
      }),
      req.query,
    );
    return res.json({ events: await listSecurityEvents(req.user.id, query) });
  }),
);

authRouter.post(
  '/security-events/:id/acknowledge',
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const result = await acknowledgeSecurityEvent(req.user.id, id);
    return res.json({ ok: result.changes > 0 });
  }),
);

// ------------------------------------------------------------------ profile

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(48).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().regex(/^\+?[0-9]{7,20}$/).nullable().optional(),
  firstName: z.string().trim().min(1).max(48).nullable().optional(),
  lastName: z.string().trim().min(1).max(48).nullable().optional(),
  nickname: z.string().trim().min(1).max(48).nullable().optional(),
  username: z.string().trim().toLowerCase().min(3).max(32)
    .regex(/^[a-z0-9._-]+$/).optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  customStatus: z.string().trim().max(80).nullable().optional(),
  bannerColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #5865f2.')
    .optional(),
  presence: z.enum(['online', 'idle', 'dnd', 'offline']).optional(),
  ttsButtonEnabled: z.boolean().optional(),
});

authRouter.post(
  '/avatar',
  requireAuth,
  uploadLimiter,
  memoryUpload.single('avatar'),
  asyncRoute(async (req, res) => {
    const attachment = await storeUpload({ file: req.file, uploaderId: req.user.id });
    if (!attachment.mime.startsWith('image/')) {
      await deleteAttachments([attachment]);
      throw badRequest('Profile pictures must be PNG, JPEG, GIF, WebP or BMP images.');
    }
    const avatarUrl = `/api/files/${attachment.id}`;
    const updated = await updateUser(req.user.id, { avatarUrl });
    return res.status(201).json({
      user: toSelfUser(await withBadges(updated)),
      avatarUrl,
    });
  }),
);

authRouter.patch(
  '/profile',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parse(profileSchema, req.body);
    const updated = await updateUser(req.user.id, body);
    return res.json({ user: toSelfUser(await withBadges(updated)) });
  }),
);
