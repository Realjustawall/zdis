import { Worker } from 'bullmq';
import http from 'node:http';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { initDb, getDb, closeDatabases } from '../db/index.js';
import { initCache, closeCache, createRedisConnection } from '../cache/index.js';
import { ensureBadgeCatalogue } from '../services/badges.js';
import { deliverNotification, resetDeliveryTransport } from '../services/delivery.js';
import { purgeExpiredSessions } from '../services/sessions.js';
import { purgeOrphanAttachments } from '../services/uploads.js';
import { QUEUE_NAME } from '../jobs/queue.js';
import { runBackup, verifyBackup } from '../services/backups.js';
import {
  publishDueScheduledMessages,
  publishScheduledMessage,
  purgeExpiredMessages,
} from '../services/advancedChat.js';
import { Emitter } from '@socket.io/redis-emitter';
import {
  deliverWebhook,
  dispatchWebhookEvent,
  recordSyncEvent,
} from '../services/integrations.js';
import { deleteSearchMessage, indexMessage } from '../services/search.js';
import {
  processAttachment,
  purgeRetentionExpiredAttachments,
  rescanDueAttachments,
} from '../services/mediaPipeline.js';
import { purgeExpiredResumableUploads } from '../services/resumableUploads.js';
import {
  purgeExpiredReservations,
  reconcileStorageQuotas,
} from '../services/storageQuota.js';
import { deliverPendingDigests } from '../services/notifications.js';
import { newId } from '../lib/ids.js';
import { loadRuntimeConfiguration } from '../services/runtimeConfiguration.js';
import {
  backgroundJobs,
  backupLastSuccess,
  metricsContentType,
  metricsText,
} from '../services/metrics.js';

if (!config.redisUrl && !config.redisClusterNodes.length) {
  logger.error('worker requires REDIS_URL or REDIS_CLUSTER_NODES');
  process.exit(1);
}

await initDb();
await loadRuntimeConfiguration();
const runtimeConfigurationRefresh = setInterval(
  () => loadRuntimeConfiguration().then(({ changed }) => { if (changed) resetDeliveryTransport(); })
    .catch((error) => logger.warn('runtime configuration refresh failed', { error: error.message })),
  60_000,
);
runtimeConfigurationRefresh.unref();
await initCache();
await ensureBadgeCatalogue();
const previousBackup = await getDb().get(
  "SELECT MAX(finished_at) AS finished_at FROM backup_runs WHERE status = 'completed'",
);
if (previousBackup?.finished_at) {
  backupLastSuccess.set(Number(previousBackup.finished_at) / 1000);
}

const connection = await createRedisConnection({ maxRetriesPerRequest: null });
const realtimeEmitter = new Emitter(connection);

async function emitScheduled(result) {
  const message = result?.message;
  if (!message) return;
  const targetType = message.channelId ? 'channel' : 'conversation';
  const targetId = message.channelId ?? message.conversationId;
  await recordSyncEvent({
    targetType,
    targetId,
    eventType: 'message.created',
    entityId: message.id,
    payload: message,
  });
  await dispatchWebhookEvent({
    targetType,
    targetId,
    eventType: 'message.created',
    payload: { message },
  });
  await indexMessage(message.id);
  const room = message.channelId
    ? `channel:${message.channelId}`
    : `conversation:${message.conversationId}`;
  realtimeEmitter.to(room).emit('message:created', { message });
}
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    switch (job.name) {
      case 'notification.deliver':
        return deliverNotification(job.data);
      case 'notification.digest-due':
        return { queued: await deliverPendingDigests() };
      case 'maintenance.purge':
        return {
          sessions: await purgeExpiredSessions(),
          attachments: await purgeOrphanAttachments(),
          messages: await purgeExpiredMessages(),
          resumableUploads: await purgeExpiredResumableUploads(),
          quotaReservations: await purgeExpiredReservations(),
          retentionFiles: await purgeRetentionExpiredAttachments(),
          quotaUsers: await reconcileStorageQuotas(),
        };
      case 'message.publish-scheduled':
        {
          const result = await publishScheduledMessage(job.data.scheduledMessageId);
          await emitScheduled(result);
          return result;
        }
      case 'message.publish-due':
        {
          const results = await publishDueScheduledMessages();
          for (const result of results) await emitScheduled(result);
          return { published: results.filter((result) => result.message).length };
        }
      case 'webhook.deliver':
        return deliverWebhook(job.data);
      case 'search.index-message':
        return indexMessage(job.data.messageId);
      case 'search.delete-message':
        return deleteSearchMessage(job.data.messageId);
      case 'media.process':
        return processAttachment(job.data.attachmentId);
      case 'file.rescan-due':
        return { rescanned: await rescanDueAttachments() };
      case 'backup.run':
        {
          const backup = await runBackup();
          backupLastSuccess.set(Date.now() / 1000);
          return backup;
        }
      case 'backup.verify-latest':
        {
          const latest = await getDb().get(
            `SELECT location FROM backup_runs
             WHERE status = 'completed' AND location IS NOT NULL
             ORDER BY finished_at DESC LIMIT 1`,
          );
          if (!latest?.location) throw new Error('No completed backup is available to verify.');
          return verifyBackup(latest.location);
        }
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  },
  {
    connection,
    prefix: '{youtbelimo}',
    concurrency: config.jobConcurrency,
    limiter: { max: 100, duration: 1000 },
  },
);

worker.on('completed', (job) => {
  backgroundJobs.inc({ job: job.name, status: 'completed' });
  logger.info('job completed', { id: job.id, name: job.name });
});
worker.on('failed', (job, error) => {
  backgroundJobs.inc({ job: job?.name ?? 'unknown', status: 'failed' });
  logger.error('job failed', { id: job?.id, name: job?.name, error: error.message });
  const attempts = Number(job?.opts?.attempts ?? 1);
  if (job && job.attemptsMade >= attempts) {
    void getDb().run(
      `INSERT INTO notification_dead_letters
         (id, job_type, job_id, payload, error, attempts, status, first_failed_at, last_failed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        newId(),
        job.name,
        String(job.id),
        JSON.stringify(job.data ?? {}),
        String(error.message).slice(0, 1000),
        job.attemptsMade,
        Date.now(),
        Date.now(),
      ],
    ).catch(() => {});
  }
});
worker.on('error', (error) => logger.error('worker error', { error: error.message }));
logger.info('background worker ready', { concurrency: config.jobConcurrency });

const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(worker.isRunning() ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: worker.isRunning() }));
  }
  if (req.url === '/metrics') {
    if (!config.metricsToken && config.isProd) {
      res.writeHead(404);
      return res.end();
    }
    if (
      config.metricsToken &&
      req.headers.authorization !== `Bearer ${config.metricsToken}`
    ) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { 'content-type': metricsContentType });
    return res.end(await metricsText());
  }
  res.writeHead(404);
  return res.end();
});
metricsServer.listen(config.workerMetricsPort, config.host, () => {
  logger.info('worker metrics ready', { port: config.workerMetricsPort });
});

async function shutdown(signal) {
  logger.info(`worker received ${signal}`);
  metricsServer.close();
  clearInterval(runtimeConfigurationRefresh);
  await worker.close();
  await connection.quit();
  await closeCache();
  await closeDatabases();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
