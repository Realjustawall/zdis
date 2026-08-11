import { getDb } from '../db/index.js';
import { newId, inviteCode } from '../lib/ids.js';
import { conflict, notFound, badRequest, forbidden } from '../lib/errors.js';
import { cache } from '../cache/index.js';
import { toPublicUser } from './users.js';
import { listBadgesForUsers } from './badges.js';
import { DEFAULT_EVERYONE_PERMISSIONS, memberRolesByUser } from './serverRoles.js';

const groupCacheKey = (id) => `group:${id}`;
const memberListKey = (id) => `group:${id}:members`;

export function toGroup(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    iconUrl: row.icon_url ?? null,
    accentColor: row.accent_color ?? null,
    discoveryRequested: Boolean(row.discovery_requested),
    discoverable: Boolean(row.discoverable),
    require2faModeration: Boolean(row.require_2fa_moderation),
    ownerId: row.owner_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...extra,
  };
}

export function toChannel(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    categoryId: row.category_id ?? null,
    name: row.name,
    topic: row.topic ?? null,
    type: row.type,
    position: Number(row.position ?? 0),
    isPrivate: Boolean(row.is_private),
    slowmode: Number(row.slowmode ?? 0),
    voiceStatus: row.voice_status ?? null,
    permissionsSynced: Boolean(row.permissions_synced ?? 1),
    createdAt: Number(row.created_at),
  };
}

async function uniqueSlug(base) {
  const db = getDb();
  const root =
    String(base)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'group';

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const clash = await db.get('SELECT 1 AS ok FROM chat_groups WHERE slug = ?', [candidate]);
    if (!clash) return candidate;
  }
  return `${root}-${inviteCode().slice(0, 5)}`;
}

/**
 * Creates a group with its default channels and makes the creator the owner.
 * A YouTuber calling this gets their own space that they can then staff.
 */
export async function createGroup({ name, description = null, ownerId, accentColor = null }) {
  const db = getDb();
  const now = Date.now();
  const id = newId();
  const slug = await uniqueSlug(name);

  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO chat_groups (id, name, slug, description, accent_color, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, slug, description, accentColor, ownerId, now, now],
    );
    await tx.run(
      `INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
      [id, ownerId, now],
    );
    await tx.run(
      `INSERT INTO server_roles
        (id, group_id, name, color, position, permissions, is_default, hoist, mentionable,
         created_by, created_at, updated_at)
       VALUES (?, ?, '@everyone', NULL, 0, ?, 1, 0, 0, ?, ?, ?)`,
      [id, id, JSON.stringify(DEFAULT_EVERYONE_PERMISSIONS), ownerId, now, now],
    );
    await tx.run(
      `INSERT INTO channels (id, group_id, name, topic, type, position, created_at, updated_at)
       VALUES (?, ?, 'general', 'Everything else goes here', 'text', 0, ?, ?)`,
      [newId(), id, now, now],
    );
    await tx.run(
      `INSERT INTO channels (id, group_id, name, topic, type, position, created_at, updated_at)
       VALUES (?, ?, 'announcements', 'Read-only-ish updates for the team', 'text', 1, ?, ?)`,
      [newId(), id, now, now],
    );
    await tx.run(
      `INSERT INTO channels (id, group_id, name, topic, type, position, created_at, updated_at)
       VALUES (?, ?, 'Voice Lounge', NULL, 'voice', 2, ?, ?)`,
      [newId(), id, now, now],
    );
  });

  await cache.delPrefix(`group:${id}`);
  return getDb().get('SELECT * FROM chat_groups WHERE id = ?', [id]);
}

export async function listGroupsForUser(userId) {
  const rows = await getDb().all(
    `SELECT g.*, m.role AS member_role, m.nickname, m.muted, m.joined_at AS member_joined_at
     FROM chat_groups g
     JOIN group_members m ON m.group_id = g.id
     WHERE m.user_id = ?
     ORDER BY m.joined_at ASC`,
    [userId],
  );
  return rows.map((row) =>
    toGroup(row, {
      memberRole: row.member_role,
      nickname: row.nickname ?? null,
      muted: Boolean(row.muted),
      joinedAt: Number(row.member_joined_at),
    }),
  );
}

export async function listAllGroups({ limit = 200, offset = 0 } = {}) {
  const rows = await getDb().all(
    `SELECT g.*, u.username AS owner_username, u.display_name AS owner_display_name,
       (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
       (SELECT COUNT(*) FROM channels c WHERE c.group_id = g.id) AS channel_count
     FROM chat_groups g
     LEFT JOIN users u ON u.id = g.owner_id
     ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map((row) =>
    toGroup(row, {
      ownerUsername: row.owner_username,
      ownerDisplayName: row.owner_display_name,
      memberCount: Number(row.member_count ?? 0),
      channelCount: Number(row.channel_count ?? 0),
    }),
  );
}

export async function listDiscoverableGroups(search = '') {
  const pattern = `%${String(search).trim().toLowerCase()}%`;
  const rows = await getDb().all(
    `SELECT g.*, u.username AS owner_username, u.display_name AS owner_display_name,
       (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
     FROM chat_groups g LEFT JOIN users u ON u.id = g.owner_id
     WHERE g.discoverable = 1
       AND (? = '%%' OR LOWER(g.name) LIKE ? OR LOWER(COALESCE(g.description, '')) LIKE ?)
     ORDER BY member_count DESC, LOWER(g.name) ASC LIMIT 100`,
    [pattern, pattern, pattern],
  );
  return rows.map((row) => toGroup(row, {
    ownerUsername: row.owner_username,
    ownerDisplayName: row.owner_display_name,
    memberCount: Number(row.member_count ?? 0),
  }));
}

export async function listChannels(groupId) {
  const rows = await getDb().all(
    'SELECT * FROM channels WHERE group_id = ? ORDER BY position ASC, created_at ASC',
    [groupId],
  );
  return rows.map(toChannel);
}

export async function listCategories(groupId) {
  const rows = await getDb().all(
    'SELECT * FROM channel_categories WHERE group_id = ? ORDER BY position ASC, created_at ASC',
    [groupId],
  );
  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    position: Number(row.position ?? 0),
    createdAt: Number(row.created_at),
  }));
}

