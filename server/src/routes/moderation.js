import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { can, CAPABILITIES } from '../services/capabilities.js';
import { findUserById } from '../services/users.js';
import {
  listReports,
  listUserReports,
  moderateUser,
  updateReport,
  updateUserReport,
  listAppeals,
  decideAppeal,
} from '../services/moderation.js';
import { revokeAllSessions } from '../services/sessions.js';
import { audit } from '../services/audit.js';
import { emitToUser, getIo } from '../realtime/index.js';
import { notify } from '../services/notifications.js';
import { moderationActions } from '../services/metrics.js';

export const moderationRouter = express.Router();
moderationRouter.use(requireAuth);
moderationRouter.use(
  asyncRoute(async (req, _res, next) => {
    if (!(await can(req.user, CAPABILITIES.MODERATE))) {
      throw forbidden('The moderation capability is required.');
    }
    return next();
  }),
);

moderationRouter.get(
  '/reports',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']).nullable().optional(),
        search: z.string().trim().max(80).default(''),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    return res.json({ reports: await listReports(query) });
  }),
);

moderationRouter.get(
  '/appeals',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        status: z.enum(['open', 'approved', 'denied']).nullable().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    return res.json({ appeals: await listAppeals(query) });
  }),
);

moderationRouter.get(
  '/user-reports',
  asyncRoute(async (req, res) => {
    const query = parse(z.object({
      status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']).nullable().optional(),
      search: z.string().trim().max(80).default(''),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }), req.query);
    return res.json({ reports: await listUserReports(query) });
  }),
);

moderationRouter.patch(
  '/appeals/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(
      z.object({
        status: z.enum(['approved', 'denied']),
        decision: z.string().trim().min(3).max(2000),
      }),
      req.body,
    );
    const appeal = await decideAppeal({
      id,
      reviewerId: req.user.id,
      ...body,
    });
    await audit({
      actorId: req.user.id,
      action: `moderation.appeal_${body.status}`,
      targetType: 'appeal',
      targetId: id,
      meta: { decision: body.decision },
      ip: clientIp(req),
    });
    await notify({
      userId: appeal.user_id,
      type: 'moderation',
      title: `Appeal ${body.status}`,
      body: body.decision,
      data: { appealId: id, status: body.status },
    }).catch(() => {});
    return res.json({ appeal });
  }),
);

moderationRouter.patch(
  '/reports/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(
      z.object({
        status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']).optional(),
        assignedToMe: z.boolean().optional(),
        resolution: z.string().trim().max(1000).nullable().optional(),
      }),
      req.body,
    );
    const report = await updateReport(id, {
      status: body.status,
      assignedTo: body.assignedToMe === undefined
        ? undefined
        : body.assignedToMe
          ? req.user.id
          : null,
      resolution: body.resolution,
    });
    await audit({
      actorId: req.user.id,
      action: 'moderation.report_updated',
      targetType: 'report',
      targetId: id,
      meta: body,
      ip: clientIp(req),
    });
    return res.json({ report });
  }),
);

moderationRouter.patch(
  '/user-reports/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(z.object({
      status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']).optional(),
      assignedToMe: z.boolean().optional(),
      resolution: z.string().trim().max(1000).nullable().optional(),
    }), req.body);
    const report = await updateUserReport(id, {
      status: body.status,
      assignedTo: body.assignedToMe === undefined ? undefined : body.assignedToMe ? req.user.id : null,
      resolution: body.resolution,
    });
    await audit({ actorId: req.user.id, action: 'moderation.user_report_updated', targetType: 'user_report', targetId: id, meta: body, ip: clientIp(req) });
    return res.json({ report });
  }),
);

moderationRouter.post(
  '/users/:id/actions',
  asyncRoute(async (req, res) => {
    const targetUserId = parse(idSchema, req.params.id);
    const body = parse(
      z.object({
        action: z.enum([
          'timeout',
          'untimeout',
          'ban',
          'unban',
          'shadowban',
          'unshadow',
          'slow',
          'unslow',
        ]),
        reason: z.string().trim().min(3).max(500),
        durationMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30).nullable().optional(),
        intervalSeconds: z.coerce.number().int().min(2).max(3600).nullable().optional(),
      }),
      req.body,
    );
    if (targetUserId === req.user.id) throw badRequest('You cannot moderate your own account.');
    if (['timeout', 'slow'].includes(body.action) && !body.durationMinutes) {
      throw badRequest('A timeout duration is required.');
    }
    if (body.action === 'slow' && !body.intervalSeconds) {
      throw badRequest('A send interval is required.');
    }
    const target = await findUserById(targetUserId);
    if (!target) throw notFound('User not found.');
    if (target.role === 'admin' && !(await can(req.user, CAPABILITIES.ADMIN))) {
      throw forbidden('Only an administrator can moderate another administrator.');
    }

    const result = await moderateUser({
      targetUserId,
      actorId: req.user.id,
      ...body,
    });
    moderationActions.inc({ action: body.action });
    if (body.action === 'ban') {
      await revokeAllSessions(targetUserId);
      emitToUser(targetUserId, 'session:revoked', { reason: 'account_banned' });
      const sockets = await getIo()?.in(`user:${targetUserId}`).fetchSockets();
      for (const socket of sockets ?? []) socket.disconnect(true);
    }
    await notify({
      userId: targetUserId,
      type: 'moderation',
      title: `Account ${body.action}`,
      body: body.reason,
      data: {
        actionId: result.actionId,
        action: body.action,
        expiresAt: result.expiresAt,
      },
    }).catch(() => {});
    await audit({
      actorId: req.user.id,
      action: `moderation.${body.action}`,
      targetType: 'user',
      targetId: targetUserId,
      meta: { reason: body.reason, expiresAt: result.expiresAt },
      ip: clientIp(req),
    });
    return res.json({ ok: true, ...result });
  }),
);
