import { getDb } from '../db/index.js';
import { cache } from '../cache/index.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { invalidateUser } from './users.js';

/**
 * A person is described by a set of badges rather than one role, because the
 * same human is often several things at once — a streamer who is also on
 * staff, or a developer who also creates content.
 *
 * `primary` badges are granted only by an administrator and are what the
 * permission system reads. `secondary` badges are team labels that any
 * streamer may hand to somebody on their own roster; they carry no power.
 */
export const BADGE_CATALOGUE = [
  // --- primary: capability-bearing ---
  { id: 'admin', label: 'Administrator', kind: 'primary', icon: 'shield', color: '#ed4245', position: 0 },
  { id: 'staff', label: 'Staff', kind: 'primary', icon: 'star', color: '#5865f2', position: 1 },
  { id: 'developer', label: 'Developer', kind: 'primary', icon: 'code', color: '#00b0f4', position: 2 },
  { id: 'streamer', label: 'Streamer', kind: 'primary', icon: 'broadcast', color: '#eb459e', position: 3 },
  { id: 'content_creator', label: 'Content Creator', kind: 'primary', icon: 'camera', color: '#faa61a', position: 4 },

  // --- primary: platform identity, cosmetic ---
  { id: 'youtube', label: 'YouTube', kind: 'primary', icon: 'youtube', color: '#ff0000', position: 5 },
  { id: 'twitch', label: 'Twitch', kind: 'primary', icon: 'twitch', color: '#9146ff', position: 6 },
  { id: 'kick', label: 'Kick', kind: 'primary', icon: 'kick', color: '#53fc18', position: 7 },
  { id: 'instagram', label: 'Instagram', kind: 'primary', icon: 'instagram', color: '#e1306c', position: 8 },
  { id: 'tiktok', label: 'TikTok', kind: 'primary', icon: 'tiktok', color: '#25f4ee', position: 9 },

  // --- secondary: team labels a streamer hands out ---
  { id: 'editor', label: 'Editor', kind: 'secondary', icon: 'scissors', color: '#43b581', position: 20 },
  { id: 'picoart', label: 'PicoArt · Thumbnail Artist', kind: 'secondary', icon: 'palette', color: '#faa61a', position: 21 },
  { id: 'team', label: 'Team', kind: 'secondary', icon: 'handshake', color: '#5865f2', position: 22 },
];

const BY_ID = new Map(BADGE_CATALOGUE.map((badge) => [badge.id, badge]));

/** Badges that decide what someone may do. Everything else is decoration. */
export const CAPABILITY_BADGES = new Set(['admin', 'staff', 'developer', 'streamer']);

export const PRIMARY_BADGE_IDS = BADGE_CATALOGUE.filter((b) => b.kind === 'primary').map((b) => b.id);
export const SECONDARY_BADGE_IDS = BADGE_CATALOGUE.filter((b) => b.kind === 'secondary').map((b) => b.id);

const userBadgeKey = (userId) => `badges:${userId}`;

/** Writes the catalogue into the database on boot; safe to run every time. */
export async function ensureBadgeCatalogue() {
  const db = getDb();
  const now = Date.now();
  for (const badge of BADGE_CATALOGUE) {
    await db.run(
      `INSERT INTO badges (id, label, kind, icon, color, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label, kind = excluded.kind,
         icon = excluded.icon, color = excluded.color, position = excluded.position`,
      [badge.id, badge.label, badge.kind, badge.icon, badge.color, badge.position, now],
    );
  }

  // Upgrade accounts created before badges existed. Do not replace an
  // account's explicit badge set; only seed the capability represented by the
  // legacy role column.
  await db.run(
    `INSERT INTO user_badges (user_id, badge_id, granted_by, granted_at)
     SELECT id, 'admin', created_by, ? FROM users
     WHERE role = 'admin'
     ON CONFLICT (user_id, badge_id) DO NOTHING`,
    [now],
  );
  await db.run(
    `INSERT INTO user_badges (user_id, badge_id, granted_by, granted_at)
     SELECT id, 'streamer', created_by, ? FROM users
     WHERE role = 'youtuber'
     ON CONFLICT (user_id, badge_id) DO NOTHING`,
    [now],
  );
}

export function getBadgeDefinition(badgeId) {
  return BY_ID.get(badgeId) ?? null;
}

export async function listBadgeIds(userId) {
  return cache.wrap(userBadgeKey(userId), 120, async () => {
    const rows = await getDb().all(
      'SELECT badge_id FROM user_badges WHERE user_id = ? ORDER BY badge_id',
      [userId],
    );
    return rows.map((row) => row.badge_id);
  });
}

/** Full badge objects, ordered for display. */
export async function listBadges(userId) {
  const ids = await listBadgeIds(userId);
  return ids
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .sort((a, b) => a.position - b.position);
}

