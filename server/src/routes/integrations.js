import crypto from 'node:crypto';
import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound, unauthorized, conflict } from '../lib/errors.js';
import { parse, z, idSchema, messageContentSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  createBot,
  listBots,
  disableBot,
  createWebhook,
  getWebhook,
  listWebhooks,
  deleteWebhook,
  assertSafeWebhookEndpoint,
  dispatchWebhookEvent,
  recordSyncEvent,
} from '../services/integrations.js';
import { getDb } from '../db/index.js';
import { getChannel, invalidateGroup } from '../services/groups.js';
import { groupContext, canAccessChannel, isConversationMember } from '../services/permissions.js';
import { createMessage, hydrateMessage } from '../services/messages.js';
import { inspectDlp } from '../services/dlp.js';
import { audit } from '../services/audit.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { channelPermission } from '../services/channelPermissions.js';
import { emitToChannel, emitToGroup, refreshUserRooms } from '../realtime/index.js';
import { enqueue } from '../jobs/queue.js';
import {
  normalizeServerPermissions,
  SERVER_PERMISSION_KEYS,
} from '../services/serverRoles.js';

export const integrationsRouter = express.Router();

const OAUTH_SCOPES = new Set(['read', 'write']);
const oauthDigest = (value) =>
  crypto.createHmac('sha256', config.secret).update(String(value)).digest('base64url');

integrationsRouter.post(
  '/oauth/token',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        grant_type: z.literal('authorization_code'),
        code: z.string().min(20).max(200),
        client_id: z.string().min(8).max(100),
        client_secret: z.string().min(20).max(200),
        redirect_uri: z.string().url().max(2000),
      }),
      req.body,
    );
    const app = await getDb().get(
      'SELECT * FROM oauth_apps WHERE client_id = ? AND active = 1',
      [body.client_id],
    );
    if (!app || app.client_secret_hash !== oauthDigest(body.client_secret)) {
      throw unauthorized('Invalid OAuth client credentials.');
    }
    const code = await getDb().get(
      `SELECT * FROM oauth_authorization_codes
       WHERE code_hash = ? AND app_id = ? AND redirect_uri = ?
         AND used_at IS NULL AND expires_at > ?`,
      [oauthDigest(body.code), app.id, body.redirect_uri, Date.now()],
    );
    if (!code) throw unauthorized('Authorization code is invalid or expired.');
    await getDb().run(
      'UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
      [Date.now(), code.code_hash],
    );
    const scopes = JSON.parse(code.scopes);
    const credential = await createApiKey({
      userId: code.user_id,
      name: `OAuth: ${app.name}`,
      scopes,
      expiresAt: Date.now() + 30 * 86400_000,
    });
    return res.json({
      access_token: credential.token,
      token_type: 'Bearer',
      expires_in: 30 * 86400,
      scope: scopes.join(' '),
    });
  }),
);

integrationsRouter.post(
  '/incoming/:webhookId/:token',
  asyncRoute(async (req, res) => {
    const webhookId = parse(idSchema, req.params.webhookId);
    const token = String(req.params.token ?? '');
    const webhook = await getDb().get(
      `SELECT w.*, b.user_id, c.group_id
       FROM incoming_webhooks w JOIN bots b ON b.id = w.bot_id
       JOIN channels c ON c.id = w.channel_id
       JOIN bot_installations i ON i.bot_id = w.bot_id AND i.group_id = c.group_id
       WHERE w.id = ? AND w.active = 1`,
      [webhookId],
    );
    if (!webhook || webhook.token_hash !== oauthDigest(token)) {
      throw unauthorized('Incoming webhook token is invalid.');
    }
    const webhookChannel = await getChannel(webhook.channel_id);
    const webhookContext = await groupContext(webhook.group_id, {
      id: webhook.user_id,
      role: 'member',
    });
    if (
      !webhookChannel ||
      !(await channelPermission(webhookChannel, webhookContext, 'sendMessages'))
    ) {
      throw forbidden('This webhook can no longer send messages in that channel.');
    }
    const body = parse(
      z.object({ content: messageContentSchema, username: z.string().trim().max(48).optional() }),
      req.body,
    );
    const message = await createMessage({
      channelId: webhook.channel_id,
      authorId: webhook.user_id,
      content: body.content,
      type: 'user',
    });
    await getDb().run('UPDATE incoming_webhooks SET last_used_at = ? WHERE id = ?', [Date.now(), webhook.id]);
    emitToChannel(webhook.channel_id, 'message:created', { message });
    await recordSyncEvent({
      targetType: 'channel',
      targetId: webhook.channel_id,
      eventType: 'message.created',
      entityId: message.id,
      payload: message,
    });
    return res.status(201).json({ message });
  }),
);

