import { listBadgeIds } from './badges.js';
import { getSettings } from './settings.js';
import { getDb } from '../db/index.js';
import { forbidden } from '../lib/errors.js';

/**
 * What a person may do, derived from their badges. Nothing outside this file
 * should test a badge id directly — ask a question here instead, so the rules
 * live in one place.
 */
export const CAPABILITIES = {
  /** Full run of the admin panel. */
  ADMIN: 'admin',
  /** Moderate content and view accounts, but not change the server itself. */
  MODERATE: 'moderate',
  /** See runtime internals. */
  DEBUG: 'debug',
  /** Own groups, provision accounts, label a roster, start collabs. */
  STREAM: 'stream',
};

export async function capabilitiesOf(user) {
  const badges = await listBadgeIds(user.id);
  const set = new Set();

  if (badges.includes('admin')) {
    set.add(CAPABILITIES.ADMIN);
    set.add(CAPABILITIES.MODERATE);
    set.add(CAPABILITIES.DEBUG);
    set.add(CAPABILITIES.STREAM);
  }
  if (badges.includes('staff')) set.add(CAPABILITIES.MODERATE);
  if (badges.includes('developer')) set.add(CAPABILITIES.DEBUG);
  if (badges.includes('streamer')) set.add(CAPABILITIES.STREAM);

  const custom = await getDb().all(
    `SELECT rc.capability FROM user_custom_roles ur
     JOIN custom_role_capabilities rc ON rc.role_id = ur.role_id
     WHERE ur.user_id = ?`,
    [user.id],
  );
  for (const row of custom) {
    if (Object.values(CAPABILITIES).includes(row.capability)) set.add(row.capability);
  }

  return set;
}

export async function can(user, capability) {
  if (!user) return false;
  return (await capabilitiesOf(user)).has(capability);
}

export async function isAdmin(user) {
  return can(user, CAPABILITIES.ADMIN);
}

export async function isStreamer(user) {
  return can(user, CAPABILITIES.STREAM);
}

/** Who may start a group. Streamers, plus whatever the admin has opened up. */
export async function canCreateGroup(user) {
  if (await isAdmin(user)) return true;
  const settings = await getSettings();
  if (await isStreamer(user)) return settings.youtubers_can_create_groups;
  return settings.members_can_create_groups;
}

/**
 * An account provisioned by a streamer is scoped to that streamer: it may see
 * their groups, and the groups of any other streamer it has accepted. DMs are
 * deliberately outside this fence — the brief calls for them to reach anyone.
 */
export async function streamersVisibleTo(userId) {
  const db = getDb();
  const row = await db.get('SELECT owner_streamer_id FROM users WHERE id = ?', [userId]);
  const streamers = new Set();
  if (row?.owner_streamer_id) streamers.add(row.owner_streamer_id);

  const accepted = await db.all(
    "SELECT streamer_id FROM access_requests WHERE user_id = ? AND status = 'accepted'",
    [userId],
  );
  for (const entry of accepted) streamers.add(entry.streamer_id);
  return streamers;
}

/** True when this account is fenced to one or more streamers. */
export async function isScopedAccount(userId) {
  const row = await getDb().get('SELECT owner_streamer_id FROM users WHERE id = ?', [userId]);
  return Boolean(row?.owner_streamer_id);
}

/**
 * Gate for joining a group by invite: a scoped account may only join groups
 * owned by a streamer it belongs to.
 */
export async function canJoinGroup(user, group) {
  if (await isAdmin(user)) return true;
  if (!(await isScopedAccount(user.id))) return true;
  if (group.owner_id === user.id) return true;
  const allowed = await streamersVisibleTo(user.id);
  return allowed.has(group.owner_id);
}

export async function requireCapability(user, capability, message) {
  if (!(await can(user, capability))) {
    throw forbidden(message ?? 'You do not have permission to do that.');
  }
}
