import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import {
  parse,
  z,
  idSchema,
  emailSchema,
  usernameSchema,
  displayNameSchema,
  roleSchema,
} from '../lib/validate.js';
import { requireAuth, requireAdmin, clientIp } from '../middleware/auth.js';
import { adminLimiter } from '../middleware/rateLimit.js';
import {
  createUser,
  updateUser,
  deleteUser,
  setPassword,
  listUsersForAdmin,
  findUserById,
  toAdminUser,
  countAdmins,
  countUsers,
  withBadges,
} from '../services/users.js';
import { suggestPassword, passwordProblems } from '../lib/password.js';
import { revokeAllSessions, listSessions, purgeExpiredSessions } from '../services/sessions.js';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../services/settings.js';
import { audit, listAuditLogs, countAuditLogs, hideAuditLog, verifyAuditChain } from '../services/audit.js';
import { listAllGroups, deleteGroup, listChannels } from '../services/groups.js';
import { getDb, readReplicaMode } from '../db/index.js';
import { cacheMode } from '../cache/index.js';
import { emitToUser, getIo, emitToGroup } from '../realtime/index.js';
import { closeVoiceChannel } from '../realtime/voice.js';
import { purgeOrphanAttachments } from '../services/uploads.js';
import { config } from '../config.js';
import {
  BADGE_CATALOGUE,
  PRIMARY_BADGE_IDS,
  listBadgeIds,
  listBadges,
  setPrimaryBadges,
} from '../services/badges.js';
import { verifyLinkedAccount } from '../services/network.js';
import { deleteRecoveryCodes } from '../services/recoveryCodes.js';
import {
  assignCustomRole,
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  updateCustomRole,
} from '../services/roles.js';
import { enqueue } from '../jobs/queue.js';
import { getQueueStats, listQueueJobs, retryQueueJob } from '../jobs/queue.js';
import { storageHealth } from '../services/storage.js';
import { antivirusHealth } from '../services/antivirus.js';
import { searchHealth } from '../services/search.js';
import { runBackup, verifyBackup } from '../services/backups.js';
import {
  runtimeConfigurationView,
  updateRuntimeConfiguration,
} from '../services/runtimeConfiguration.js';
import { resetDeliveryTransport, verifySmtpConfiguration } from '../services/delivery.js';
import { resetEnterpriseAuthClients } from '../services/enterpriseAuth.js';
import { fishAudioStatus, listFishAudioModels } from '../services/fishAudio.js';

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireAdmin, adminLimiter);

// ------------------------------------------------------------------ summary

adminRouter.get(
  '/overview',
  asyncRoute(async (_req, res) => {
    const db = getDb();
    const [
      users,
      groups,
      messages,
      attachments,
      activeSessions,
      byRole,
      openReports,
      openDeadLetters,
    ] = await Promise.all([
      countUsers(),
      db.get('SELECT COUNT(*) AS count FROM chat_groups'),
      db.get('SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NULL'),
      db.get('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM attachments'),
      db.get('SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > ?', [
        Date.now(),
      ]),
      db.all('SELECT role, COUNT(*) AS count FROM users GROUP BY role'),
      db.get("SELECT COUNT(*) AS count FROM message_reports WHERE status IN ('open', 'reviewing')"),
      db.get("SELECT COUNT(*) AS count FROM notification_dead_letters WHERE status = 'open'"),
    ]);
    const memory = process.memoryUsage();

    return res.json({
      users,
      groups: Number(groups?.count ?? 0),
      messages: Number(messages?.count ?? 0),
      attachments: Number(attachments?.count ?? 0),
      attachmentBytes: Number(attachments?.bytes ?? 0),
      activeSessions: Number(activeSessions?.count ?? 0),
      openReports: Number(openReports?.count ?? 0),
      openDeadLetters: Number(openDeadLetters?.count ?? 0),
      roles: Object.fromEntries(byRole.map((row) => [row.role, Number(row.count)])),
      runtime: {
        database: db.dialect,
        readDatabase: readReplicaMode(),
        cache: cacheMode(),
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        appName: config.appName,
        region: config.deploymentRegion,
        role: config.deploymentRole,
        writes: config.allowWrites,
        pid: process.pid,
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
        },
        sockets: getIo()?.engine?.clientsCount ?? 0,
      },
    });
  }),
);