integrationsRouter.use(requireAuth);

integrationsRouter.get(
  '/api-keys',
  asyncRoute(async (req, res) => res.json({ apiKeys: await listApiKeys(req.user.id) })),
);

integrationsRouter.delete(
  '/bots/:botId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.botId);
    await disableBot(id, req.user.id);
    await audit({
      actorId: req.user.id,
      action: 'bot.disabled',
      targetType: 'bot',
      targetId: id,
    });
    return res.json({ ok: true });
  }),
);

integrationsRouter.post(
  '/api-keys',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1).max(3),
        expiresAt: z.number().int().optional().nullable(),
      }),
      req.body,
    );
    if (body.scopes.includes('admin') && req.user.role !== 'admin') {
      throw forbidden('Only administrators can create admin-scoped keys.');
    }
    const result = await createApiKey({ userId: req.user.id, ...body });
    await audit({
      actorId: req.user.id,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: result.apiKey.id,
      meta: { scopes: result.apiKey.scopes },
    });
    return res.status(201).json(result);
  }),
);

integrationsRouter.delete(
  '/api-keys/:keyId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.keyId);
    await revokeApiKey(id, req.user.id);
    await audit({
      actorId: req.user.id,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: id,
    });
    return res.json({ ok: true });
  }),
);

integrationsRouter.get(
  '/bots',
  asyncRoute(async (req, res) => res.json({ bots: await listBots(req.user.id) })),
);

integrationsRouter.post(
  '/bots',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(48),
        description: z.string().trim().max(300).optional().nullable(),
      }),
      req.body,
    );
    const result = await createBot({ ownerId: req.user.id, ...body });
    await audit({
      actorId: req.user.id,
      action: 'bot.created',
      targetType: 'bot',
      targetId: result.bot.id,
    });
    return res.status(201).json(result);
  }),
);

integrationsRouter.get(
  '/apps',
  asyncRoute(async (req, res) => {
    const rows = await getDb().all(
      'SELECT * FROM oauth_apps WHERE owner_id = ? ORDER BY created_at DESC',
      [req.user.id],
    );
    return res.json({
      apps: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        clientId: row.client_id,
        redirectUris: JSON.parse(row.redirect_uris),
        scopes: JSON.parse(row.scopes),
        active: Boolean(row.active),
        createdAt: Number(row.created_at),
      })),
    });
  }),
);

integrationsRouter.post(
  '/apps',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80),
        description: z.string().trim().max(300).optional().nullable(),
        redirectUris: z.array(z.string().url().max(2000)).min(1).max(10),
        scopes: z.array(z.enum(['read', 'write'])).min(1).max(2),
      }),
      req.body,
    );
    const id = newId();
    const clientId = `zdis_${crypto.randomBytes(12).toString('base64url')}`;
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    await getDb().run(
      `INSERT INTO oauth_apps
        (id, owner_id, name, description, client_id, client_secret_hash,
         redirect_uris, scopes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        req.user.id,
        body.name,
        body.description ?? null,
        clientId,
        oauthDigest(clientSecret),
        JSON.stringify(body.redirectUris),
        JSON.stringify([...new Set(body.scopes)].filter((scope) => OAUTH_SCOPES.has(scope))),
        now,
        now,
      ],
    );
    await audit({
      actorId: req.user.id,
      action: 'oauth_app.created',
      targetType: 'oauth_app',
      targetId: id,
    });
    return res.status(201).json({
      app: { id, name: body.name, clientId, redirectUris: body.redirectUris, scopes: body.scopes },
      clientSecret,
    });
  }),
);

integrationsRouter.post(
  '/oauth/authorize',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        clientId: z.string().min(8).max(100),
        redirectUri: z.string().url().max(2000),
        scopes: z.array(z.enum(['read', 'write'])).min(1).max(2),
        state: z.string().max(500).optional(),
      }),
      req.body,
    );
    const app = await getDb().get(
      'SELECT * FROM oauth_apps WHERE client_id = ? AND active = 1',
      [body.clientId],
    );
    if (!app || !JSON.parse(app.redirect_uris).includes(body.redirectUri)) {
      throw badRequest('OAuth application or redirect URI is invalid.');
    }
    const permitted = new Set(JSON.parse(app.scopes));
    if (body.scopes.some((scope) => !permitted.has(scope))) {
      throw forbidden('The application did not register all requested scopes.');
    }
    const code = crypto.randomBytes(32).toString('base64url');
    await getDb().run(
      `INSERT INTO oauth_authorization_codes
        (code_hash, app_id, user_id, redirect_uri, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        oauthDigest(code),
        app.id,
        req.user.id,
        body.redirectUri,
        JSON.stringify(body.scopes),
        Date.now() + 5 * 60_000,
      ],
    );
    const redirect = new URL(body.redirectUri);
    redirect.searchParams.set('code', code);
    if (body.state) redirect.searchParams.set('state', body.state);
    return res.json({
      app: { id: app.id, name: app.name, description: app.description },
      redirectUrl: redirect.toString(),
      expiresIn: 300,
    });
  }),
);

