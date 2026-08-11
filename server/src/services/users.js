import { getDb, likeClause, likeValue } from '../db/index.js';
import { cache } from '../cache/index.js';
import { newId } from '../lib/ids.js';
import { hashPassword, passwordProblems } from '../lib/password.js';
import { provisionE2eeIdentity } from './e2eeKeys.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const PUBLIC_COLUMNS = `id, username, display_name, role, avatar_url, banner_color, bio,
  presence, custom_status, is_active, last_seen_at, created_at, owner_streamer_id`;

const SELF_COLUMNS = `${PUBLIC_COLUMNS}, email, phone, first_name, last_name, nickname,
  totp_enabled, tts_button_enabled, must_change_password,
  password_changed_at, last_login_at`;

const ADMIN_COLUMNS = `${SELF_COLUMNS}, failed_logins, locked_until, created_by, updated_at,
  banned_at, suspended_until, moderation_reason`;

const userCacheKey = (id) => `user:${id}`;

/** Shape sent to any authenticated user (the member directory). */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarUrl: row.avatar_url ?? null,
    bannerColor: row.banner_color ?? null,
    bio: row.bio ?? null,
    presence: row.is_active ? row.presence : 'offline',
    customStatus: row.custom_status ?? null,
    isActive: Boolean(row.is_active),
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
    createdAt: Number(row.created_at),
    ownerStreamerId: row.owner_streamer_id ?? null,
    badges: Array.isArray(row.badges) ? row.badges : [],
  };
}

/** Adds fields a user may see about themselves. */
export function toSelfUser(row) {
  return {
    ...toPublicUser(row),
    email: row.email,
    phone: row.phone ?? null,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    nickname: row.nickname ?? null,
    totpEnabled: Boolean(row.totp_enabled),
    ttsButtonEnabled: row.tts_button_enabled === undefined ? true : Boolean(row.tts_button_enabled),
    mustChangePassword: Boolean(row.must_change_password),
    passwordChangedAt: row.password_changed_at ? Number(row.password_changed_at) : null,
    lastLoginAt: row.last_login_at ? Number(row.last_login_at) : null,
  };
}

/** Adds fields only an administrator may see. */
export function toAdminUser(row) {
  return {
    ...toSelfUser(row),
    failedLogins: Number(row.failed_logins ?? 0),
    lockedUntil: row.locked_until ? Number(row.locked_until) : null,
    bannedAt: row.banned_at ? Number(row.banned_at) : null,
    suspendedUntil: row.suspended_until ? Number(row.suspended_until) : null,
    moderationReason: row.moderation_reason ?? null,
    lastLoginIp: row.last_login_ip ?? null,
    createdBy: row.created_by ?? null,
    updatedAt: Number(row.updated_at),
  };
}

export async function findUserById(id) {
  if (!id) return null;
  return getDb().get(`SELECT * FROM users WHERE id = ?`, [id]);
}

export async function findUserByEmail(email) {
  return getDb().get(`SELECT * FROM users WHERE email = ?`, [String(email).toLowerCase().trim()]);
}

export async function findUserByUsername(username) {
  return getDb().get(`SELECT * FROM users WHERE username = ?`, [
    String(username).toLowerCase().trim(),
  ]);
}

export async function findUserByPhone(phone) {
  return getDb().get('SELECT * FROM users WHERE phone = ?', [String(phone).trim()]);
}

/**
 * Accepts either an email or a username so people can sign in with whichever
 * they remember.
 */
export async function findUserByIdentifier(identifier) {
  const value = String(identifier ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.includes('@')) return findUserByEmail(value);
  if (/^\+?[0-9][0-9 -]{6,19}$/.test(value)) {
    const byPhone = await findUserByPhone(value.replace(/[ -]/g, ''));
    if (byPhone) return byPhone;
  }
  return findUserByUsername(value);
}

export async function getPublicUser(id) {
  return cache.wrap(userCacheKey(id), 120, async () => {
    const row = await getDb().get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [id]);
    if (!row) return null;
    row.badges = await badgeRowsForUsers([id]).then((map) => map.get(id) ?? []);
    return toPublicUser(row);
  });
}

export async function invalidateUser(id) {
  await cache.del(userCacheKey(id));
}

/** Directory listing — every account can see every other account. */
export async function listUsers({ search = '', limit = 100, offset = 0, includeInactive = true } = {}) {
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push(
      `(${likeClause('username')} OR ${likeClause('display_name')})`,
    );
    params.push(likeValue(search), likeValue(search));
  }
  if (!includeInactive) clauses.push('is_active = 1');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  const rows = await getDb().all(
    `SELECT ${PUBLIC_COLUMNS} FROM users ${where}
     ORDER BY is_active DESC, LOWER(display_name) ASC
     LIMIT ? OFFSET ?`,
    params,
  );
  const badges = await badgeRowsForUsers(rows.map((row) => row.id));
  for (const row of rows) row.badges = badges.get(row.id) ?? [];
  return rows.map(toPublicUser);
}

export async function listUsersForAdmin({ search = '', role = null, limit = 200, offset = 0 } = {}) {
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push(
      `(${likeClause('username')} OR ${likeClause('display_name')} OR ${likeClause('email')})`,
    );
    params.push(likeValue(search), likeValue(search), likeValue(search));
  }
  if (role) {
    clauses.push('role = ?');
    params.push(role);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  const rows = await getDb().all(
    `SELECT ${ADMIN_COLUMNS},
       (SELECT sessions.ip FROM sessions
        WHERE sessions.user_id = users.id
        ORDER BY sessions.created_at DESC LIMIT 1) AS last_login_ip
     FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    params,
  );

  const total = await getDb().get(`SELECT COUNT(*) AS count FROM users ${where}`, params.slice(0, -2));

  const badges = await badgeRowsForUsers(rows.map((row) => row.id));
  for (const row of rows) row.badges = badges.get(row.id) ?? [];
  return { users: rows.map(toAdminUser), total: Number(total?.count ?? 0) };
}

