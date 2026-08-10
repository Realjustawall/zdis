import { Queue } from 'bullmq';
import { logger } from '../lib/logger.js';
import { createRedisConnection, getRedis } from '../cache/index.js';

export const QUEUE_NAME = 'youtbelimo';
let connection;
let queue;

export function queueEnabled() {
  return Boolean(getRedis());
}

export async function initJobQueue() {
  if (!queueEnabled() || queue) return queue;
  connection = await createRedisConnection({
    maxRetriesPerRequest: null,
  });
  connection.on('error', (error) => logger.warn('job redis error', { error: error.message }));
  // Hash tag keeps every BullMQ key in one Redis Cluster slot.
  queue = new Queue(QUEUE_NAME, { connection, prefix: '{youtbelimo}' });
  await queue.waitUntilReady();
  await queue.add(
    'maintenance.purge',
    {},
    {
      jobId: 'hourly-maintenance',
      repeat: { every: 60 * 60 * 1000 },
      removeOnComplete: 20,
      removeOnFail: 100,
    },
  );
  await queue.add(
    'message.publish-due',
    {},
    {
      jobId: 'scheduled-message-sweep',
      repeat: { every: 60 * 1000 },
      removeOnComplete: 20,
      removeOnFail: 100,
    },
  );
  await queue.add(
    'notification.digest-due',
    {},
    {
      jobId: 'notification-digest-sweep',
      repeat: { every: 15 * 60 * 1000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  );
  await queue.add(
    'backup.run',
    {},
    {
      jobId: 'daily-backup',
      repeat: { pattern: '0 3 * * *' },
      removeOnComplete: 30,
      removeOnFail: 100,
    },
  );
  await queue.add(
    'file.rescan-due',
    {},
    {
      jobId: 'daily-antivirus-rescan',
      repeat: { pattern: '30 2 * * *' },
      removeOnComplete: 30,
      removeOnFail: 100,
    },
  );
  await queue.add(
    'backup.verify-latest',
    {},
    {
      jobId: 'weekly-backup-verification',
      repeat: { pattern: '0 4 * * 0' },
      removeOnComplete: 20,
      removeOnFail: 100,
    },
  );
  logger.info('background queue ready');
  return queue;
}

export async function enqueue(name, data, options = {}) {
  if (!queueEnabled()) return null;
  const active = queue ?? (await initJobQueue());
  return active.add(name, data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
    ...options,
  });
}

export async function getQueueStats() {
  if (!queueEnabled()) {
    return { enabled: false, waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 };
  }
  const active = queue ?? (await initJobQueue());
  const counts = await active.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  return { enabled: true, ...counts };
}

export async function listQueueJobs({ limit = 50 } = {}) {
  if (!queueEnabled()) return [];
  const active = queue ?? (await initJobQueue());
  const jobs = await active.getJobs(['waiting', 'active', 'delayed', 'failed', 'completed'], 0, limit - 1, true);
  return Promise.all(jobs.map(async (job) => ({
    id: String(job.id),
    name: job.name,
    state: await job.getState(),
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason || null,
    timestamp: job.timestamp,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
  })));
}

export async function retryQueueJob(id) {
  if (!queueEnabled()) throw new Error('Queue is not enabled.');
  const active = queue ?? (await initJobQueue());
  const job = await active.getJob(id);
  if (!job) return false;
  const state = await job.getState();
  if (state !== 'failed') throw new Error('Only failed jobs can be retried.');
  await job.retry();
  return true;
}

export async function closeJobQueue() {
  await queue?.close();
  queue = null;
  await connection?.quit();
  connection = null;
}