integrationsRouter.post(
  '/groups/:groupId/bots/:botId/install',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const botId = parse(idSchema, req.params.botId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageGroup')) throw forbidden('Manage Server permission is required.');
    const bot = await getDb().get(
      `SELECT b.*, u.is_active FROM bots b JOIN users u ON u.id = b.user_id WHERE b.id = ?`,
      [botId],
    );
    if (!bot || !bot.is_active) throw notFound('Active bot not found.');
    const permissions = parse(
      z.object({
        permissions: z.array(z.enum(SERVER_PERMISSION_KEYS))
          .max(SERVER_PERMISSION_KEYS.length)
          .default(['viewChannel', 'sendMessages']),
      }),
      req.body ?? {},
    ).permissions;
    for (const permission of permissions) {
      if (!context.can(permission)) {
        throw forbidden(`You cannot grant the ${permission} permission to this bot.`);
      }
    }
    const existingInstallation = await getDb().get(
      'SELECT role_id FROM bot_installations WHERE bot_id = ? AND group_id = ?',
      [botId, groupId],
    );
    const roleId = existingInstallation?.role_id ?? newId();
    const highest = await getDb().get(
      'SELECT COALESCE(MAX(position), 0) AS position FROM server_roles WHERE group_id = ?',
      [groupId],
    );
    const rolePosition = Math.max(
      1,
      Math.min(Number(highest?.position ?? 0) + 1, context.highestRolePosition - 1),
    );
    if (rolePosition >= context.highestRolePosition) {
      throw forbidden('Your highest role is not high enough to place this bot role.');
    }
    await getDb().tx(async (tx) => {
      await tx.run(
        `INSERT INTO bot_installations
          (bot_id, group_id, installed_by, permissions, role_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, group_id)
         DO UPDATE SET installed_by = excluded.installed_by,
           permissions = excluded.permissions, role_id = excluded.role_id`,
        [botId, groupId, req.user.id, JSON.stringify(permissions), roleId, Date.now()],
      );
      await tx.run(
        `INSERT INTO group_members (group_id, user_id, role, invited_by, joined_at)
         VALUES (?, ?, 'member', ?, ?)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, bot.user_id, req.user.id, Date.now()],
      );
      await tx.run(
        `INSERT INTO server_roles
          (id, group_id, name, color, position, permissions, is_default, hoist,
           mentionable, managed, managed_by, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, 1, ?, ?, ?, ?)
         ON CONFLICT (id)
         DO UPDATE SET name = excluded.name, permissions = excluded.permissions,
           position = excluded.position, managed = 1,
           managed_by = excluded.managed_by, updated_at = excluded.updated_at`,
        [
          roleId,
          groupId,
          `${bot.name} Bot`,
          '#5865f2',
          rolePosition,
          JSON.stringify(normalizeServerPermissions(permissions)),
          botId,
          req.user.id,
          Date.now(),
          Date.now(),
        ],
      );
      await tx.run(
        `INSERT INTO server_member_roles
          (group_id, user_id, role_id, assigned_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (group_id, user_id, role_id) DO NOTHING`,
        [groupId, bot.user_id, roleId, req.user.id, Date.now()],
      );
    });
    await invalidateGroup(groupId);
    await refreshUserRooms(bot.user_id);
    emitToGroup(groupId, 'group:roles-updated', { groupId });
    return res.status(201).json({ installed: true });
  }),
);

integrationsRouter.delete(
  '/groups/:groupId/bots/:botId/install',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const botId = parse(idSchema, req.params.botId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageGroup')) throw forbidden('Manage Server permission is required.');
    const bot = await getDb().get(
      `SELECT b.user_id, i.role_id FROM bots b
       LEFT JOIN bot_installations i ON i.bot_id = b.id AND i.group_id = ?
       WHERE b.id = ?`,
      [groupId, botId],
    );
    if (!bot) throw notFound('Bot not found.');
    await getDb().tx(async (tx) => {
      await tx.run('DELETE FROM bot_installations WHERE bot_id = ? AND group_id = ?', [botId, groupId]);
      if (bot.role_id) {
        await tx.run(
          "DELETE FROM channel_permission_overrides WHERE group_id = ? AND target_type = 'role' AND target_id = ?",
          [groupId, bot.role_id],
        );
        await tx.run(
          "DELETE FROM category_permission_overrides WHERE group_id = ? AND target_type = 'role' AND target_id = ?",
          [groupId, bot.role_id],
        );
        await tx.run(
          'DELETE FROM server_member_roles WHERE group_id = ? AND role_id = ?',
          [groupId, bot.role_id],
        );
        await tx.run('DELETE FROM server_roles WHERE id = ? AND group_id = ?', [bot.role_id, groupId]);
      }
      await tx.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, bot.user_id]);
    });
    await invalidateGroup(groupId);
    await refreshUserRooms(bot.user_id);
    emitToGroup(groupId, 'group:roles-updated', { groupId });
    return res.json({ installed: false });
  }),
);

integrationsRouter.get(
  '/groups/:groupId/commands',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    const rows = await getDb().all(
      `SELECT c.id, c.name, c.description, c.bot_id, b.name AS bot_name
       FROM slash_commands c JOIN bots b ON b.id = c.bot_id
       WHERE c.group_id = ? AND c.active = 1 ORDER BY c.name`,
      [groupId],
    );
    return res.json({
      commands: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        botId: row.bot_id,
        botName: row.bot_name,
      })),
    });
  }),
);

integrationsRouter.post(
  '/groups/:groupId/commands',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageGroup')) throw forbidden('Manage Server permission is required.');
    const body = parse(
      z.object({
        botId: idSchema,
        name: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/),
        description: z.string().trim().max(100).optional().nullable(),
        responseTemplate: z.string().trim().min(1).max(2000),
      }),
      req.body,
    );
    const installed = await getDb().get(
      `SELECT b.owner_id FROM bot_installations i JOIN bots b ON b.id = i.bot_id
       WHERE i.group_id = ? AND i.bot_id = ?`,
      [groupId, body.botId],
    );
    if (!installed || installed.owner_id !== req.user.id) {
      throw forbidden('Install one of your bots before registering its commands.');
    }
    const id = newId();
    try {
      await getDb().run(
        `INSERT INTO slash_commands
          (id, bot_id, group_id, name, description, response_template, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, body.botId, groupId, body.name, body.description ?? null, body.responseTemplate, Date.now(), Date.now()],
      );
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.message))) throw conflict('That slash command already exists.');
      throw error;
    }
    return res.status(201).json({ command: { id, ...body, groupId } });
  }),
);