adminRouter.get(
  '/operations',
  asyncRoute(async (_req, res) => {
    const db = getDb();
    const startedAt = Date.now();
    let database = { ok: false, dialect: db.dialect, latencyMs: null };
    try {
      const before = Date.now();
      await db.get('SELECT 1 AS ok');
      database = { ok: true, dialect: db.dialect, latencyMs: Date.now() - before };
    } catch (error) {
      database.error = error.message;
    }
    const [storage, antivirus, search, queue, tableSizes] = await Promise.all([
      storageHealth().catch((error) => ({ driver: config.storageDriver, ok: false, error: error.message })),
      antivirusHealth(),
      searchHealth(),
      getQueueStats().catch((error) => ({ enabled: true, ok: false, error: error.message })),
      Promise.all(
        ['users', 'messages', 'attachments', 'audit_logs', 'notifications'].map(async (table) => {
          const row = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
          return [table, Number(row?.count ?? 0)];
        }),
      ),
    ]);
    const cache = {
      ok: !config.requireRedis || cacheMode() === 'redis',
      mode: cacheMode(),
      required: config.requireRedis,
    };
    const readiness = [database, cache, storage, antivirus, search]
      .filter((service) => service.configured !== false)
      .every((service) => service.ok !== false);
    return res.json({
      ok: readiness,
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      deployment: {
        region: config.deploymentRegion,
        role: config.deploymentRole,
        writes: config.allowWrites,
      },
      services: { database, cache, storage, antivirus, search, queue },
      records: Object.fromEntries(tableSizes),
      features: {
        sso: Boolean(config.oidc.issuer || config.saml.entryPoint || config.ldap.url),
        smtp: Boolean(config.smtp.host),
        push: Boolean(config.vapid.publicKey && config.vapid.privateKey),
        livekit: Boolean(config.livekit.url),
        egress: config.livekit.egressEnabled,
        turn: Boolean(config.turnUrl),
        tracing: Boolean(config.otelEndpoint),
        metrics: Boolean(config.metricsToken),
        dlp: config.dlpMode,
      },
    });
  }),
);

