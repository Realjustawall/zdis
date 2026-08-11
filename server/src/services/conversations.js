import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { toPublicUser } from './users.js';
import { isBlocked } from './permissions.js';
import { getSettings } from './settings.js';
import { provisionE2eeIdentities } from './e2eeKeys.js';

/**
 * Direct messages. A 1:1 DM is keyed on the sorted pair of user ids so the
 * same two people always land in the same conversation. Group DMs (3+) are
 * created explicitly and have no key.
 */
const dmKeyFor = (a, b) => [a, b].sort().join(':');

export function toConversation(row, extra = {}) {
  return {
    id: row.id,
    type: row.type,
    name: row.name ?? null,
    iconUrl: row.icon_url ?? null,
    ownerId: row.owner_id ?? null,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...extra,
  };
}

function toLastMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    preview: row.type === 'encrypted' ? 'Encrypted message' : String(row.content).slice(0, 120),
    encrypted: row.type === 'encrypted',
    encryptedContent: row.type === 'encrypted' ? row.content : null,
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: Number(row.created_at),
  };
}

export async function getConversationLastMessage(conversationId) {
  const row = await getDb().get(
    `SELECT m.id, m.content, m.type, m.author_id, m.created_at,
            u.display_name AS author_name
     FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.conversation_id = ? AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 1`,
    [conversationId, Date.now()],
  );
  return toLastMessage(row);
}

export async function syncConversationAfterMessageDeletion(conversationId) {
  const db = getDb();
  await db.run(
    `UPDATE conversations
     SET updated_at = COALESCE(
       (SELECT MAX(created_at) FROM messages
        WHERE conversation_id = ? AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)),
       created_at
     )
     WHERE id = ?`,
    [conversationId, Date.now(), conversationId],
  );
  const [conversation, lastMessage] = await Promise.all([
    db.get('SELECT updated_at FROM conversations WHERE id = ?', [conversationId]),
    getConversationLastMessage(conversationId),
  ]);
  return { updatedAt: Number(conversation?.updated_at ?? 0), lastMessage };
}

export async function openDirectMessage(userId, otherUserId) {
  if (userId === otherUserId) throw badRequest('You cannot open a DM with yourself.');

  const settings = await getSettings();
  if (!settings.allow_dms) throw forbidden('Direct messages are disabled on this server.');

  const db = getDb();
  const other = await db.get('SELECT id, is_active FROM users WHERE id = ?', [otherUserId]);
  if (!other) throw notFound('User not found.');
  if (!other.is_active) throw badRequest('That account is disabled.');
  if (await isBlocked(userId, otherUserId)) throw forbidden('You cannot message this user.');
  await provisionE2eeIdentities([userId, otherUserId]);

  const key = dmKeyFor(userId, otherUserId);
  const existing = await db.get('SELECT * FROM conversations WHERE dm_key = ?', [key]);
  if (existing) {
    // Re-open it for whoever had hidden it.
    await db.run(
      'UPDATE conversation_members SET closed = 0 WHERE conversation_id = ? AND user_id = ?',
      [existing.id, userId],
    );
    return existing;
  }

  const id = newId();
  const now = Date.now();
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO conversations (id, type, dm_key, created_by, created_at, updated_at)
       VALUES (?, 'dm', ?, ?, ?, ?)`,
      [id, key, userId, now, now],
    );
    for (const member of [userId, otherUserId]) {
      await tx.run(
        'INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
        [id, member, now],
      );
    }
  });

  return db.get('SELECT * FROM conversations WHERE id = ?', [id]);
}

export async function createGroupDm({ creatorId, memberIds, name = null }) {
  const settings = await getSettings();
  if (!settings.allow_group_dms) throw forbidden('Group DMs are disabled on this server.');

  const db = getDb();
  const unique = [...new Set([creatorId, ...memberIds])];
  if (unique.length < 3) throw badRequest('A group DM needs at least three people.');
  if (unique.length > 25) throw badRequest('A group DM can hold at most 25 people.');

  const placeholders = unique.map(() => '?').join(', ');
  const found = await db.all(
    `SELECT id FROM users WHERE id IN (${placeholders}) AND is_active = 1`,
    unique,
  );
  if (found.length !== unique.length) throw badRequest('One or more selected users are unavailable.');
  await provisionE2eeIdentities(unique);

  const id = newId();
  const now = Date.now();
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO conversations (id, type, name, owner_id, created_by, created_at, updated_at)
       VALUES (?, 'group_dm', ?, ?, ?, ?, ?)`,
      [id, name, creatorId, creatorId, now, now],
    );
    for (const member of unique) {
      await tx.run(
        'INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
        [id, member, now],
      );
    }
  });

  return db.get('SELECT * FROM conversations WHERE id = ?', [id]);
}