integrationsRouter.post(
  '/commands/:commandId/execute',
  asyncRoute(async (req, res) => {
    const commandId = parse(idSchema, req.params.commandId);
    const body = parse(
      z.object({ channelId: idSchema, arguments: z.string().trim().max(1000).default('') }),
      req.body,
    );
    const command = await getDb().get(
      `SELECT c.*, b.user_id, b.name AS bot_name
       FROM slash_commands c JOIN bots b ON b.id = c.bot_id
       JOIN bot_installations i ON i.bot_id = c.bot_id AND i.group_id = c.group_id
       WHERE c.id = ? AND c.active = 1`,
      [commandId],
    );
    const channel = await getChannel(body.channelId);
    if (!command || !channel || channel.group_id !== command.group_id) {
      throw notFound('Slash command not found in this server.');
    }
    const context = await groupContext(channel.group_id, req.user);
    if (!(await canAccessChannel(channel, context)) ||
        !(await channelPermission(channel, context, 'sendMessages')) ||
        !(await channelPermission(channel, context, 'useApplicationCommands'))) {
      throw forbidden('You cannot run commands in this channel.');
    }
    const commandOverrides = await getDb().all(
      `SELECT target_type, target_id, enabled FROM slash_command_permissions
       WHERE command_id = ? AND group_id = ?`,
      [commandId, channel.group_id],
    );
    if (commandOverrides.length) {
      let enabled =
        commandOverrides.find((entry) => entry.target_type === 'everyone')?.enabled !== 0;
      const roleIds = new Set(context.serverRoles.map((role) => role.id));
      const roleEntries = commandOverrides.filter(
        (entry) => entry.target_type === 'role' && roleIds.has(entry.target_id),
      );
      if (roleEntries.some((entry) => entry.enabled === 0)) enabled = false;
      if (roleEntries.some((entry) => entry.enabled !== 0)) enabled = true;
      const channelEntry = commandOverrides.find(
        (entry) => entry.target_type === 'channel' && entry.target_id === channel.id,
      );
      if (channelEntry) enabled = channelEntry.enabled !== 0;
      const memberEntry = commandOverrides.find(
        (entry) => entry.target_type === 'member' && entry.target_id === req.user.id,
      );
      if (memberEntry) enabled = memberEntry.enabled !== 0;
      if (!enabled) throw forbidden('This command is disabled for you in this channel.');
    }
    const content = command.response_template
      .replaceAll('{user}', `@${req.user.username}`)
      .replaceAll('{args}', body.arguments)
      .slice(0, 4000);
    const message = await createMessage({
      channelId: channel.id,
      authorId: command.user_id,
      content,
      type: 'user',
    });
    emitToChannel(channel.id, 'message:created', { message });
    await recordSyncEvent({
      targetType: 'channel',
      targetId: channel.id,
      eventType: 'message.created',
      entityId: message.id,
      payload: message,
    });
    return res.status(201).json({ message });
  }),
);

