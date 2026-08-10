import { getDb, getReadDb, likeClause, likeValue } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound, badRequest } from '../lib/errors.js';
import { sanitizeText } from '../lib/validate.js';

const MENTION_PATTERN = /(?:^|[^\w@])@([a-z0-9._-]{3,32})/gi;

export function toMessage(row, extras = {}) {
  const deleted = Boolean(row.deleted_at);
  return {
    id: row.id,
    channelId: row.channel_id ?? null,
    conversationId: row.conversation_id ?? null,
    authorId: row.author_id,
    author: row.author_username
      ? {
          id: row.author_id,
          username: row.author_username,
          displayName: row.author_display_name,
          avatarUrl: row.author_avatar_url ?? null,
          bannerColor: row.author_banner_color ?? null,
          role: row.author_role ?? 'member',
        }
      : null,
    content: deleted ? '' : row.content,
    type: row.type,
    replyToId: row.reply_to_id ?? null,
    pinned: Boolean(row.pinned),
    createdAt: Number(row.created_at),
    editedAt: row.edited_at ? Number(row.edited_at) : null,
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    suppressEmbeds: Boolean(row.suppress_embeds),
    deleted,
    attachments: [],
    reactions: [],
    ...extras,
  };
}

const MESSAGE_SELECT = `
  m.*,
  u.username AS author_username,
  u.display_name AS author_display_name,
  u.avatar_url AS author_avatar_url,
  u.banner_color AS author_banner_color,
  u.role AS author_role,
  u.shadow_banned_at AS author_shadow_banned_at
`;

/** Resolves @username tokens to real user ids so mentions can be indexed. */
async function resolveMentions(content, scopeUserIds = null) {
  const names = new Set();
  let match;
  MENTION_PATTERN.lastIndex = 0;
  while ((match = MENTION_PATTERN.exec(content)) !== null) names.add(match[1].toLowerCase());
  if (!names.size) return [];

  const list = [...names].slice(0, 32);
  const placeholders = list.map(() => '?').join(', ');
  const rows = await getDb().all(
    `SELECT id FROM users WHERE username IN (${placeholders}) AND is_active = 1`,
    list,
  );
  const ids = rows.map((row) => row.id);
  return scopeUserIds ? ids.filter((id) => scopeUserIds.includes(id)) : ids;
}

export async function createMessage({
  channelId = null,
  conversationId = null,
  authorId,
  content,
  replyToId = null,
  attachmentIds = [],
  type = 'user',
  scopeUserIds = null,
  mentionUserIds = [],
  expiresAt = null,
  suppressEmbeds = false,
}) {
  if (!channelId && !conversationId) throw badRequest('A message needs a destination.');

  const db = getDb();
  const encrypted = type === 'encrypted';
  const clean = encrypted ? String(content).trim() : sanitizeText(content, 4000).trim();
  if (encrypted && (!conversationId || !/^e2ee:v1:[A-Za-z0-9_-]{20,65520}$/.test(clean))) {
    throw badRequest('Invalid encrypted message envelope.');
  }
  if (!clean && attachmentIds.length === 0) throw badRequest('Message cannot be empty.');

  if (replyToId) {
    const parent = await db.get(
      'SELECT id, channel_id, conversation_id FROM messages WHERE id = ?',
      [replyToId],
    );
    const sameTarget =
      parent &&
      (channelId ? parent.channel_id === channelId : parent.conversation_id === conversationId);
    if (!sameTarget) throw badRequest('You can only reply to a message in the same conversation.');
  }

  const id = newId();
  const now = Date.now();
  const resolvedMentions = encrypted ? [] : await resolveMentions(clean, scopeUserIds);
  const mentions = encrypted
    ? []
    : [...new Set([...resolvedMentions, ...mentionUserIds])].filter((userId) =>
        scopeUserIds ? scopeUserIds.includes(userId) : true,
      );
  const expressionAttachmentIds = encrypted
    ? []
    : [
        ...new Set(
          [...clean.matchAll(/<(?:(?:sticker|sound):[a-z0-9_]{2,32}|:[a-z0-9_]{2,32}):([a-zA-Z0-9_-]{8,64})>/gi)]
            .map((match) => match[1]),
        ),
      ].slice(0, 50);

  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO messages
         (id, channel_id, conversation_id, author_id, content, type, reply_to_id,
          created_at, expires_at, suppress_embeds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        channelId,
        conversationId,
        authorId,
        clean,
        type,
        replyToId,
        now,
        expiresAt,
        suppressEmbeds ? 1 : 0,
      ],
    );

    for (const mentionedId of mentions) {
      await tx.run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)', [id, mentionedId]);
    }
    for (const attachmentId of expressionAttachmentIds) {
      await tx.run(
        `INSERT INTO message_expressions (message_id, attachment_id)
         SELECT ?, attachment_id FROM group_expressions WHERE attachment_id = ?
         ON CONFLICT (message_id, attachment_id) DO NOTHING`,
        [id, attachmentId],
      );
    }

    for (const attachmentId of attachmentIds.slice(0, 10)) {
      // Only claim attachments the author uploaded and has not attached yet —
      // otherwise a user could steal someone else's uploaded file.
      await tx.run(
        'UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL',
        [id, attachmentId, authorId],
      );
    }
  });

  return hydrateMessage(id);
}

