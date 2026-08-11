import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { sanitizeText } from '../lib/validate.js';
import { createMessage, hydrateMessage } from './messages.js';

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveDraft({
  userId,
  targetType,
  targetId,
  content,
  replyToId = null,
  attachmentIds = [],
}) {
  const now = Date.now();
  await getDb().run(
    `INSERT INTO message_drafts
       (user_id, target_type, target_id, content, reply_to_id, attachment_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, target_type, target_id)
     DO UPDATE SET content = excluded.content, reply_to_id = excluded.reply_to_id,
                   attachment_ids = excluded.attachment_ids, updated_at = excluded.updated_at`,
    [
      userId,
      targetType,
      targetId,
      sanitizeText(content ?? '', 4000),
      replyToId,
      JSON.stringify(attachmentIds.slice(0, 10)),
      now,
    ],
  );
  return getDraft(userId, targetType, targetId);
}

export async function getDraft(userId, targetType, targetId) {
  const row = await getDb().get(
    `SELECT * FROM message_drafts
     WHERE user_id = ? AND target_type = ? AND target_id = ?`,
    [userId, targetType, targetId],
  );
  return row
    ? {
        content: row.content,
        replyToId: row.reply_to_id ?? null,
        attachmentIds: jsonArray(row.attachment_ids),
        updatedAt: Number(row.updated_at),
      }
    : null;
}

export async function deleteDraft(userId, targetType, targetId) {
  await getDb().run(
    'DELETE FROM message_drafts WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [userId, targetType, targetId],
  );
}