integrationsRouter.get(
  '/commands/:commandId/permissions',
  asyncRoute(async (req, res) => {
    const commandId = parse(idSchema, req.params.commandId);
    const command = await getDb().get(
      'SELECT group_id FROM slash_commands WHERE id = ? AND active = 1',
      [commandId],
    );
    if (!command) throw notFound('Slash command not found.');
    const context = await groupContext(command.group_id, req.user);
    if (!context.can('manageRoles')) {
      throw forbidden('Manage Roles permission is required.');
    }
    const permissions = await getDb().all(
      `SELECT target_type, target_id, enabled, updated_by, updated_at
       FROM slash_command_permissions WHERE command_id = ?
       ORDER BY target_type, target_id`,
      [commandId],
    );
    return res.json({
      permissions: permissions.map((entry) => ({
        targetType: entry.target_type,
        targetId: entry.target_id,
        enabled: Boolean(entry.enabled),
        updatedBy: entry.updated_by,
        updatedAt: Number(entry.updated_at),
      })),
    });
  }),
);

integrationsRouter.put(
  '/commands/:commandId/permissions',
  asyncRoute(async (req, res) => {
    const commandId = parse(idSchema, req.params.commandId);
    const command = await getDb().get(
      'SELECT group_id FROM slash_commands WHERE id = ? AND active = 1',
      [commandId],
    );
    if (!command) throw notFound('Slash command not found.');
    const context = await groupContext(command.group_id, req.user);
    if (!context.can('manageRoles')) {
      throw forbidden('Manage Roles permission is required.');
    }
    const body = parse(
      z.object({
        permissions: z.array(
          z.object({
            targetType: z.enum(['everyone', 'role', 'member', 'channel']),
            targetId: idSchema,
            enabled: z.boolean(),
          }),
        ).max(100),
      }),
      req.body,
    );
    const seenTargets = new Set();
    for (const entry of body.permissions) {
      const targetId =
        entry.targetType === 'everyone' ? command.group_id : entry.targetId;
      const key = `${entry.targetType}:${targetId}`;
      if (seenTargets.has(key)) throw badRequest('Command permission targets must be unique.');
      seenTargets.add(key);
      if (entry.targetType === 'role') {
        const role = await getDb().get(
          'SELECT is_default FROM server_roles WHERE id = ? AND group_id = ?',
          [targetId, command.group_id],
        );
        if (!role || role.is_default) throw badRequest('Choose a valid non-default server role.');
      } else if (entry.targetType === 'member') {
        const member = await getDb().get(
          'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
          [command.group_id, targetId],
        );
        if (!member) throw badRequest('Choose a member of this server.');
      } else if (entry.targetType === 'channel') {
        const channel = await getDb().get(
          'SELECT 1 AS ok FROM channels WHERE group_id = ? AND id = ?',
          [command.group_id, targetId],
        );
        if (!channel) throw badRequest('Choose a channel in this server.');
      }
    }
    await getDb().tx(async (tx) => {
      await tx.run('DELETE FROM slash_command_permissions WHERE command_id = ?', [commandId]);
      for (const entry of body.permissions) {
        await tx.run(
          `INSERT INTO slash_command_permissions
            (command_id, group_id, target_type, target_id, enabled, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            commandId,
            command.group_id,
            entry.targetType,
            entry.targetType === 'everyone' ? command.group_id : entry.targetId,
            entry.enabled ? 1 : 0,
            req.user.id,
            Date.now(),
          ],
        );
      }
    });
    return res.json({ ok: true });
  }),
);

integrationsRouter.get(
  '/webhooks',
  asyncRoute(async (req, res) => res.json({ webhooks: await listWebhooks(req.user.id) })),
);

integrationsRouter.get(
  '/incoming',
  asyncRoute(async (req, res) => {
    const rows = await getDb().all(
      `SELECT w.id, w.name, w.channel_id, w.bot_id, w.active, w.created_at, w.last_used_at,
              b.name AS bot_name
       FROM incoming_webhooks w JOIN bots b ON b.id = w.bot_id
       WHERE w.owner_id = ? ORDER BY w.created_at DESC`,
      [req.user.id],
    );
    return res.json({
      webhooks: rows.map((row) => ({
        id: row.id,
        name: row.name,
        channelId: row.channel_id,
        botId: row.bot_id,
        botName: row.bot_name,
        active: Boolean(row.active),
        createdAt: Number(row.created_at),
        lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
      })),
    });
  }),
);

integrationsRouter.post(
  '/incoming',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        channelId: idSchema,
        botId: idSchema,
      }),
      req.body,
    );
    const channel = await getChannel(body.channelId);
    if (!channel) throw notFound('Channel not found.');
    const context = await groupContext(channel.group_id, req.user);
    if (!context.can('manageWebhooks')) throw forbidden('Manage Webhooks permission is required.');
    const installed = await getDb().get(
      `SELECT 1 AS ok FROM bot_installations i JOIN bots b ON b.id = i.bot_id
       WHERE i.bot_id = ? AND i.group_id = ? AND b.owner_id = ?`,
      [body.botId, channel.group_id, req.user.id],
    );
    if (!installed) throw forbidden('Install one of your bots in this server first.');
    const id = newId();
    const token = crypto.randomBytes(32).toString('base64url');
    await getDb().run(
      `INSERT INTO incoming_webhooks
        (id, owner_id, bot_id, channel_id, name, token_hash, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, req.user.id, body.botId, body.channelId, body.name, oauthDigest(token), Date.now()],
    );
    return res.status(201).json({
      webhook: { id, name: body.name, channelId: body.channelId, botId: body.botId },
      url: `/api/integrations/incoming/${id}/${token}`,
    });
  }),
);

integrationsRouter.delete(
  '/incoming/:webhookId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.webhookId);
    const result = await getDb().run(
      'DELETE FROM incoming_webhooks WHERE id = ? AND owner_id = ?',
      [id, req.user.id],
    );
    if (!result.changes) throw notFound('Incoming webhook not found.');
    return res.json({ ok: true });
  }),
);

integrationsRouter.post(
  '/webhooks',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        targetType: z.enum(['channel', 'conversation']),
        targetId: idSchema,
        name: z.string().trim().min(1).max(80),
        endpoint: z.string().url().max(2000),
        permissionLevel: z.enum(['manageWebhooks', 'manageGroup', 'owner']).default('manageWebhooks'),
        events: z
          .array(z.enum(['message.created', 'message.updated', 'message.deleted', 'poll.created', 'poll.updated', 'poll.voted', 'test']))
          .min(1)
          .max(7),
      }),
      req.body,
    );
    const groupId = await requireWebhookControl(req, body.targetType, body.targetId, body.permissionLevel);
    const result = await createWebhook({ ownerId: req.user.id, groupId, ...body });
    await audit({
      actorId: req.user.id,
      action: 'webhook.created',
      targetType: 'webhook',
      targetId: result.webhook.id,
      meta: { targetType: body.targetType, targetId: body.targetId },
    });
    return res.status(201).json(result);
  }),
);

