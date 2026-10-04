import { getDb } from '../db/index.js';
import { getIo } from '../realtime/index.js';
import { logger } from '../lib/logger.js';
import { publishDueScheduledMessages } from '../services/advancedChat.js';
import { recordSyncEvent, dispatchWebhookEvent, deliverWebhook } from '../services/integrations.js';
import { indexMessage } from '../services/search.js';
import { deliverPendingDigests } from '../services/notifications.js';

const timers = [];
const running = new Set();
let stopping = false;

function periodic(name, milliseconds, work) {
  let busy = false;
  const tick = () => {
    if (busy || stopping) return;
    busy = true;
    const task = work().catch((error) => logger.warn('local background task failed', { task: name, error: error.message }))
      .finally(() => { busy = false; running.delete(task); });
    running.add(task);
  };
  const timer = setInterval(tick, milliseconds);
  timer.unref();
  timers.push(timer);
}

async function scheduled() {
  for (const result of await publishDueScheduledMessages()) {
    const message = result?.message;
    if (!message) continue;
    const targetType = message.channelId ? 'channel' : 'conversation';
    const targetId = message.channelId ?? message.conversationId;
    await recordSyncEvent({ targetType, targetId, eventType: 'message.created', entityId: message.id, payload: message });
    getIo()?.to(targetType + ':' + targetId).emit('message:created', { message });
    await dispatchWebhookEvent({ targetType, targetId, eventType: 'message.created', payload: { message } });
    await indexMessage(message.id);
  }
}

async function webhooks() {
  const rows = await getDb().all(
    `SELECT d.id, d.payload FROM webhook_deliveries d
     JOIN outgoing_webhooks w ON w.id = d.webhook_id
     WHERE w.active = 1 AND (w.circuit_open_until IS NULL OR w.circuit_open_until <= ?)
       AND (d.status = 'queued' OR
         (d.status = 'failed' AND d.attempts < 5 AND d.completed_at + 2000 * (1 << d.attempts) <= ?))
     ORDER BY d.created_at LIMIT 2`, [Date.now(), Date.now()],
  );
  await Promise.all(rows.map(async (row) => {
    const claimed = await getDb().run("UPDATE webhook_deliveries SET status = 'processing' WHERE id = ? AND status IN ('queued', 'failed')", [row.id]);
    if (!claimed.changes) return;
    try { await deliverWebhook({ deliveryId: row.id, payload: JSON.parse(row.payload) }); }
    catch (error) {
      // Endpoint validation can fail before deliverWebhook updates the row.
      await getDb().run("UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, completed_at = ?, error = ? WHERE id = ? AND status = 'processing'", [Date.now(), String(error.message).slice(0, 500), row.id]);
      logger.warn('local webhook delivery failed', { deliveryId: row.id, error: error.message });
    }
  }));
}

export async function initLocalTasks() {
  stopping = false;
  await getDb().run("UPDATE webhook_deliveries SET status = 'queued' WHERE status = 'processing'");
  // Scheduled rows are recovered only if no message was committed.
  await getDb().run("UPDATE scheduled_messages SET status = 'scheduled' WHERE status = 'processing' AND message_id IS NULL");
  periodic('scheduled messages', 1000, scheduled);
  periodic('webhook deliveries', 1000, webhooks);
  periodic('notification digests', 15 * 60_000, deliverPendingDigests);
}

export async function closeLocalTasks() {
  stopping = true;
  for (const timer of timers.splice(0)) clearInterval(timer);
  await Promise.allSettled([...running]);
}