export async function scheduleMessage({
  userId,
  targetType,
  targetId,
  content,
  replyToId = null,
  attachmentIds = [],
  encrypted = false,
  sendAt,
  expiresAt = null,
}) {
  const now = Date.now();
  if (sendAt < now + 5_000) throw badRequest('Scheduled time must be at least 5 seconds ahead.');
  if (sendAt > now + 365 * 24 * 3600_000) {
    throw badRequest('Messages cannot be scheduled more than one year ahead.');
  }
  if (expiresAt && expiresAt <= sendAt) {
    throw badRequest('Expiry must be after the scheduled delivery time.');
  }
  const clean = encrypted ? String(content ?? '').trim() : sanitizeText(content ?? '', 4000).trim();
  if (encrypted && !/^e2ee:v1:[A-Za-z0-9_-]{20,65520}$/.test(clean)) {
    throw badRequest('Invalid encrypted message envelope.');
  }
  if (!clean && !attachmentIds.length) throw badRequest('Message cannot be empty.');
  const id = newId();
  await getDb().run(
    `INSERT INTO scheduled_messages
       (id, user_id, target_type, target_id, content, reply_to_id, attachment_ids,
        encrypted, send_at, expires_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    [
      id,
      userId,
      targetType,
      targetId,
      clean,
      replyToId,
      JSON.stringify(attachmentIds.slice(0, 10)),
      encrypted ? 1 : 0,
      sendAt,
      expiresAt,
      now,
      now,
    ],
  );
  return getScheduledMessage(id, userId);
}

export async function getScheduledMessage(id, userId = null) {
  const row = await getDb().get(
    `SELECT * FROM scheduled_messages WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`,
    userId ? [id, userId] : [id],
  );
  return row ? toScheduled(row) : null;
}

export async function listScheduledMessages(userId) {
  const rows = await getDb().all(
    `SELECT * FROM scheduled_messages
     WHERE user_id = ? AND status IN ('scheduled', 'processing', 'failed')
     ORDER BY send_at ASC LIMIT 100`,
    [userId],
  );
  return rows.map(toScheduled);
}

function toScheduled(row) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    content: row.content,
    replyToId: row.reply_to_id ?? null,
    attachmentIds: jsonArray(row.attachment_ids),
    encrypted: Boolean(row.encrypted),
    sendAt: Number(row.send_at),
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    status: row.status,
    messageId: row.message_id ?? null,
    attempts: Number(row.attempts ?? 0),
    error: row.error ?? null,
    createdAt: Number(row.created_at),
  };
}

export async function cancelScheduledMessage(id, userId) {
  const result = await getDb().run(
    `UPDATE scheduled_messages SET status = 'cancelled', updated_at = ?
     WHERE id = ? AND user_id = ? AND status = 'scheduled'`,
    [Date.now(), id, userId],
  );
  if (!result.changes) throw notFound('Scheduled message not found.');
}

export async function publishScheduledMessage(id) {
  const db = getDb();
  const claimed = await db.run(
    `UPDATE scheduled_messages
     SET status = 'processing', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'scheduled' AND send_at <= ?`,
    [Date.now(), id, Date.now() + 2_000],
  );
  if (!claimed.changes) return { skipped: true };

  const row = await db.get('SELECT * FROM scheduled_messages WHERE id = ?', [id]);
  try {
    const author = await db.get(
      `SELECT id FROM users
       WHERE id = ? AND is_active = 1 AND banned_at IS NULL
         AND (suspended_until IS NULL OR suspended_until <= ?)`,
      [row.user_id, Date.now()],
    );
    if (!author) throw new Error('Author is no longer allowed to send messages.');

    const scopeRows =
      row.target_type === 'conversation'
        ? await db.all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [
            row.target_id,
          ])
        : await db.all(
            `SELECT gm.user_id FROM channels c
             JOIN group_members gm ON gm.group_id = c.group_id
             WHERE c.id = ?`,
            [row.target_id],
          );
    if (!scopeRows.some((item) => item.user_id === row.user_id)) {
      throw new Error('Author no longer has access to the destination.');
    }

    const message = await createMessage({
      channelId: row.target_type === 'channel' ? row.target_id : null,
      conversationId: row.target_type === 'conversation' ? row.target_id : null,
      authorId: row.user_id,
      content: row.content,
      replyToId: row.reply_to_id,
      attachmentIds: jsonArray(row.attachment_ids),
      scopeUserIds: scopeRows.map((item) => item.user_id),
      expiresAt: row.expires_at,
      type: row.encrypted ? 'encrypted' : 'user',
    });
    await db.run(
      `UPDATE scheduled_messages
       SET status = 'sent', message_id = ?, error = NULL, updated_at = ? WHERE id = ?`,
      [message.id, Date.now(), id],
    );
    return { message };
  } catch (error) {
    await db.run(
      `UPDATE scheduled_messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      [String(error.message).slice(0, 500), Date.now(), id],
    );
    throw error;
  }
}

export async function publishDueScheduledMessages(limit = 100) {
  const rows = await getDb().all(
    `SELECT id FROM scheduled_messages
     WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT ?`,
    [Date.now(), limit],
  );
  const results = [];
  for (const row of rows) results.push(await publishScheduledMessage(row.id));
  return results;
}