integrationsRouter.post(
  '/webhooks/:webhookId/test',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.webhookId);
    const webhook = (await listWebhooks(req.user.id)).find((item) => item.id === id);
    if (!webhook) throw notFound('Webhook not found.');
    const eventId = await dispatchWebhookEvent({
      targetType: webhook.targetType,
      targetId: webhook.targetId,
      eventType: 'test',
      payload: { message: 'Webhook test event', actorId: req.user.id },
    });
    return res.status(202).json({ eventId });
  }),
);

integrationsRouter.get(
  '/webhooks/:webhookId/deliveries',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.webhookId);
    const webhook = (await listWebhooks(req.user.id)).find((item) => item.id === id);
    if (!webhook) throw notFound('Webhook not found.');
    const rows = await getDb().all(
      `SELECT id, event_id, event_type, status, response_status, attempts, error,
              created_at, completed_at
       FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100`,
      [id],
    );
    return res.json({
      deliveries: rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        eventType: row.event_type,
        status: row.status,
        responseStatus: row.response_status,
        attempts: Number(row.attempts),
        error: row.error,
        createdAt: Number(row.created_at),
        completedAt: row.completed_at ? Number(row.completed_at) : null,
      })),
    });
  }),
);

integrationsRouter.post(
  '/webhooks/:webhookId/deliveries/:deliveryId/retry',
  asyncRoute(async (req, res) => {
    const webhookId = parse(idSchema, req.params.webhookId);
    const deliveryId = parse(idSchema, req.params.deliveryId);
    const delivery = await getDb().get(
      `SELECT d.* FROM webhook_deliveries d JOIN outgoing_webhooks w ON w.id = d.webhook_id
       WHERE d.id = ? AND d.webhook_id = ? AND w.owner_id = ?`,
      [deliveryId, webhookId, req.user.id],
    );
    if (!delivery || !delivery.payload) throw notFound('Retryable webhook delivery not found.');
    await getDb().run(
      `UPDATE webhook_deliveries SET status = 'queued', error = NULL, completed_at = NULL WHERE id = ?`,
      [deliveryId],
    );
    await enqueue('webhook.deliver', { deliveryId, payload: JSON.parse(delivery.payload) });
    return res.status(202).json({ queued: true });
  }),
);