export async function hydrateMessage(messageId, viewerId = null) {
  const db = getDb();
  const row = await db.get(
    `SELECT ${MESSAGE_SELECT} FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
    [messageId],
  );
  if (!row) return null;
  const [message] = await attachExtras([row], viewerId);
  return message;
}

/** Loads attachments, reactions and reply previews for a page of messages. */
async function attachExtras(rows, viewerId = null) {
  if (!rows.length) return [];
  const db = getDb();
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  const attachmentRows = await db.all(
    `SELECT * FROM attachments WHERE message_id IN (${placeholders})`,
    ids,
  );
  const reactionRows = await db.all(
    `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${placeholders})`,
    ids,
  );
  const mentionRows = await db.all(
    `SELECT message_id, user_id FROM mentions WHERE message_id IN (${placeholders})`,
    ids,
  );
  const threadRows = await db.all(
    `SELECT reply_to_id AS message_id, COUNT(*) AS count
     FROM messages
     WHERE reply_to_id IN (${placeholders}) AND deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
     GROUP BY reply_to_id`,
    [...ids, Date.now()],
  );
  const pollRows = await db.all(
    `SELECT p.*, po.id AS option_id, po.label AS option_label, po.position,
            po.is_correct AS option_correct,
            pv.user_id AS vote_user_id
     FROM polls p
     JOIN poll_options po ON po.poll_id = p.id
     LEFT JOIN poll_votes pv ON pv.poll_id = p.id AND pv.option_id = po.id
     WHERE p.message_id IN (${placeholders})
     ORDER BY po.position ASC`,
    ids,
  );

  const replyIds = rows.map((row) => row.reply_to_id).filter(Boolean);
  let replyMap = new Map();
  if (replyIds.length) {
    const replyPlaceholders = replyIds.map(() => '?').join(', ');
    const replyRows = await db.all(
      `SELECT m.id, m.content, m.type, m.author_id, m.conversation_id, m.deleted_at,
              u.username, u.display_name
       FROM messages m JOIN users u ON u.id = m.author_id
       WHERE m.id IN (${replyPlaceholders})`,
      replyIds,
    );
    replyMap = new Map(
      replyRows.map((row) => [
        row.id,
        {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          preview: row.deleted_at ? 'Message deleted' : row.type === 'encrypted' ? 'Encrypted message' : String(row.content).slice(0, 160),
          encrypted: !row.deleted_at && row.type === 'encrypted',
          encryptedContent: !row.deleted_at && row.type === 'encrypted' ? row.content : null,
          authorId: row.author_id,
          conversationId: row.conversation_id ?? null,
        },
      ]),
    );
  }

  const attachmentsBy = groupBy(attachmentRows, 'message_id');
  const reactionsBy = groupBy(reactionRows, 'message_id');
  const mentionsBy = groupBy(mentionRows, 'message_id');
  const threadCounts = new Map(threadRows.map((row) => [row.message_id, Number(row.count)]));
  const pollsByMessage = buildPolls(pollRows, viewerId);

  return rows.map((row) =>
    toMessage(row, {
      attachments: (attachmentsBy.get(row.id) ?? []).map(toAttachment),
      reactions: summariseReactions(reactionsBy.get(row.id) ?? []),
      mentionedUserIds: (mentionsBy.get(row.id) ?? []).map((mention) => mention.user_id),
      replyTo: row.reply_to_id ? replyMap.get(row.reply_to_id) ?? null : null,
      threadReplyCount: threadCounts.get(row.id) ?? 0,
      poll: pollsByMessage.get(row.id) ?? null,
    }),
  );
}

function buildPolls(rows, viewerId = null) {
  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.message_id)) {
      byMessage.set(row.message_id, {
        id: row.id,
        creatorId: row.creator_id ?? null,
        question: row.question,
        multiple: Boolean(row.multiple),
        anonymous: Boolean(row.anonymous),
        examMode: Boolean(row.exam_mode),
        closesAt: row.closes_at ? Number(row.closes_at) : null,
        closed: Boolean(row.closes_at && Number(row.closes_at) <= Date.now()),
        viewerOptionIds: [],
        correctOptionIds: [],
        options: [],
      });
    }
    const poll = byMessage.get(row.message_id);
    let option = poll.options.find((item) => item.id === row.option_id);
    if (!option) {
      option = { id: row.option_id, label: row.option_label, votes: 0, userIds: [], correct: Boolean(row.option_correct) };
      poll.options.push(option);
    }
    if (row.vote_user_id) {
      option.votes += 1;
      if (!poll.anonymous) option.userIds.push(row.vote_user_id);
      if (viewerId && row.vote_user_id === viewerId) poll.viewerOptionIds.push(row.option_id);
    }
  }
  for (const poll of byMessage.values()) {
    const mayRevealAnswers = poll.closed || viewerId === poll.creatorId || poll.viewerOptionIds.length > 0;
    if (poll.examMode && mayRevealAnswers) {
      poll.correctOptionIds = poll.options.filter((option) => option.correct).map((option) => option.id);
    }
    for (const option of poll.options) delete option.correct;
  }
  return byMessage;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

function summariseReactions(rows) {
  const byEmoji = new Map();
  for (const row of rows) {
    if (!byEmoji.has(row.emoji)) byEmoji.set(row.emoji, []);
    byEmoji.get(row.emoji).push(row.user_id);
  }
  return [...byEmoji.entries()].map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
  }));
}

export function toAttachment(row) {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size),
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    durationMs: row.duration_ms ? Number(row.duration_ms) : null,
    kind: row.kind ?? 'file',
    url: `/api/files/${row.id}`,
    previewUrl: row.preview_key ? `/api/files/${row.id}/preview` : null,
    processingStatus: row.processing_status ?? 'complete',
    scanStatus: row.scan_status ?? 'unknown',
    createdAt: Number(row.created_at),
  };
}

/**
 * Cursor pagination. Ids are time-sortable, so `id < before` walks backwards
 * through history without OFFSET scans.
 */
export async function listMessages({
  channelId = null,
  conversationId = null,
  before,
  after,
  limit = 50,
  viewerId = null,
}) {
  const db = getDb();
  const clauses = [channelId ? 'm.channel_id = ?' : 'm.conversation_id = ?'];
  const params = [channelId ?? conversationId];

  if (before) {
    clauses.push('m.id < ?');
    params.push(before);
  }
  if (after) {
    clauses.push('m.id > ?');
    params.push(after);
  }
  if (viewerId) {
    clauses.push('(u.shadow_banned_at IS NULL OR m.author_id = ?)');
    params.push(viewerId);
  }
  clauses.push('(m.expires_at IS NULL OR m.expires_at > ?)');
  params.push(Date.now());
  params.push(limit);

  const rows = await db.all(
    `SELECT ${MESSAGE_SELECT} FROM messages m JOIN users u ON u.id = m.author_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY m.id ${after ? 'ASC' : 'DESC'}
     LIMIT ?`,
    params,
  );

  const ordered = after ? rows : rows.reverse();
  return attachExtras(ordered, viewerId);
}

export async function getMessage(messageId) {
  return getDb().get('SELECT * FROM messages WHERE id = ?', [messageId]);
}

export async function editMessage(messageId, content) {
  const clean = sanitizeText(content, 4000).trim();
  if (!clean) throw badRequest('Message cannot be empty.');

  const db = getDb();
  const now = Date.now();
  await db.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [clean, now, messageId]);

  await db.run('DELETE FROM mentions WHERE message_id = ?', [messageId]);
  for (const userId of await resolveMentions(clean)) {
    await db.run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)', [messageId, userId]);
  }

  return hydrateMessage(messageId);
}

/** Soft delete: the row stays so replies keep their anchor. */
export async function deleteMessage(messageId, deletedBy) {
  const db = getDb();
  const row = await getMessage(messageId);
  if (!row) throw notFound('Message not found.');

  await db.tx(async (tx) => {
    await tx.run(
      "UPDATE messages SET content = '', deleted_at = ?, deleted_by = ?, pinned = 0 WHERE id = ?",
      [Date.now(), deletedBy, messageId],
    );
    await tx.run('DELETE FROM reactions WHERE message_id = ?', [messageId]);
    await tx.run('DELETE FROM mentions WHERE message_id = ?', [messageId]);
  });

  // Attachment rows are removed by the caller, which also unlinks the files.
  return row;
}

export async function listAttachmentsForMessage(messageId) {
  return getDb().all('SELECT * FROM attachments WHERE message_id = ?', [messageId]);
}

export async function toggleReaction({ messageId, userId, emoji }) {
  const db = getDb();
  const existing = await db.get(
    'SELECT 1 AS ok FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
    [messageId, userId, emoji],
  );

  if (existing) {
    await db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [
      messageId,
      userId,
      emoji,
    ]);
  } else {
    const count = await db.get('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ?', [
      messageId,
    ]);
    if (Number(count?.count ?? 0) >= 200) throw badRequest('This message has too many reactions.');
    await db.run(
      'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      [messageId, userId, emoji, Date.now()],
    );
  }

  const rows = await db.all('SELECT message_id, emoji, user_id FROM reactions WHERE message_id = ?', [
    messageId,
  ]);
  return { added: !existing, reactions: summariseReactions(rows) };
}

export async function setPinned(messageId, pinned) {
  await getDb().run('UPDATE messages SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, messageId]);
  return hydrateMessage(messageId);
}

export async function listPinned({ channelId = null, conversationId = null }) {
  const rows = await getDb().all(
    `SELECT ${MESSAGE_SELECT} FROM messages m JOIN users u ON u.id = m.author_id
     WHERE ${channelId ? 'm.channel_id = ?' : 'm.conversation_id = ?'}
       AND m.pinned = 1 AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY m.id DESC LIMIT 50`,
    [channelId ?? conversationId, Date.now()],
  );
  return attachExtras(rows);
}

/**
 * Full-text-ish search over the targets a user can actually read. Scoping is
 * done by the caller passing the id lists it has already authorised.
 */
export async function searchMessages({
  term,
  channelIds = [],
  conversationIds = [],
  limit = 40,
  viewerId = null,
}) {
  if (!term || (!channelIds.length && !conversationIds.length)) return [];

  const scopes = [];
  const params = [likeValue(term)];

  if (channelIds.length) {
    scopes.push(`m.channel_id IN (${channelIds.map(() => '?').join(', ')})`);
    params.push(...channelIds);
  }
  if (conversationIds.length) {
    scopes.push(`m.conversation_id IN (${conversationIds.map(() => '?').join(', ')})`);
    params.push(...conversationIds);
  }
  params.push(Date.now());
  if (viewerId) params.push(viewerId);
  params.push(limit);

  const rows = await getReadDb().all(
    `SELECT ${MESSAGE_SELECT} FROM messages m JOIN users u ON u.id = m.author_id
     WHERE ${likeClause('m.content')} AND m.deleted_at IS NULL AND (${scopes.join(' OR ')})
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       ${viewerId ? 'AND (u.shadow_banned_at IS NULL OR m.author_id = ?)' : ''}
     ORDER BY m.id DESC LIMIT ?`,
    params,
  );
  return attachExtras(rows, viewerId);
}

// -------------------------------------------------------------- read states

export async function markRead({ userId, targetType, targetId, messageId = null }) {
  await getDb().run(
    `INSERT INTO read_states (user_id, target_type, target_id, last_read_message_id, last_read_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, target_type, target_id)
     DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
                   last_read_at = excluded.last_read_at`,
    [userId, targetType, targetId, messageId, Date.now()],
  );
}

/**
 * Unread counts for everything the user can see, in one round trip per target
 * type. Mention counts are tracked separately so the UI can show a red badge.
 */
export async function getUnreadSummary(userId) {
  const db = getDb();

  const channelRows = await db.all(
    `SELECT c.id AS target_id, c.group_id,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.author_id <> ?
           AND (r.last_read_message_id IS NULL OR m.id > r.last_read_message_id)) AS unread,
       (SELECT COUNT(*) FROM messages m JOIN mentions mn ON mn.message_id = m.id
         WHERE m.channel_id = c.id AND mn.user_id = ? AND m.deleted_at IS NULL
           AND (r.last_read_message_id IS NULL OR m.id > r.last_read_message_id)) AS mentions
     FROM channels c
     JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = ?
     LEFT JOIN read_states r ON r.user_id = ? AND r.target_type = 'channel' AND r.target_id = c.id`,
    [userId, userId, userId, userId],
  );

  const conversationRows = await db.all(
    `SELECT cm.conversation_id AS target_id,
       (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = cm.conversation_id AND m.deleted_at IS NULL AND m.author_id <> ?
           AND (r.last_read_message_id IS NULL OR m.id > r.last_read_message_id)) AS unread
     FROM conversation_members cm
     LEFT JOIN read_states r ON r.user_id = ? AND r.target_type = 'conversation'
       AND r.target_id = cm.conversation_id
     WHERE cm.user_id = ? AND cm.closed = 0`,
    [userId, userId, userId],
  );

  return {
    channels: channelRows.map((row) => ({
      id: row.target_id,
      groupId: row.group_id,
      unread: Number(row.unread ?? 0),
      mentions: Number(row.mentions ?? 0),
    })),
    conversations: conversationRows.map((row) => ({
      id: row.target_id,
      unread: Number(row.unread ?? 0),
      mentions: Number(row.unread ?? 0) > 0 ? Number(row.unread) : 0,
    })),
  };
}