adminRouter.get(
  '/platform',
  asyncRoute(async (_req, res) => {
    const db = getDb();
    const [backups, storage, queueJobs, quota, files, smtp] = await Promise.all([
      db.all(`SELECT id, provider, status, location, checksum, bytes, started_at, finished_at, error
              FROM backup_runs ORDER BY started_at DESC LIMIT 100`),
      storageHealth().catch((error) => ({ driver: config.storageDriver, ok: false, error: error.message })),
      listQueueJobs({ limit: 100 }),
      db.get('SELECT COALESCE(SUM(limit_bytes), 0) AS capacity, COALESCE(SUM(used_bytes), 0) AS used, COALESCE(SUM(reserved_bytes), 0) AS reserved FROM storage_quotas'),
      db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes,
             COALESCE(SUM(CASE WHEN quarantined_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS quarantined
             FROM attachments`),
      verifySmtpConfiguration(),
    ]);
    return res.json({
      configuration: runtimeConfigurationView(),
      providers: {
        oidc: { configured: Boolean(config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret) },
        saml: { configured: Boolean(config.saml.entryPoint && config.saml.issuer && config.saml.idpCert) },
        ldap: { configured: Boolean(config.ldap.url && config.ldap.bindDn && config.ldap.searchBase) },
        smtp,
        fishAudio: fishAudioStatus(),
      },
      backups: backups.map((row) => ({
        id: row.id, provider: row.provider, status: row.status, location: row.location,
        checksum: row.checksum, bytes: Number(row.bytes ?? 0), startedAt: Number(row.started_at),
        finishedAt: row.finished_at ? Number(row.finished_at) : null, error: row.error,
      })),
      storage: {
        ...storage,
        count: Number(files?.count ?? 0), bytes: Number(files?.bytes ?? 0),
        quarantined: Number(files?.quarantined ?? 0),
        quotaCapacity: Number(quota?.capacity ?? 0), quotaUsed: Number(quota?.used ?? 0),
        quotaReserved: Number(quota?.reserved ?? 0), cdn: Boolean(config.cdnBaseUrl),
        bucket: config.storageDriver === 's3' ? config.s3.bucket : null,
      },
      queue: { ...(await getQueueStats()), jobs: queueJobs },
      retentionDays: config.backupRetentionDays,
    });
  }),
);

adminRouter.patch(
  '/platform/configuration',
  asyncRoute(async (req, res) => {
    const body = parse(z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.boolean(), z.array(z.string().max(255)).max(100)])), req.body);
    const configuration = await updateRuntimeConfiguration(body, req.user.id);
    resetDeliveryTransport();
    resetEnterpriseAuthClients();
    getIo()?.emit('settings:updated', { fish_tts_enabled: fishAudioStatus().configured });
    await audit({ actorId: req.user.id, action: 'admin.runtime_configuration_updated',
      meta: { keys: Object.keys(body).map((key) => key.toLowerCase().includes('secret') || key.toLowerCase().includes('apikey') || key.endsWith('.pass') ? `${key}:updated` : key) } });
    return res.json({ configuration });
  }),
);

adminRouter.get(
  '/platform/fish-audio/models',
  asyncRoute(async (req, res) => {
    const models = await listFishAudioModels();
    await audit({ actorId: req.user.id, action: 'admin.fish_audio_models_loaded', meta: { count: models.length }, ip: clientIp(req) });
    return res.json({ models, status: fishAudioStatus() });
  }),
);

adminRouter.post(
  '/platform/smtp/test',
  asyncRoute(async (req, res) => {
    const result = await verifySmtpConfiguration();
    await audit({ actorId: req.user.id, action: 'admin.smtp_tested', meta: { ok: result.ok } });
    return res.status(result.ok ? 200 : 422).json(result);
  }),
);

adminRouter.post(
  '/backups',
  asyncRoute(async (req, res) => {
    const job = await enqueue('backup.run', {}, { jobId: `manual-backup-${Date.now()}` });
    const result = job ? { queued: true, jobId: String(job.id) } : { queued: false, backup: await runBackup() };
    await audit({ actorId: req.user.id, action: 'admin.backup_requested', meta: result });
    return res.status(202).json(result);
  }),
);

adminRouter.post(
  '/backups/:id/verify',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const backup = await getDb().get("SELECT location FROM backup_runs WHERE id = ? AND status = 'completed'", [id]);
    if (!backup?.location) throw notFound('Completed backup not found.');
    const result = await verifyBackup(backup.location);
    await audit({ actorId: req.user.id, action: 'admin.backup_verified', targetType: 'backup', targetId: id });
    return res.json(result);
  }),
);

adminRouter.post(
  '/queue/:id/retry',
  asyncRoute(async (req, res) => {
    const id = parse(z.string().min(1).max(200), req.params.id);
    if (!(await retryQueueJob(id))) throw notFound('Queue job not found.');
    await audit({ actorId: req.user.id, action: 'admin.queue_job_retried', targetType: 'job', targetId: id });
    return res.json({ ok: true });
  }),
);

adminRouter.get(
  '/analytics',
  asyncRoute(async (req, res) => {
    const { hours } = parse(z.object({ hours: z.coerce.number().int().min(6).max(168).default(24) }), req.query);
    const now = Date.now();
    const step = 60 * 60 * 1000;
    const start = now - hours * step;
    const db = getDb();
    const [messages, users, audits, reports] = await Promise.all([
      db.all('SELECT created_at FROM messages WHERE created_at >= ?', [start]),
      db.all('SELECT created_at FROM users WHERE created_at >= ?', [start]),
      db.all('SELECT created_at FROM audit_logs WHERE created_at >= ?', [start]),
      db.all('SELECT created_at FROM message_reports WHERE created_at >= ?', [start]),
    ]);
    const series = Array.from({ length: hours }, (_, index) => ({
      at: start + index * step, messages: 0, users: 0, audits: 0, reports: 0,
    }));
    for (const [key, rows] of Object.entries({ messages, users, audits, reports })) {
      for (const row of rows) {
        const index = Math.floor((Number(row.created_at) - start) / step);
        if (series[index]) series[index][key] += 1;
      }
    }
    return res.json({ hours, series });
  }),
);

// -------------------------------------------------------------------- users

adminRouter.get(
  '/users',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        search: z.string().trim().max(64).optional().default(''),
        role: roleSchema.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    return res.json(await listUsersForAdmin(query));
  }),
);

adminRouter.get(
  '/roles',
  asyncRoute(async (_req, res) => res.json({ roles: await listCustomRoles() })),
);

adminRouter.post(
  '/roles',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(48),
        description: z.string().trim().max(300).nullable().optional(),
        capabilities: z.array(z.enum(['admin', 'moderate', 'debug', 'stream'])).max(4),
      }),
      req.body,
    );
    const role = await createCustomRole({ ...body, actorId: req.user.id });
    await audit({ actorId: req.user.id, action: 'admin.role_created', targetId: role.id });
    return res.status(201).json({ role });
  }),
);

adminRouter.patch(
  '/roles/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(48).optional(),
        description: z.string().trim().max(300).nullable().optional(),
        capabilities: z.array(z.enum(['admin', 'moderate', 'debug', 'stream'])).max(4).optional(),
      }),
      req.body,
    );
    const role = await updateCustomRole(id, body);
    await audit({ actorId: req.user.id, action: 'admin.role_updated', targetId: id, meta: body });
    return res.json({ role });
  }),
);

adminRouter.delete(
  '/roles/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    await deleteCustomRole(id);
    await audit({ actorId: req.user.id, action: 'admin.role_deleted', targetId: id });
    return res.json({ ok: true });
  }),
);

adminRouter.patch(
  '/groups/:id/discovery',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(z.object({ approved: z.boolean() }), req.body);
    const group = await getDb().get('SELECT * FROM chat_groups WHERE id = ?', [id]);
    if (!group) throw notFound('Group not found.');
    await getDb().run(
      `UPDATE chat_groups SET discovery_requested = 0, discoverable = ?,
       discovery_verified_by = ?, discovery_verified_at = ?, updated_at = ? WHERE id = ?`,
      [body.approved ? 1 : 0, body.approved ? req.user.id : null,
       body.approved ? Date.now() : null, Date.now(), id],
    );
    await audit({ actorId: req.user.id, action: body.approved ? 'group.discovery_approved' : 'group.discovery_rejected',
      targetType: 'group', targetId: id, ip: clientIp(req) });
    return res.json({ ok: true });
  }),
);

adminRouter.put(
  '/users/:userId/roles/:roleId',
  asyncRoute(async (req, res) => {
    const userId = parse(idSchema, req.params.userId);
    const roleId = parse(idSchema, req.params.roleId);
    const { granted } = parse(z.object({ granted: z.boolean() }), req.body);
    await assignCustomRole({ userId, roleId, actorId: req.user.id, granted });
    await audit({
      actorId: req.user.id,
      action: 'admin.user_role_changed',
      targetType: 'user',
      targetId: userId,
      meta: { roleId, granted },
    });
    return res.json({ ok: true });
  }),
);

adminRouter.get(
  '/users/:userId/roles',
  asyncRoute(async (req, res) => {
    const userId = parse(idSchema, req.params.userId);
    if (!(await findUserById(userId))) throw notFound('User not found.');
    const rows = await getDb().all(
      `SELECT r.id, r.name, r.description,
              CASE WHEN ur.user_id IS NULL THEN 0 ELSE 1 END AS granted
       FROM custom_roles r
       LEFT JOIN user_custom_roles ur ON ur.role_id = r.id AND ur.user_id = ?
       ORDER BY LOWER(r.name)`,
      [userId],
    );
    return res.json({
      roles: rows.map((row) => ({ ...row, granted: Boolean(row.granted) })),
    });
  }),
);

adminRouter.get(
  '/users/suggest-password',
  asyncRoute(async (_req, res) => res.json({ password: suggestPassword() })),
);

const createUserSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  password: z.string().min(1).max(200),
  role: roleSchema.default('member'),
  bio: z.string().trim().max(300).nullable().optional(),
  mustChangePassword: z.boolean().default(true),
});

/**
 * The only account-creation path in the product. There is no public signup —
 * an administrator provisions every account here.
 */
adminRouter.post(
  '/users',
  asyncRoute(async (req, res) => {
    const body = parse(createUserSchema, req.body);

    const problems = passwordProblems(body.password);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);

    const user = await createUser({
      ...body,
      createdBy: req.user.id,
    });

    await audit({
      actorId: req.user.id,
      action: 'admin.user_created',
      targetType: 'user',
      targetId: user.id,
      meta: { username: user.username, role: user.role },
      ip: clientIp(req),
    });

    return res.status(201).json({ user: toAdminUser(await withBadges(user)) });
  }),
);

const updateUserSchema = z.object({
  email: emailSchema.optional(),
  username: usernameSchema.optional(),
  displayName: displayNameSchema.optional(),
  role: roleSchema.optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(updateUserSchema, req.body);

    const target = await findUserById(id);
    if (!target) throw notFound('User not found.');

    // Guard rails so the platform can never be locked out of itself.
    if (target.role === 'admin' && (body.role && body.role !== 'admin')) {
      if ((await countAdmins()) <= 1) throw badRequest('This is the last administrator.');
    }
    if (target.role === 'admin' && body.isActive === false) {
      if ((await countAdmins()) <= 1) throw badRequest('This is the last administrator.');
    }
    if (id === req.user.id && body.role && body.role !== 'admin') {
      throw badRequest('You cannot demote your own account.');
    }
    if (id === req.user.id && body.isActive === false) {
      throw badRequest('You cannot disable your own account.');
    }

    const patch = { ...body };
    delete patch.role;
    await updateUser(id, patch);
    if (body.role) {
      const currentPrimary = (await listBadgeIds(id)).filter((badgeId) =>
        PRIMARY_BADGE_IDS.includes(badgeId),
      );
      const cosmetic = currentPrimary.filter((badgeId) => !['admin', 'streamer'].includes(badgeId));
      const capability =
        body.role === 'admin' ? ['admin'] : body.role === 'youtuber' ? ['streamer'] : [];
      await setPrimaryBadges({
        userId: id,
        badgeIds: [...cosmetic, ...capability],
        grantedBy: req.user.id,
      });
    }
    const user = await findUserById(id);

    // Disabling an account must take effect immediately, everywhere.
    if (body.isActive === false) {
      await revokeAllSessions(id);
      emitToUser(id, 'session:revoked', { reason: 'account_disabled' });
      const io = getIo();
      if (io) {
        const sockets = await io.in(`user:${id}`).fetchSockets();
        for (const socket of sockets) socket.disconnect(true);
      }
    }

    await audit({
      actorId: req.user.id,
      action: 'admin.user_updated',
      targetType: 'user',
      targetId: id,
      meta: body,
      ip: clientIp(req),
    });

    return res.json({ user: toAdminUser(await withBadges(user)) });
  }),
);

adminRouter.get('/badges', (_req, res) => {
  return res.json({ badges: BADGE_CATALOGUE });
});

adminRouter.put(
  '/users/:id/badges',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { badgeIds } = parse(
      z.object({
        badgeIds: z.array(z.enum(PRIMARY_BADGE_IDS)).max(PRIMARY_BADGE_IDS.length),
      }),
      req.body,
    );
    const target = await findUserById(id);
    if (!target) throw notFound('User not found.');
    if (id === req.user.id && !badgeIds.includes('admin')) {
      throw badRequest('You cannot remove your own administrator badge.');
    }
    const badges = await setPrimaryBadges({
      userId: id,
      badgeIds,
      grantedBy: req.user.id,
    });
    await audit({
      actorId: req.user.id,
      action: 'admin.badges_updated',
      targetType: 'user',
      targetId: id,
      meta: { badgeIds },
      ip: clientIp(req),
    });
    return res.json({ badges, user: toAdminUser(await withBadges(await findUserById(id))) });
  }),
);

adminRouter.patch(
  '/linked-accounts/:id/verification',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { verified } = parse(z.object({ verified: z.boolean() }), req.body);
    const linkedAccount = await verifyLinkedAccount(id, req.user.id, verified);
    await audit({
      actorId: req.user.id,
      action: verified ? 'admin.link_verified' : 'admin.link_unverified',
      targetType: 'linked_account',
      targetId: id,
      ip: clientIp(req),
    });
    return res.json({ linkedAccount });
  }),
);

adminRouter.post(
  '/users/:id/password',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(
      z.object({
        password: z.string().min(1).max(200),
        mustChange: z.boolean().default(true),
        revokeSessions: z.boolean().default(true),
      }),
      req.body,
    );

    const target = await findUserById(id);
    if (!target) throw notFound('User not found.');

    const problems = passwordProblems(body.password);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);

    await setPassword(id, body.password, { mustChange: body.mustChange });
    if (body.revokeSessions) {
      await revokeAllSessions(id, { exceptSessionId: id === req.user.id ? req.session.id : null });
      emitToUser(id, 'session:revoked', { reason: 'password_reset' });
    }

    await audit({
      actorId: req.user.id,
      action: 'admin.password_reset',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  }),
);

adminRouter.post(
  '/users/:id/unlock',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    await getDb().run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [id]);
    await audit({
      actorId: req.user.id,
      action: 'admin.user_unlocked',
      targetType: 'user',
      targetId: id,
    });
    return res.json({ ok: true });
  }),
);

adminRouter.post(
  '/users/:id/disable-2fa',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    await getDb().run(
      'UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?',
      [Date.now(), id],
    );
    await deleteRecoveryCodes(id);
    await audit({
      actorId: req.user.id,
      action: 'admin.2fa_reset',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  }),
);

adminRouter.get(
  '/users/:id/sessions',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    return res.json({ sessions: await listSessions(id) });
  }),
);

adminRouter.post(
  '/users/:id/logout',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const count = await revokeAllSessions(id);
    emitToUser(id, 'session:revoked', { reason: 'admin_logout' });
    const io = getIo();
    if (io) {
      const sockets = await io.in(`user:${id}`).fetchSockets();
      for (const socket of sockets) socket.disconnect(true);
    }
    await audit({
      actorId: req.user.id,
      action: 'admin.force_logout',
      targetType: 'user',
      targetId: id,
      meta: { count },
      ip: clientIp(req),
    });
    return res.json({ ok: true, revoked: count });
  }),
);

adminRouter.delete(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    if (id === req.user.id) throw badRequest('You cannot delete your own account.');

    const target = await findUserById(id);
    if (!target) throw notFound('User not found.');
    if (target.role === 'admin' && (await countAdmins()) <= 1) {
      throw badRequest('This is the last administrator.');
    }

    // Groups they own would be orphaned, so those go too — say so plainly in
    // the response and the audit trail.
    const owned = await getDb().all('SELECT id, name FROM chat_groups WHERE owner_id = ?', [id]);
    for (const group of owned) {
      const channels = await listChannels(group.id);
      await deleteGroup(group.id);
      for (const channel of channels) closeVoiceChannel(channel.id, getIo());
      emitToGroup(group.id, 'group:deleted', { groupId: group.id });
    }

    await deleteUser(id);

    emitToUser(id, 'session:revoked', { reason: 'account_deleted' });
    const io = getIo();
    if (io) {
      const sockets = await io.in(`user:${id}`).fetchSockets();
      for (const socket of sockets) socket.disconnect(true);
    }

    await audit({
      actorId: req.user.id,
      action: 'admin.user_deleted',
      targetType: 'user',
      targetId: id,
      meta: { username: target.username, deletedGroups: owned.map((g) => g.name) },
      ip: clientIp(req),
    });

    return res.json({ ok: true, deletedGroups: owned.length });
  }),
);

// ------------------------------------------------------------------- groups

adminRouter.get(
  '/groups',
  asyncRoute(async (_req, res) => {
    return res.json({ groups: await listAllGroups({}) });
  }),
);

adminRouter.delete(
  '/groups/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const group = await getDb().get('SELECT * FROM chat_groups WHERE id = ?', [id]);
    if (!group) throw notFound('Group not found.');

    const channels = await listChannels(id);
    await deleteGroup(id);
    for (const channel of channels) closeVoiceChannel(channel.id, getIo());
    emitToGroup(id, 'group:deleted', { groupId: id });

    await audit({
      actorId: req.user.id,
      action: 'admin.group_deleted',
      targetType: 'group',
      targetId: id,
      meta: { name: group.name },
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  }),
);

// ----------------------------------------------------------------- settings

adminRouter.get(
  '/settings',
  asyncRoute(async (_req, res) => {
    return res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS });
  }),
);

const settingsSchema = z.object({
  app_name: z.string().trim().min(1).max(48).optional(),
  app_logo_url: z.string().trim().max(500).optional(),
  registration_enabled: z.boolean().optional(),
  login_title: z.string().trim().min(1).max(100).optional(),
  login_subtitle: z.string().trim().max(280).optional(),
  login_footer_text: z.string().trim().max(280).optional(),
  signup_title: z.string().trim().min(1).max(100).optional(),
  signup_subtitle: z.string().trim().max(280).optional(),
  uploads_enabled: z.boolean().optional(),
  upload_limit_enabled: z.boolean().optional(),
  max_upload_mb: z.coerce.number().int().min(1).max(100).optional(),
  allow_image_uploads: z.boolean().optional(),
  allow_video_uploads: z.boolean().optional(),
  allow_audio_uploads: z.boolean().optional(),
  allow_document_uploads: z.boolean().optional(),
  allow_dms: z.boolean().optional(),
  allow_group_dms: z.boolean().optional(),
  youtubers_can_create_groups: z.boolean().optional(),
  members_can_create_groups: z.boolean().optional(),
  message_edit_window_minutes: z.coerce.number().int().min(0).max(1440).optional(),
  spam_messages_per_30s: z.coerce.number().int().min(2).max(50).optional(),
  blocked_terms: z.string().trim().max(2000).optional(),
  require_2fa_for_admins: z.boolean().optional(),
  feature_e2ee: z.boolean().optional(),
  e2ee_required_for_dms: z.boolean().optional(),
  feature_pwa: z.boolean().optional(),
  feature_webhooks: z.boolean().optional(),
  feature_api_keys: z.boolean().optional(),
  feature_voice_calls: z.boolean().optional(),
  feature_push_notifications: z.boolean().optional(),
  motd: z.string().trim().max(280).optional(),
});

adminRouter.patch(
  '/settings',
  asyncRoute(async (req, res) => {
    const body = parse(settingsSchema, req.body);
    if (!Object.keys(body).length) throw badRequest('Nothing to update.');

    // Product policy can be disabled, while config.maxUploadBytes remains an
    // infrastructure safety boundary for memory-backed scanning.
    const settings = await updateSettings(body);
    getIo()?.emit('settings:updated', body);

    await audit({
      actorId: req.user.id,
      action: 'admin.settings_updated',
      meta: body,
      ip: clientIp(req),
    });
    return res.json({ settings });
  }),
);

// ---------------------------------------------------------------- audit log

adminRouter.get(
  '/audit',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(10).max(100).default(25),
        before: idSchema.optional(),
        action: z.string().trim().max(48).optional(),
        actorId: idSchema.optional(),
        search: z.string().trim().max(120).optional(),
      }),
      req.query,
    );
    const pageSize = req.query.pageSize ? query.pageSize : query.limit;
    const filters = { action: query.action, actorId: query.actorId, search: query.search };
    const [logs, total] = await Promise.all([
      listAuditLogs({ ...filters, before: query.before, limit: pageSize, offset: query.before ? 0 : (query.page - 1) * pageSize }),
      countAuditLogs(filters),
    ]);
    return res.json({ logs, pagination: { page: query.page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
  }),
);

adminRouter.delete(
  '/audit/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(z.object({ reason: z.string().trim().max(280).optional().nullable() }), req.body ?? {});
    const hidden = await hideAuditLog({ id, actorId: req.user.id, reason: body.reason ?? null });
    if (!hidden) throw notFound('Audit entry not found.');
    await audit({ actorId: req.user.id, action: 'admin.audit_entry_hidden', targetType: 'audit_log', targetId: id, meta: { action: hidden.action, reason: body.reason ?? null }, ip: clientIp(req) });
    return res.json({ ok: true });
  }),
);

adminRouter.get(
  '/audit/verify',
  asyncRoute(async (req, res) => {
    const integrity = await verifyAuditChain();
    await audit({
      actorId: req.user.id,
      action: 'admin.audit_verified',
      meta: integrity,
      ip: clientIp(req),
    });
    return res.status(integrity.valid ? 200 : 409).json({ integrity });
  }),
);

adminRouter.get(
  '/audit/export',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(10_000).default(10_000),
        action: z.string().trim().max(48).optional(),
        actorId: idSchema.optional(),
      }),
      req.query,
    );
    const logs = await listAuditLogs(query);
    const columns = [
      'id',
      'createdAt',
      'action',
      'actorId',
      'actorUsername',
      'targetType',
      'targetId',
      'ip',
      'integrityProtected',
      'meta',
    ];
    const csv = [
      columns.join(','),
      ...logs.map((log) =>
        columns
          .map((key) =>
            csvCell(key === 'meta' ? JSON.stringify(log.meta ?? null) : log[key]),
          )
          .join(','),
      ),
    ].join('\n');
    await audit({
      actorId: req.user.id,
      action: 'admin.audit_exported',
      meta: { rows: logs.length },
      ip: clientIp(req),
    });
    res.set({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    });
    return res.send(`\uFEFF${csv}`);
  }),
);

adminRouter.post(
  '/notification-dlq/:deadLetterId/retry',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.deadLetterId);
    const row = await getDb().get(
      "SELECT * FROM notification_dead_letters WHERE id = ? AND status = 'open'",
      [id],
    );
    if (!row) throw notFound('Dead letter not found.');
    const payload = JSON.parse(row.payload);
    await enqueue(row.job_type, payload);
    await getDb().run(
      `UPDATE notification_dead_letters
       SET status = 'retried', resolved_at = ?, resolved_by = ? WHERE id = ?`,
      [Date.now(), req.user.id, id],
    );
    await audit({
      actorId: req.user.id,
      action: 'notification.dead_letter_retried',
      targetType: 'dead_letter',
      targetId: id,
    });
    return res.json({ ok: true });
  }),
);

adminRouter.get(
  '/notification-dlq',
  asyncRoute(async (_req, res) => {
    const rows = await getDb().all(
      `SELECT id, job_type, job_id, error, attempts, status,
              first_failed_at, last_failed_at, resolved_at
       FROM notification_dead_letters ORDER BY last_failed_at DESC LIMIT 500`,
    );
    return res.json({
      deadLetters: rows.map((row) => ({
        id: row.id,
        jobType: row.job_type,
        jobId: row.job_id,
        error: row.error,
        attempts: Number(row.attempts),
        status: row.status,
        firstFailedAt: Number(row.first_failed_at),
        lastFailedAt: Number(row.last_failed_at),
        resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
      })),
    });
  }),
);

adminRouter.post(
  '/maintenance/purge',
  asyncRoute(async (req, res) => {
    const sessions = await purgeExpiredSessions();
    const attachments = await purgeOrphanAttachments();
    await audit({
      actorId: req.user.id,
      action: 'admin.maintenance_purge',
      meta: { sessions, attachments },
    });
    return res.json({ ok: true, sessions, attachments });
  }),
);

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