integrationsRouter.delete(
  '/webhooks/:webhookId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.webhookId);
    await deleteWebhook(id, req.user.id);
    return res.json({ ok: true });
  }),
);

integrationsRouter.patch(
  '/webhooks/:webhookId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.webhookId);
    const current = await getDb().get('SELECT * FROM outgoing_webhooks WHERE id = ?', [id]);
    if (!current) throw notFound('Webhook not found.');
    const body = parse(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      endpoint: z.string().url().max(2000).optional(),
      permissionLevel: z.enum(['manageWebhooks', 'manageGroup', 'owner']).optional(),
      events: z.array(z.enum(['message.created', 'message.updated', 'message.deleted', 'poll.created', 'poll.updated', 'poll.voted', 'test'])).min(1).max(7).optional(),
      active: z.boolean().optional(),
    }), req.body);
    if (current.owner_id !== req.user.id) {
      if (!current.group_id) throw notFound('Webhook not found.');
      const context = await groupContext(current.group_id, req.user);
      if (!context.can(current.permission_level || 'manageWebhooks')) throw forbidden('You do not have permission to edit this webhook.');
    }
    let endpoint = current.endpoint;
    if (body.endpoint) {
      endpoint = await assertSafeWebhookEndpoint(body.endpoint);
    }
    await getDb().run(
      `UPDATE outgoing_webhooks SET name = ?, endpoint = ?, permission_level = ?, events = ?, active = ?, updated_at = ? WHERE id = ?`,
      [body.name ?? current.name, endpoint, body.permissionLevel ?? current.permission_level ?? 'manageWebhooks', JSON.stringify(body.events ?? JSON.parse(current.events || '[]')), body.active === undefined ? current.active : body.active ? 1 : 0, Date.now(), id],
    );
    return res.json({ webhook: await getWebhook(id) });
  }),
);