/** Bulk variant so a member list does not issue one query per person. */
export async function listBadgesForUsers(userIds) {
  if (!userIds.length) return new Map();
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = await getDb().all(
    `SELECT user_id, badge_id FROM user_badges WHERE user_id IN (${placeholders})`,
    userIds,
  );

  const byUser = new Map(userIds.map((id) => [id, []]));
  for (const row of rows) {
    const badge = BY_ID.get(row.badge_id);
    if (badge) byUser.get(row.user_id)?.push(badge);
  }
  for (const list of byUser.values()) list.sort((a, b) => a.position - b.position);
  return byUser;
}

export async function hasBadge(userId, badgeId) {
  return (await listBadgeIds(userId)).includes(badgeId);
}

export async function invalidateBadges(userId) {
  await cache.del(userBadgeKey(userId));
  await invalidateUser(userId);
}

/**
 * `users.role` is kept in step with the capability badges so the many existing
 * queries that filter or sort by role stay correct and fast. Badges remain the
 * source of truth; this is a derived column.
 */
export async function syncRoleColumn(userId) {
  const ids = await listBadgeIds(userId);
  // `youtuber` is the stable API/database role used by the existing client.
  // The more general `streamer` badge is the source of the capability.
  const role = ids.includes('admin') ? 'admin' : ids.includes('streamer') ? 'youtuber' : 'member';
  await getDb().run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [
    role,
    Date.now(),
    userId,
  ]);
  await invalidateUser(userId);
  return role;
}

export async function grantBadge({ userId, badgeId, grantedBy }) {
  const badge = BY_ID.get(badgeId);
  if (!badge) throw badRequest('Unknown badge.');

  const user = await getDb().get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('User not found.');

  await getDb().run(
    `INSERT INTO user_badges (user_id, badge_id, granted_by, granted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, badge_id) DO NOTHING`,
    [userId, badgeId, grantedBy, Date.now()],
  );
  await invalidateBadges(userId);
  if (CAPABILITY_BADGES.has(badgeId)) await syncRoleColumn(userId);
  return badge;
}

export async function revokeBadge({ userId, badgeId }) {
  const badge = BY_ID.get(badgeId);
  if (!badge) throw badRequest('Unknown badge.');

  // Refuse to strip the last administrator of the badge that makes them one.
  if (badgeId === 'admin') {
    const row = await getDb().get(
      `SELECT COUNT(*) AS count FROM user_badges ub
       JOIN users u ON u.id = ub.user_id
       WHERE ub.badge_id = 'admin' AND u.is_active = 1`,
    );
    if (Number(row?.count ?? 0) <= 1) throw badRequest('This is the last administrator.');
  }

  await getDb().run('DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?', [userId, badgeId]);
  await invalidateBadges(userId);
  if (CAPABILITY_BADGES.has(badgeId)) await syncRoleColumn(userId);
  return badge;
}

/**
 * Replaces the whole primary set in one go, which is what the admin panel's
 * badge editor submits.
 */
export async function setPrimaryBadges({ userId, badgeIds, grantedBy }) {
  const wanted = new Set(badgeIds.filter((id) => PRIMARY_BADGE_IDS.includes(id)));
  const current = new Set(
    (await listBadgeIds(userId)).filter((id) => PRIMARY_BADGE_IDS.includes(id)),
  );

  for (const id of current) {
    if (!wanted.has(id)) await revokeBadge({ userId, badgeId: id });
  }
  for (const id of wanted) {
    if (!current.has(id)) await grantBadge({ userId, badgeId: id, grantedBy });
  }
  return listBadges(userId);
}

/**
 * Secondary badges are handed out by streamers, but only to people who are
 * actually on their roster — an account they provisioned, or someone who has
 * accepted their access request.
 */
export async function canManageSecondaryBadges(actor, targetUserId) {
  const actorBadges = await listBadgeIds(actor.id);
  if (actorBadges.includes('admin')) return true;
  if (!actorBadges.includes('streamer')) return false;

  const db = getDb();
  const owned = await db.get('SELECT owner_streamer_id FROM users WHERE id = ?', [targetUserId]);
  if (owned?.owner_streamer_id === actor.id) return true;

  const granted = await db.get(
    "SELECT 1 AS ok FROM access_requests WHERE streamer_id = ? AND user_id = ? AND status = 'accepted'",
    [actor.id, targetUserId],
  );
  if (granted) return true;

  // Also allowed for anyone sharing a group this streamer owns.
  const shared = await db.get(
    `SELECT 1 AS ok FROM group_members m
     JOIN chat_groups g ON g.id = m.group_id
     WHERE g.owner_id = ? AND m.user_id = ?`,
    [actor.id, targetUserId],
  );
  return Boolean(shared);
}

export async function requireSecondaryBadgeControl(actor, targetUserId) {
  if (!(await canManageSecondaryBadges(actor, targetUserId))) {
    throw forbidden('You can only label people on your own roster.');
  }
}