async function badgeRowsForUsers(userIds) {
  const result = new Map(userIds.map((id) => [id, []]));
  if (!userIds.length) return result;
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = await getDb().all(
    `SELECT ub.user_id, b.id, b.label, b.kind, b.icon, b.color, b.position
     FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
     WHERE ub.user_id IN (${placeholders})
     ORDER BY b.position ASC`,
    userIds,
  );
  for (const row of rows) {
    result.get(row.user_id)?.push({
      id: row.id,
      label: row.label,
      kind: row.kind,
      icon: row.icon,
      color: row.color,
      position: Number(row.position),
    });
  }
  return result;
}

/** Adds current badges to a raw user row before serialising it. */
export async function withBadges(row) {
  if (!row) return row;
  row.badges = await badgeRowsForUsers([row.id]).then((map) => map.get(row.id) ?? []);
  return row;
}

export async function countUsers() {
  const row = await getDb().get('SELECT COUNT(*) AS count FROM users');
  return Number(row?.count ?? 0);
}

/**
 * The only way an account comes into existence — there is no public signup.
 * Called by the admin panel and by the first-run seed script.
 */
export async function createUser({
  email,
  phone = null,
  firstName = null,
  lastName = null,
  nickname = null,
  username,
  displayName,
  password,
  role = 'member',
  bio = null,
  mustChangePassword = false,
  createdBy = null,
  ownerStreamerId = null,
  skipPasswordPolicy = false,
}) {
  const db = getDb();
  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedUsername = String(username).toLowerCase().trim();
  const normalizedPhone = phone ? String(phone).replace(/[ -]/g, '').trim() : null;

  if (!skipPasswordPolicy) {
    const problems = passwordProblems(password);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);
  }

  if (await findUserByEmail(normalizedEmail)) {
    throw conflict('An account with that email already exists.');
  }
  if (await findUserByUsername(normalizedUsername)) {
    throw conflict('That username is taken.');
  }
  if (normalizedPhone && (await findUserByPhone(normalizedPhone))) {
    throw conflict('An account with that phone number already exists.');
  }

  const now = Date.now();
  const id = newId();
  const passwordHash = await hashPassword(password);

  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO users (
         id, email, phone, username, first_name, last_name, nickname,
         display_name, password_hash, password_changed_at,
         must_change_password, role, bio, banner_color, presence, is_active,
         created_by, owner_streamer_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', 1, ?, ?, ?, ?)`,
      [
        id,
        normalizedEmail,
        normalizedPhone,
        normalizedUsername,
        firstName ? String(firstName).trim() : null,
        lastName ? String(lastName).trim() : null,
        nickname ? String(nickname).trim() : null,
        String(displayName).trim(),
        passwordHash,
        now,
        mustChangePassword ? 1 : 0,
        role,
        bio,
        pickBannerColor(normalizedUsername),
        createdBy,
        ownerStreamerId,
        now,
        now,
      ],
    );
    const capabilityBadge = role === 'admin' ? 'admin' : role === 'youtuber' ? 'streamer' : null;
    if (capabilityBadge) {
      await tx.run(
        `INSERT INTO user_badges (user_id, badge_id, granted_by, granted_at)
         VALUES (?, ?, ?, ?)`,
        [id, capabilityBadge, createdBy, now],
      );
    }
  });

  await provisionE2eeIdentity(id);

  return findUserById(id);
}