export async function createPoll({
  messageId,
  creatorId,
  question,
  options,
  multiple = false,
  anonymous = false,
  examMode = false,
  correctOptionIndexes = [],
  closesAt = null,
}) {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  const cleanOptions = options.map((option) => sanitizeText(option, 120).trim());
  if (new Set(cleanOptions.map((option) => option.toLowerCase())).size !== cleanOptions.length) {
    throw badRequest('Poll options must be unique.');
  }
  const cleanQuestion = sanitizeText(question, 300).trim();
  if (!cleanQuestion) throw badRequest('Poll question cannot be empty.');
  if (cleanOptions.length < 2 || cleanOptions.length > 10) {
    throw badRequest('A poll needs between 2 and 10 options.');
  }
  if (examMode && (multiple || correctOptionIndexes.length !== 1 || correctOptionIndexes[0] < 0 || correctOptionIndexes[0] >= cleanOptions.length)) {
    throw badRequest('Exam mode requires exactly one correct answer and does not allow multiple choice.');
  }
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO polls
         (id, message_id, creator_id, question, multiple, anonymous, exam_mode, closes_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, messageId, creatorId, cleanQuestion, multiple, anonymous, examMode, closesAt, now, now],
    );
    for (let position = 0; position < cleanOptions.length; position += 1) {
      await tx.run(
        `INSERT INTO poll_options (id, poll_id, label, position, is_correct, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), id, cleanOptions[position], position, examMode && correctOptionIndexes.includes(position), now],
      );
    }
  });
  return hydrateMessage(messageId, creatorId);
}

export async function updatePoll({ messageId, creatorId, question, options, multiple, anonymous, examMode = false, correctOptionIndexes = [], closesAt }) {
  const db = getDb();
  const poll = await db.get(
    `SELECT p.*, m.author_id FROM polls p JOIN messages m ON m.id = p.message_id
     WHERE p.message_id = ?`,
    [messageId],
  );
  if (!poll) throw notFound('Poll not found.');
  if (poll.author_id !== creatorId && poll.creator_id !== creatorId) {
    throw badRequest('Only the person who created this poll can edit it.');
  }
  if (poll.closes_at && Number(poll.closes_at) <= Date.now()) throw badRequest('This poll is closed.');
  const cleanQuestion = sanitizeText(question, 300).trim();
  const cleanOptions = options.map((option) => sanitizeText(option, 120).trim());
  if (!cleanQuestion || cleanOptions.length < 2 || cleanOptions.length > 10 || cleanOptions.some((item) => !item)) {
    throw badRequest('A poll needs a question and between 2 and 10 options.');
  }
  if (new Set(cleanOptions.map((item) => item.toLowerCase())).size !== cleanOptions.length) {
    throw badRequest('Poll options must be unique.');
  }
  if (examMode && (multiple || correctOptionIndexes.length !== 1 || correctOptionIndexes[0] < 0 || correctOptionIndexes[0] >= cleanOptions.length)) {
    throw badRequest('Exam mode requires exactly one correct answer and does not allow multiple choice.');
  }
  const existing = await db.all('SELECT id FROM poll_options WHERE poll_id = ? ORDER BY position ASC', [poll.id]);
  const now = Date.now();
  await db.tx(async (tx) => {
    await tx.run(
      `UPDATE polls SET question = ?, multiple = ?, anonymous = ?, exam_mode = ?, closes_at = ?, updated_at = ? WHERE id = ?`,
      [cleanQuestion, multiple, anonymous, examMode, closesAt, now, poll.id],
    );
    await tx.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [cleanQuestion, now, messageId]);
    for (let position = 0; position < cleanOptions.length; position += 1) {
      if (existing[position]) {
        await tx.run('UPDATE poll_options SET label = ?, is_correct = ? WHERE id = ?', [cleanOptions[position], examMode && correctOptionIndexes.includes(position), existing[position].id]);
      } else {
        await tx.run(
          `INSERT INTO poll_options (id, poll_id, label, position, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [newId(), poll.id, cleanOptions[position], position, examMode && correctOptionIndexes.includes(position), now],
        );
      }
    }
    if (existing.length > cleanOptions.length) {
      await tx.run(
        `DELETE FROM poll_options WHERE poll_id = ? AND position >= ?`,
        [poll.id, cleanOptions.length],
      );
    }
  });
  return hydrateMessage(messageId, creatorId);
}