export async function getChannel(channelId) {
  return getDb().get('SELECT * FROM channels WHERE id = ?', [channelId]);
}

export async function listMembers(groupId) {
  return cache.wrap(memberListKey(groupId), 30, async () => {
    const rows = await getDb().all(
      `SELECT m.role, m.nickname, m.muted, m.joined_at, m.invited_by,
        u.id, u.username, u.display_name, u.avatar_url, u.banner_color, u.bio,
        u.presence, u.custom_status, u.is_active, u.last_seen_at, u.created_at, u.role AS platform_role
       FROM group_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ?
       ORDER BY
         CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END,
         LOWER(u.display_name) ASC`,
      [groupId],
    );
    const [badges, serverRoles] = await Promise.all([
      listBadgesForUsers(rows.map((row) => row.id)),
      memberRolesByUser(groupId),
    ]);
    return rows.map((row) => ({
      ...toPublicUser({
        ...row,
        role: row.platform_role,
        badges: badges.get(row.id) ?? [],
      }),
      memberRole: row.role,
      nickname: row.nickname ?? null,
      muted: Boolean(row.muted),
      joinedAt: Number(row.joined_at),
      invitedBy: row.invited_by ?? null,
      serverRoles: serverRoles.get(row.id) ?? [],
    }));
  });
}

export async function invalidateGroup(groupId) {
  await cache.del(groupCacheKey(groupId), memberListKey(groupId));
}

export async function addMember({ groupId, userId, role = 'member', invitedBy = null }) {
  const db = getDb();
  const banned = await db.get('SELECT 1 AS ok FROM server_bans WHERE group_id = ? AND user_id = ?', [
    groupId,
    userId,
  ]);
  if (banned) throw forbidden('That user is banned from this server.');
  const existing = await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?', [
    groupId,
    userId,
  ]);
  if (existing) throw conflict('That user is already in this group.');

  const user = await db.get('SELECT id, is_active FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('User not found.');
  if (!user.is_active) throw badRequest('That account is disabled.');

  await db.run(
    'INSERT INTO group_members (group_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)',
    [groupId, userId, role, invitedBy, Date.now()],
  );
  await invalidateGroup(groupId);
}

export async function removeMember({ groupId, userId }) {
  const db = getDb();
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM server_member_roles WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    await tx.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    await tx.run(
      `DELETE FROM channel_members WHERE user_id = ?
       AND channel_id IN (SELECT id FROM channels WHERE group_id = ?)`,
      [userId, groupId],
    );
  });
  await invalidateGroup(groupId);
}

