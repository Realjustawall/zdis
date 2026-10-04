import http from 'node:http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { initDb, closeDatabases } from './db/index.js';
import { initCache, closeCache } from './cache/index.js';
import { createApp } from './app.js';
import { initRealtime, getIo } from './realtime/index.js';
import { ensureSeedAdmin } from './scripts/seed.js';
import { purgeExpiredSessions } from './services/sessions.js';
import { purgeOrphanAttachments } from './services/uploads.js';
import { ensureBadgeCatalogue } from './services/badges.js';
import {
  closeJobQueue,
  initJobQueue,
  queueEnabled,
} from './jobs/queue.js';
import { loadRuntimeConfiguration } from './services/runtimeConfiguration.js';
import { resetDeliveryTransport } from './services/delivery.js';
import { resetEnterpriseAuthClients } from './services/enterpriseAuth.js';
import { initLocalMedia, closeLocalMedia } from './jobs/localMedia.js';
import { initLocalTasks, closeLocalTasks } from './jobs/localTasks.js';
import { ensureBuiltinBots, runBotMaintenance } from './services/builtinBots.js';

async function main() {
  await initDb();
  await loadRuntimeConfiguration();
  const runtimeConfigurationRefresh = setInterval(
    () => loadRuntimeConfiguration().then(({ changed }) => {
      if (changed) { resetDeliveryTransport(); resetEnterpriseAuthClients(); }
    }).catch((error) => logger.warn('runtime configuration refresh failed', { error: error.message })),
    60_000,
  );
  runtimeConfigurationRefresh.unref();
  await initCache();
  await ensureBadgeCatalogue();
  await ensureSeedAdmin();
  await ensureBuiltinBots();
  let botsRunning=false;
  const botMaintenance=setInterval(()=>{if(botsRunning)return;botsRunning=true;runBotMaintenance().catch(error=>logger.warn('bot maintenance failed',{error:error.message})).finally(()=>{botsRunning=false;});},30_000);
  botMaintenance.unref();
  await initJobQueue();
  if (!queueEnabled()) {
    await initLocalMedia();
    await initLocalTasks();
  }

  const app = createApp();
  const server = http.createServer(app);
  await initRealtime(server);

  // Housekeeping: expired sessions and never-attached uploads.
  const housekeeping = queueEnabled() ? null : setInterval(
    () => {
      purgeExpiredSessions().catch((error) =>
        logger.warn('session purge failed', { error: error.message }),
      );
      purgeOrphanAttachments().catch((error) =>
        logger.warn('attachment purge failed', { error: error.message }),
      );
    },
    60 * 60 * 1000,
  );
  housekeeping?.unref();

  server.listen(config.port, config.host, () => {
    logger.info(`${config.appName} listening`, {
      url: `http://localhost:${config.port}`,
      env: config.env,
    });
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`received ${signal}, shutting down`);
    if (housekeeping) clearInterval(housekeeping);
    clearInterval(botMaintenance);
    clearInterval(runtimeConfigurationRefresh);
    getIo()?.close();
    server.close();
    await closeLocalTasks().catch(() => {});
    await closeLocalMedia().catch(() => {});
    await closeCache().catch(() => {});
    await closeJobQueue().catch(() => {});
    await closeDatabases().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  server.on('error', (error) => {
    logger.error('HTTP listener failed; check PORT and Windows reserved ports', { port: config.port, error: error.message });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
  });
}

main().catch((error) => {
  logger.error('failed to start', { error: error.message, stack: error.stack });
  process.exit(1);
});