export async function votePoll({ messageId, userId, optionIds }) {
  const db = getDb();
  const poll = await db.get('SELECT * FROM polls WHERE message_id = ?', [messageId]);
  if (!poll) throw notFound('Poll not found.');
  if (poll.closes_at && Number(poll.closes_at) <= Date.now()) throw badRequest('This poll is closed.');
  const uniqueIds = [...new Set(optionIds)];
  if (poll.exam_mode) {
    const previous = await db.get('SELECT 1 AS ok FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, userId]);
    if (previous) throw badRequest('Exam answers can only be submitted once.');
    if (uniqueIds.length !== 1) throw badRequest('Select one answer for this exam.');
  }
  if (!poll.multiple && uniqueIds.length > 1) {
    throw badRequest('This poll accepts one option only.');
  }
  const rows = uniqueIds.length
    ? await db.all(
        `SELECT id FROM poll_options
         WHERE poll_id = ? AND id IN (${uniqueIds.map(() => '?').join(', ')})`,
        [poll.id, ...uniqueIds],
      )
    : [];
  if (rows.length !== uniqueIds.length) throw badRequest('Invalid poll option.');

  await db.tx(async (tx) => {
    await tx.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, userId]);
    for (const optionId of uniqueIds) {
      await tx.run(
        `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
        [poll.id, optionId, userId, Date.now()],
      );
    }
  });
  return hydrateMessage(messageId, userId);
}

async function creatorPoll(messageId, creatorId) {
  const poll = await getDb().get(
    `SELECT p.*, m.author_id, m.channel_id, m.conversation_id
     FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = ?`,
    [messageId],
  );
  if (!poll) throw notFound('Poll not found.');
  if (poll.creator_id !== creatorId && poll.author_id !== creatorId) {
    throw notFound('Poll analytics are available only to its creator.');
  }
  return poll;
}

export async function getPollAnalytics({ messageId, creatorId }) {
  const db = getDb();
  const poll = await creatorPoll(messageId, creatorId);
  const [options, votes, eligible] = await Promise.all([
    db.all('SELECT id, label, position, is_correct FROM poll_options WHERE poll_id = ? ORDER BY position ASC', [poll.id]),
    db.all(
      `SELECT pv.option_id, pv.user_id, pv.created_at, u.username, u.display_name, u.avatar_url
       FROM poll_votes pv JOIN users u ON u.id = pv.user_id
       WHERE pv.poll_id = ? ORDER BY pv.created_at DESC`,
      [poll.id],
    ),
    poll.channel_id
      ? db.get(
          `SELECT COUNT(*) AS count FROM group_members gm JOIN channels c ON c.group_id = gm.group_id WHERE c.id = ?`,
          [poll.channel_id],
        )
      : db.get('SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ?', [poll.conversation_id]),
  ]);
  const uniqueVoterIds = new Set(votes.map((vote) => vote.user_id));
  const totalSelections = votes.length;
  const optionStats = options.map((option) => {
    const optionVotes = votes.filter((vote) => vote.option_id === option.id);
    return {
      id: option.id,
      label: option.label,
      position: Number(option.position),
      votes: optionVotes.length,
      percentage: totalSelections ? Math.round((optionVotes.length / totalSelections) * 1000) / 10 : 0,
      correct: Boolean(option.is_correct),
      voters: poll.anonymous
        ? []
        : optionVotes.map((vote) => ({
            id: vote.user_id,
            username: vote.username,
            displayName: vote.display_name,
            avatarUrl: vote.avatar_url ?? null,
            votedAt: Number(vote.created_at),
          })),
    };
  });
  const leadingVotes = Math.max(0, ...optionStats.map((option) => option.votes));
  const correctAnswers = poll.exam_mode ? votes.filter((vote) => options.some((option) => option.id === vote.option_id && option.is_correct)).length : 0;
  const eligibleVoters = Number(eligible?.count ?? 0);
  const now = Date.now();
  const hourMs = 60 * 60_000;
  const activity = Array.from({ length: 12 }, (_, index) => {
    const start = now - (11 - index) * hourMs;
    const end = start + hourMs;
    return {
      at: start,
      votes: votes.filter((vote) => Number(vote.created_at) >= start && Number(vote.created_at) < end).length,
    };
  });
  return {
    pollId: poll.id,
    messageId,
    question: poll.question,
    anonymous: Boolean(poll.anonymous),
    multiple: Boolean(poll.multiple),
    examMode: Boolean(poll.exam_mode),
    createdAt: Number(poll.created_at),
    updatedAt: Number(poll.updated_at ?? poll.created_at),
    closesAt: poll.closes_at ? Number(poll.closes_at) : null,
    closed: Boolean(poll.closes_at && Number(poll.closes_at) <= now),
    totalSelections,
    uniqueVoters: uniqueVoterIds.size,
    eligibleVoters,
    participationRate: eligibleVoters ? Math.round((uniqueVoterIds.size / eligibleVoters) * 1000) / 10 : 0,
    correctAnswers,
    accuracyRate: poll.exam_mode && uniqueVoterIds.size ? Math.round((correctAnswers / uniqueVoterIds.size) * 1000) / 10 : 0,
    leadingOptionIds: optionStats.filter((option) => leadingVotes > 0 && option.votes === leadingVotes).map((option) => option.id),
    options: optionStats,
    activity,
    recentVotes: poll.anonymous
      ? []
      : votes.slice(0, 20).map((vote) => ({
          userId: vote.user_id,
          username: vote.username,
          displayName: vote.display_name,
          avatarUrl: vote.avatar_url ?? null,
          optionId: vote.option_id,
          votedAt: Number(vote.created_at),
        })),
  };
}

export async function closePoll({ messageId, creatorId }) {
  const poll = await creatorPoll(messageId, creatorId);
  if (poll.closes_at && Number(poll.closes_at) <= Date.now()) return hydrateMessage(messageId, creatorId);
  const now = Date.now();
  await getDb().run('UPDATE polls SET closes_at = ?, updated_at = ? WHERE id = ?', [now, now, poll.id]);
  return hydrateMessage(messageId, creatorId);
}

export async function saveMessage(userId, messageId) {
  await getDb().run(
    `INSERT INTO saved_messages (user_id, message_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userId, messageId, Date.now()],
  );
}

export async function unsaveMessage(userId, messageId) {
  await getDb().run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', [
    userId,
    messageId,
  ]);
}