export async function setMemberRole({ groupId, userId, role }) {
  await getDb().run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', [
    role,
    groupId,
    userId,
  ]);
  await invalidateGroup(groupId);
}

export async function deleteGroup(groupId) {
  const db = getDb();
  await db.tx(async (tx) => {
    await tx.run(
      `DELETE FROM attachments WHERE message_id IN
        (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?))`,
      [groupId],
    );
    await tx.run(
      `DELETE FROM reactions WHERE message_id IN
        (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?))`,
      [groupId],
    );
    await tx.run(
      `DELETE FROM mentions WHERE message_id IN
        (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?))`,
      [groupId],
    );
    await tx.run(
      'DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?)',
      [groupId],
    );
    await tx.run(
      'DELETE FROM forum_posts WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?)',
      [groupId],
    );
    await tx.run(
      'DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?)',
      [groupId],
    );
    await tx.run('DELETE FROM channel_permission_overrides WHERE group_id = ?', [groupId]);
    await tx.run(
      'DELETE FROM stage_members WHERE channel_id IN (SELECT id FROM channels WHERE group_id = ?)',
      [groupId],
    );
    await tx.run('DELETE FROM channels WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM channel_categories WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM group_invites WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM server_member_roles WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM server_roles WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM group_members WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM chat_groups WHERE id = ?', [groupId]);
  });
  await cache.delPrefix(`group:${groupId}`);
}

// ------------------------------------------------------------------ invites

export async function createInvite({ groupId, createdBy, maxUses = null, expiresInHours = null }) {
  const db = getDb();
  let code = inviteCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await db.get('SELECT 1 AS ok FROM group_invites WHERE code = ?', [code]);
    if (!clash) break;
    code = inviteCode();
  }

  const id = newId();
  await db.run(
    `INSERT INTO group_invites (id, group_id, code, created_by, max_uses, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      groupId,
      code,
      createdBy,
      maxUses,
      expiresInHours ? Date.now() + expiresInHours * 3600_000 : null,
      Date.now(),
    ],
  );
  return db.get('SELECT * FROM group_invites WHERE id = ?', [id]);
}

export async function listInvites(groupId) {
  const rows = await getDb().all(
    `SELECT i.*, u.username AS creator_username, u.display_name AS creator_display_name
     FROM group_invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.group_id = ? AND i.revoked_at IS NULL
     ORDER BY i.created_at DESC`,
    [groupId],
  );
  return rows.map(toInvite);
}

export function toInvite(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    code: row.code,
    createdBy: row.created_by,
    creatorUsername: row.creator_username ?? null,
    creatorDisplayName: row.creator_display_name ?? null,
    maxUses: row.max_uses ? Number(row.max_uses) : null,
    uses: Number(row.uses ?? 0),
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    createdAt: Number(row.created_at),
  };
}

export async function redeemInvite(code, userId) {
  const db = getDb();
  const invite = await db.get('SELECT * FROM group_invites WHERE code = ?', [String(code).trim()]);
  if (!invite || invite.revoked_at) throw notFound('That invite is not valid.');
  if (invite.expires_at && Number(invite.expires_at) < Date.now()) {
    throw badRequest('That invite has expired.');
  }
  if (invite.max_uses && Number(invite.uses) >= Number(invite.max_uses)) {
    throw badRequest('That invite has reached its use limit.');
  }
  const banned = await db.get(
    'SELECT 1 AS ok FROM server_bans WHERE group_id = ? AND user_id = ?',
    [invite.group_id, userId],
  );
  if (banned) throw forbidden('You are banned from this server.');

  const already = await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?', [
    invite.group_id,
    userId,
  ]);
  if (!already) {
    await db.run(
      'INSERT INTO group_members (group_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)',
      [invite.group_id, userId, 'member', invite.created_by, Date.now()],
    );
    await db.run('UPDATE group_invites SET uses = uses + 1 WHERE id = ?', [invite.id]);
    await invalidateGroup(invite.group_id);
  }

  return db.get('SELECT * FROM chat_groups WHERE id = ?', [invite.group_id]);
}

export async function revokeInvite(inviteId) {
  await getDb().run('UPDATE group_invites SET revoked_at = ? WHERE id = ?', [Date.now(), inviteId]);
}