export async function listConversations(userId) {
  const db = getDb();
  const rows = await db.all(
    `SELECT c.*, cm.closed
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE cm.user_id = ? AND cm.closed = 0
     ORDER BY c.updated_at DESC`,
    [userId],
  );
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const memberRows = await db.all(
    `SELECT cm.conversation_id, u.id, u.username, u.display_name, u.avatar_url, u.banner_color,
       u.bio, u.presence, u.custom_status, u.is_active, u.last_seen_at, u.created_at, u.role
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id IN (${placeholders})`,
    ids,
  );

  const byConversation = new Map();
  for (const row of memberRows) {
    if (!byConversation.has(row.conversation_id)) byConversation.set(row.conversation_id, []);
    byConversation.get(row.conversation_id).push(toPublicUser(row));
  }

  const now = Date.now();
  const lastRows = await db.all(
    `SELECT m.conversation_id, m.id, m.content, m.type, m.author_id, m.created_at,
            u.display_name AS author_name
     FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.conversation_id IN (${placeholders})
       AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       AND m.id = (
         SELECT MAX(id) FROM messages
         WHERE conversation_id = m.conversation_id AND deleted_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
       )`,
    [...ids, now, now],
  );
  const lastByConversation = new Map(lastRows.map((row) => [row.conversation_id, row]));

  return rows.map((row) => {
    const members = byConversation.get(row.id) ?? [];
    const last = lastByConversation.get(row.id);
    return toConversation(row, {
      updatedAt: last ? Number(last.created_at) : Number(row.created_at),
      members,
      otherMembers: members.filter((m) => m.id !== userId),
      lastMessage: toLastMessage(last),
    });
  });
}

export async function getConversation(conversationId) {
  return getDb().get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
}

export async function getConversationMembers(conversationId) {
  const rows = await getDb().all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.banner_color, u.bio,
       u.presence, u.custom_status, u.is_active, u.last_seen_at, u.created_at, u.role
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ?`,
    [conversationId],
  );
  return rows.map(toPublicUser);
}

export async function getConversationMemberIds(conversationId) {
  const rows = await getDb().all(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
    [conversationId],
  );
  return rows.map((row) => row.user_id);
}

export async function closeConversation(conversationId, userId) {
  await getDb().run(
    'UPDATE conversation_members SET closed = 1 WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId],
  );
}

export async function touchConversation(conversationId) {
  await getDb().run('UPDATE conversations SET updated_at = ? WHERE id = ?', [
    Date.now(),
    conversationId,
  ]);
}

export async function addToGroupDm(conversationId, userId) {
  const db = getDb();
  const conversation = await getConversation(conversationId);
  if (!conversation) throw notFound('Conversation not found.');
  if (conversation.type !== 'group_dm') throw badRequest('You cannot add people to a 1:1 DM.');

  const count = await db.get(
    'SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ?',
    [conversationId],
  );
  if (Number(count?.count ?? 0) >= 25) throw badRequest('This group DM is full.');

  await db.run(
    `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET closed = 0`,
    [conversationId, userId, Date.now()],
  );
}

export async function leaveGroupDm(conversationId, userId) {
  await getDb().run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [
    conversationId,
    userId,
  ]);
}