export async function listSavedMessageIds(userId) {
  return getDb().all(
    `SELECT message_id FROM saved_messages WHERE user_id = ?
     ORDER BY created_at DESC LIMIT 200`,
    [userId],
  );
}

export async function listThread(messageId, viewerId) {
  const db = getDb();
  let root = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!root) throw notFound('Message not found.');
  for (let depth = 0; root.reply_to_id && depth < 100; depth += 1) {
    const parent = await db.get('SELECT * FROM messages WHERE id = ?', [root.reply_to_id]);
    if (!parent) break;
    root = parent;
  }
  const ids = await db.all(
    `WITH RECURSIVE thread(id) AS (
       SELECT id FROM messages WHERE id = ?
       UNION ALL
       SELECT m.id FROM messages m JOIN thread t ON m.reply_to_id = t.id
       WHERE m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
     )
     SELECT t.id FROM thread t
     JOIN messages m ON m.id = t.id
     JOIN users u ON u.id = m.author_id
     WHERE m.deleted_at IS NULL AND (u.shadow_banned_at IS NULL OR m.author_id = ?)
     ORDER BY m.id ASC LIMIT 500`,
    [root.id, Date.now(), viewerId],
  );
  const messages = [];
  for (const row of ids) {
    const message = await hydrateMessage(row.id);
    if (message) messages.push(message);
  }
  return { rootId: root.id, messages, truncated: ids.length === 500 };
}

export async function purgeExpiredMessages() {
  const db = getDb();
  const now = Date.now();
  const rows = await db.all(
    `SELECT id FROM messages
     WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL LIMIT 1000`,
    [now],
  );
  for (const row of rows) {
    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE messages SET content = '', deleted_at = ?, deleted_by = author_id,
         pinned = 0 WHERE id = ? AND deleted_at IS NULL`,
        [now, row.id],
      );
      await tx.run('DELETE FROM reactions WHERE message_id = ?', [row.id]);
      await tx.run('DELETE FROM mentions WHERE message_id = ?', [row.id]);
      await tx.run('DELETE FROM saved_messages WHERE message_id = ?', [row.id]);
    });
  }
  return rows.length;
}