const PALETTE = ['#f04747', '#faa61a', '#43b581', '#5865f2', '#eb459e', '#00b0f4', '#9b59b6', '#e67e22'];

function pickBannerColor(seed) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const UPDATABLE = {
  displayName: 'display_name',
  bio: 'bio',
  avatarUrl: 'avatar_url',
  bannerColor: 'banner_color',
  customStatus: 'custom_status',
  presence: 'presence',
  role: 'role',
  isActive: 'is_active',
  email: 'email',
  username: 'username',
  phone: 'phone',
  firstName: 'first_name',
  lastName: 'last_name',
  nickname: 'nickname',
  mustChangePassword: 'must_change_password',
  ttsButtonEnabled: 'tts_button_enabled',
};

export async function updateUser(id, patch) {
  const db = getDb();
  const existing = await findUserById(id);
  if (!existing) throw notFound('User not found.');

  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (!(key in patch) || patch[key] === undefined) continue;
    let value = patch[key];
    if (key === 'email') {
      value = String(value).toLowerCase().trim();
      const clash = await findUserByEmail(value);
      if (clash && clash.id !== id) throw conflict('An account with that email already exists.');
    }
    if (key === 'username') {
      value = String(value).toLowerCase().trim();
      const clash = await findUserByUsername(value);
      if (clash && clash.id !== id) throw conflict('That username is taken.');
    }
    if (key === 'phone') {
      value = value ? String(value).replace(/[ -]/g, '').trim() : null;
      if (value) {
        const clash = await findUserByPhone(value);
        if (clash && clash.id !== id) {
          throw conflict('An account with that phone number already exists.');
        }
      }
    }
    if (typeof value === 'boolean') value = value ? 1 : 0;
    sets.push(`${column} = ?`);
    params.push(value);
  }

  if (!sets.length) return existing;

  sets.push('updated_at = ?');
  params.push(Date.now(), id);

  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  await invalidateUser(id);
  return findUserById(id);
}

export async function setPassword(id, password, { mustChange = false, skipPolicy = false } = {}) {
  if (!skipPolicy) {
    const problems = passwordProblems(password);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);
  }
  const hash = await hashPassword(password);
  const now = Date.now();
  await getDb().run(
    `UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = ?,
      failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
    [hash, now, mustChange ? 1 : 0, now, id],
  );
  await invalidateUser(id);
}

export async function deleteUser(id) {
  const db = getDb();
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM server_member_roles WHERE user_id = ?', [id]);
    await tx.run(
      "DELETE FROM channel_permission_overrides WHERE target_type = 'member' AND target_id = ?",
      [id],
    );
    await tx.run('DELETE FROM group_members WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM channel_members WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM conversation_members WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM reactions WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM mentions WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM read_states WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM user_blocks WHERE user_id = ? OR blocked_id = ?', [id, id]);
    await tx.run('DELETE FROM user_badges WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM user_custom_roles WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM linked_accounts WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?', [id, id]);
    await tx.run('DELETE FROM collabs WHERE initiator_id = ? OR partner_id = ?', [id, id]);
    await tx.run('DELETE FROM access_requests WHERE streamer_id = ? OR user_id = ?', [id, id]);
    await tx.run('DELETE FROM notifications WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM notification_preferences WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM push_subscriptions WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM external_identities WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM security_events WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM message_reports WHERE reporter_id = ?', [id]);
    await tx.run(
      'UPDATE message_reports SET assigned_to = NULL WHERE assigned_to = ?',
      [id],
    );
    await tx.run(
      'DELETE FROM moderation_actions WHERE target_user_id = ? OR actor_id = ?',
      [id, id],
    );
    await tx.run('UPDATE users SET owner_streamer_id = NULL WHERE owner_streamer_id = ?', [id]);
    // Messages survive so conversations stay readable, but are anonymised.
    await tx.run(
      `UPDATE messages SET content = '', deleted_at = ?, deleted_by = ?
       WHERE author_id = ? AND deleted_at IS NULL`,
      [Date.now(), id, id],
    );
    await tx.run('DELETE FROM users WHERE id = ?', [id]);
  });
  await invalidateUser(id);
}

export async function touchLastSeen(id, presence) {
  const now = Date.now();
  if (presence) {
    await getDb().run('UPDATE users SET last_seen_at = ?, presence = ? WHERE id = ?', [now, presence, id]);
  } else {
    await getDb().run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now, id]);
  }
  await invalidateUser(id);
}

export async function countAdmins() {
  const row = await getDb().get(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1",
  );
  return Number(row?.count ?? 0);
}
