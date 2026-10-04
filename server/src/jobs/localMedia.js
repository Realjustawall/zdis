import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';

let timer = null;
let scanning = false;
let stopping = false;
const active = new Set();

// The attachment rows are the durable backlog; no unbounded in-memory queue.
async function drain() {
  if (scanning || stopping || active.size >= config.mediaConcurrency) return;
  scanning = true;
  try {
    const rows = await getDb().all(
      "SELECT id FROM attachments WHERE processing_status = 'queued' AND quarantined_at IS NULL ORDER BY created_at LIMIT ?",
      [config.mediaConcurrency - active.size],
    );
    for (const row of rows) {
      const claimed = await getDb().run("UPDATE attachments SET processing_status = 'processing' WHERE id = ? AND processing_status = 'queued'", [row.id]);
      if (!claimed.changes) continue;
      const task = import('../services/mediaPipeline.js')
        .then(({ processAttachment }) => processAttachment(row.id))
        .catch((error) => logger.warn('local media processing failed', { attachmentId: row.id, error: error.message }))
        .finally(() => { active.delete(task); if (!stopping) void drain(); });
      active.add(task);
    }
  } catch (error) {
    logger.warn('local media backlog scan failed', { error: error.message });
  } finally {
    scanning = false;
  }
}

export async function initLocalMedia() {
  stopping = false;
  // Recover jobs interrupted by a previous shutdown.
  await getDb().run("UPDATE attachments SET processing_status = 'queued' WHERE processing_status = 'processing'");
  timer = setInterval(() => void drain(), 1000);
  timer.unref();
  await drain();
}

export async function closeLocalMedia() {
  stopping = true;
  clearInterval(timer);
  timer = null;
  await Promise.allSettled([...active]);
}