integrationsRouter.get(
  '/sync',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        cursor: idSchema.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const targets = await readableTargets(req.user.id);
    if (!targets.length) return res.json({ events: [], cursor: query.cursor ?? null, hasMore: false });
    const clauses = targets.map(() => '(target_type = ? AND target_id = ?)').join(' OR ');
    const params = targets.flatMap((target) => [target.type, target.id]);
    if (query.cursor) params.push(query.cursor);
    params.push(query.limit + 1);
    const rows = await getDb().all(
      `SELECT * FROM sync_events WHERE (${clauses})
       ${query.cursor ? 'AND id > ?' : ''}
       ORDER BY id ASC LIMIT ?`,
      params,
    );
    const page = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      type: row.event_type,
      entityId: row.entity_id,
      data: JSON.parse(row.payload),
      createdAt: Number(row.created_at),
    }));
    return res.json({
      events: page,
      cursor: page.at(-1)?.id ?? query.cursor ?? null,
      hasMore: rows.length > query.limit,
    });
  }),
);

integrationsRouter.get(
  '/export',
  asyncRoute(async (req, res) => {
    const targets = await readableTargets(req.user.id);
    const messages = [];
    for (const target of targets) {
      const rows = await getDb().all(
        `SELECT id FROM messages
         WHERE ${target.type === 'channel' ? 'channel_id' : 'conversation_id'} = ?
           AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY id ASC LIMIT 10000`,
        [target.id, Date.now()],
      );
      for (const row of rows) {
        const message = await hydrateMessage(row.id);
        if (message) messages.push(message);
      }
    }
    await audit({
      actorId: req.user.id,
      action: 'data.exported',
      targetType: 'user',
      targetId: req.user.id,
      meta: { targets: targets.length, messages: messages.length },
    });
    res.setHeader('Content-Disposition', `attachment; filename="youtbelimo-export-${Date.now()}.json"`);
    return res.json({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      userId: req.user.id,
      targets,
      messages,
    });
  }),
);

integrationsRouter.post(
  '/import',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        targetType: z.enum(['channel', 'conversation']),
        targetId: idSchema,
        messages: z
          .array(z.object({ content: messageContentSchema, sourceId: z.string().max(200).optional() }))
          .min(1)
          .max(500),
      }),
      req.body,
    );
    await requireTargetRead(req, body.targetType, body.targetId);
    const imported = [];
    for (const item of body.messages) {
      await inspectDlp(item.content, { source: 'import', actorId: req.user.id });
      const message = await createMessage({
        channelId: body.targetType === 'channel' ? body.targetId : null,
        conversationId: body.targetType === 'conversation' ? body.targetId : null,
        authorId: req.user.id,
        content: item.content,
        type: 'imported',
      });
      await recordSyncEvent({
        targetType: body.targetType,
        targetId: body.targetId,
        eventType: 'message.created',
        entityId: message.id,
        payload: message,
      });
      imported.push({ sourceId: item.sourceId ?? null, messageId: message.id });
    }
    await audit({
      actorId: req.user.id,
      action: 'data.imported',
      targetType: body.targetType,
      targetId: body.targetId,
      meta: { messages: imported.length },
    });
    return res.status(201).json({ imported });
  }),
);

async function requireTargetRead(req, targetType, targetId) {
  if (targetType === 'conversation') {
    if (!(await isConversationMember(targetId, req.user.id))) throw notFound('Target not found.');
    return;
  }
  const channel = await getChannel(targetId);
  if (!channel) throw notFound('Target not found.');
  const context = await groupContext(channel.group_id, req.user);
  if (!(await canAccessChannel(channel, context))) throw notFound('Target not found.');
}

async function requireWebhookControl(req, targetType, targetId, permissionLevel = 'manageWebhooks') {
  await requireTargetRead(req, targetType, targetId);
  if (targetType === 'channel') {
    const channel = await getChannel(targetId);
    const context = await groupContext(channel.group_id, req.user);
    if (!context.can(permissionLevel)) throw forbidden(`The ${permissionLevel} permission is required.`);
    return channel.group_id;
  }
  return null;
}


async function readableTargets(userId) {
  const db = getDb();
  const channels = await db.all(
    `SELECT c.id, c.is_private,
       CASE WHEN cm.user_id IS NULL THEN 0 ELSE 1 END AS has_private_seat
     FROM channels c JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = ?
     LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
     WHERE c.type = 'text'`,
    [userId, userId],
  );
  const conversations = await db.all(
    'SELECT conversation_id AS id FROM conversation_members WHERE user_id = ? AND closed = 0',
    [userId],
  );
  return [
    ...channels
      .filter((row) => !row.is_private || row.has_private_seat)
      .map((row) => ({ type: 'channel', id: row.id })),
    ...conversations.map((row) => ({ type: 'conversation', id: row.id })),
  ];
}
