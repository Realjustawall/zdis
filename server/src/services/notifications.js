import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { emitToUser } from '../realtime/index.js';
import { enqueue } from '../jobs/queue.js';
import { queueEnabled } from '../jobs/queue.js';
import { deliverNotification } from './delivery.js';
import { config } from '../config.js';

export const DEFAULT_PREFERENCES = {
  inApp: true,
  email: true,
  push: true,
  mentions: true,
  directMessages: true,
  moderation: true,
  quietStart: null,
  quietEnd: null,
  timezone: 'UTC',
  digestFrequency: 'immediate',
  digestHour: 9,
};

export function toNotification(row) {
  let data = null;
  try {
    data = row.data ? JSON.parse(row.data) : null;
  } catch {
    data = null;
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data,
    readAt: row.read_at ? Number(row.read_at) : null,
    createdAt: Number(row.created_at),
  };
}

export async function notify({ userId, type, title, body, data = null }) {
  const preferences = await getNotificationPreferences(userId);
  const targetType = data?.channelId ? 'channel' : data?.conversationId ? 'conversation' : null;
  const targetId = data?.channelId ?? data?.conversationId ?? null;
  const channelPreference =
    targetType && targetId
      ? await getChannelNotificationPreference(userId, targetType, targetId)
      : null;
  if (channelPreference?.level === 'none') return null;
  if (channelPreference?.level === 'mentions' && !['mention', 'moderation'].includes(type)) {
    return null;
  }
  if (type === 'mention' && !preferences.mentions) return null;
  if (type === 'direct_message' && !preferences.directMessages) return null;
  if (type === 'moderation' && !preferences.moderation) return null;
  if (!preferences.inApp && !preferences.email && !preferences.push) return null;
  const id = newId();
  const row = {
    id,
    user_id: userId,
    type,
    title,
    body,
    data: data ? JSON.stringify(data) : null,
    read_at: null,
    created_at: Date.now(),
  };
  if (preferences.inApp) {
    await getDb().run(
      `INSERT INTO notifications (id, user_id, type, title, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, type, title, body, row.data, row.created_at],
    );
    emitToUser(userId, 'notification:created', { notification: toNotification(row) });
  }
  const deliveryPreferences = {
    ...preferences,
    email: preferences.email && (channelPreference?.email ?? true),
    push: preferences.push && (channelPreference?.push ?? true),
  };
  const externalDelivery =
    (deliveryPreferences.email && Boolean(config.smtp.host && config.smtp.from)) ||
    (deliveryPreferences.push && Boolean(config.vapid.publicKey && config.vapid.privateKey));
  if (externalDelivery) {
    if (preferences.digestFrequency !== 'immediate' || isQuietHours(preferences)) {
      await getDb().run(
        `INSERT INTO notification_digest_items
           (id, user_id, notification_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [
          newId(),
          userId,
          id,
          JSON.stringify({ ...row, preferences: deliveryPreferences }),
          Date.now(),
        ],
      );
    } else if (queueEnabled()) {
      await enqueue('notification.deliver', {
        ...row,
        preferences: deliveryPreferences,
      }).catch(() => null);
    } else {
      // Development/single-node fallback. Production uses BullMQ so delivery is
      // retried without delaying the API request.
      void deliverNotification({ ...row, preferences: deliveryPreferences }).catch(() => null);
    }
  }
  return toNotification(row);
}

export async function listNotifications(userId, { limit = 50, before = null } = {}) {
  const params = [userId];
  let cursor = '';
  if (before) {
    cursor = 'AND id < ?';
    params.push(before);
  }
  params.push(limit);
  const rows = await getDb().all(
    `SELECT * FROM notifications WHERE user_id = ? ${cursor}
     ORDER BY id DESC LIMIT ?`,
    params,
  );
  return rows.map(toNotification);
}

export async function markNotificationRead(userId, id = null) {
  const now = Date.now();
  if (id) {
    await getDb().run(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
      [now, id, userId],
    );
  } else {
    await getDb().run(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
      [now, userId],
    );
  }
}

export async function getNotificationPreferences(userId) {
  const row = await getDb().get('SELECT * FROM notification_preferences WHERE user_id = ?', [
    userId,
  ]);
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    inApp: Boolean(row.in_app),
    email: Boolean(row.email),
    push: Boolean(row.push),
    mentions: Boolean(row.mentions),
    directMessages: Boolean(row.direct_messages),
    moderation: Boolean(row.moderation),
    quietStart: row.quiet_start ?? null,
    quietEnd: row.quiet_end ?? null,
    timezone: row.timezone ?? 'UTC',
    digestFrequency: row.digest_frequency ?? 'immediate',
    digestHour: Number(row.digest_hour ?? 9),
  };
}

export async function updateNotificationPreferences(userId, preferences) {
  const merged = { ...(await getNotificationPreferences(userId)), ...preferences };
  await getDb().run(
    `INSERT INTO notification_preferences
      (user_id, in_app, email, push, mentions, direct_messages, moderation,
       quiet_start, quiet_end, timezone, digest_frequency, digest_hour, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       in_app = excluded.in_app, email = excluded.email, push = excluded.push,
       mentions = excluded.mentions, direct_messages = excluded.direct_messages,
       moderation = excluded.moderation, quiet_start = excluded.quiet_start,
       quiet_end = excluded.quiet_end, timezone = excluded.timezone,
       digest_frequency = excluded.digest_frequency, digest_hour = excluded.digest_hour,
       updated_at = excluded.updated_at`,
    [
      userId,
      merged.inApp ? 1 : 0,
      merged.email ? 1 : 0,
      merged.push ? 1 : 0,
      merged.mentions ? 1 : 0,
      merged.directMessages ? 1 : 0,
      merged.moderation ? 1 : 0,
      merged.quietStart,
      merged.quietEnd,
      merged.timezone,
      merged.digestFrequency,
      merged.digestHour,
      Date.now(),
    ],
  );
  return merged;
}

export async function getChannelNotificationPreference(userId, targetType, targetId) {
  const row = await getDb().get(
    `SELECT * FROM notification_channel_preferences
     WHERE user_id = ? AND target_type = ? AND target_id = ?`,
    [userId, targetType, targetId],
  );
  return row
    ? {
        targetType: row.target_type,
        targetId: row.target_id,
        level: row.level,
        email: Boolean(row.email),
        push: Boolean(row.push),
      }
    : null;
}

export async function updateChannelNotificationPreference({
  userId,
  targetType,
  targetId,
  level,
  email,
  push,
}) {
  await getDb().run(
    `INSERT INTO notification_channel_preferences
       (user_id, target_type, target_id, level, email, push, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, target_type, target_id)
     DO UPDATE SET level = excluded.level, email = excluded.email,
                   push = excluded.push, updated_at = excluded.updated_at`,
    [userId, targetType, targetId, level, email, push, Date.now()],
  );
  return getChannelNotificationPreference(userId, targetType, targetId);
}

function localTime(preferences) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: preferences.timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    return {
      hour: Number(parts.find((part) => part.type === 'hour')?.value ?? 0),
      minute: Number(parts.find((part) => part.type === 'minute')?.value ?? 0),
    };
  } catch {
    return { hour: new Date().getUTCHours(), minute: new Date().getUTCMinutes() };
  }
}

function minuteOfDay(value) {
  if (!/^\d{2}:\d{2}$/.test(value ?? '')) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}

export function isQuietHours(preferences) {
  const start = minuteOfDay(preferences.quietStart);
  const end = minuteOfDay(preferences.quietEnd);
  if (start === null || end === null || start === end) return false;
  const now = localTime(preferences);
  const minute = now.hour * 60 + now.minute;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export async function deliverPendingDigests() {
  const users = await getDb().all(
    `SELECT DISTINCT user_id FROM notification_digest_items
     WHERE status = 'pending' ORDER BY user_id LIMIT 500`,
  );
  let queued = 0;
  for (const { user_id: userId } of users) {
    const preferences = await getNotificationPreferences(userId);
    if (isQuietHours(preferences) || preferences.digestFrequency === 'off') continue;
    const time = localTime(preferences);
    if (preferences.digestFrequency === 'daily' && time.hour !== preferences.digestHour) continue;
    const items = await getDb().all(
      `SELECT * FROM notification_digest_items
       WHERE user_id = ? AND status = 'pending' ORDER BY created_at LIMIT 100`,
      [userId],
    );
    if (!items.length) continue;
    const payloads = items.map((item) => JSON.parse(item.payload));
    const first = payloads[0];
    const job = {
      user_id: userId,
      title:
        items.length === 1 ? first.title : `${items.length} new ${config.appName} notifications`,
      body:
        items.length === 1
          ? first.body
          : payloads.slice(0, 5).map((item) => `• ${item.title}`).join('\n'),
      data: JSON.stringify({ digest: true, count: items.length }),
      preferences: first.preferences,
      digestItemIds: items.map((item) => item.id),
    };
    await getDb().run(
      `UPDATE notification_digest_items SET status = 'queued'
       WHERE id IN (${items.map(() => '?').join(', ')})`,
      items.map((item) => item.id),
    );
    try {
      if (queueEnabled()) await enqueue('notification.deliver', job);
      else await deliverNotification(job);
    } catch (error) {
      await getDb().run(
        `UPDATE notification_digest_items SET status = 'pending'
         WHERE id IN (${items.map(() => '?').join(', ')})`,
        items.map((item) => item.id),
      );
      throw error;
    }
    queued += items.length;
  }
  return queued;
}
