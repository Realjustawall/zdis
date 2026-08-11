import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config, ROOT } from './config.js';
import {
  loadSession,
  csrfProtection,
  moderationProtection,
  requirePasswordCurrent,
  enforceApiKeyScope,
} from './middleware/auth.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { groupsRouter } from './routes/groups.js';
import { forumsRouter } from './routes/forums.js';
import { conversationsRouter } from './routes/conversations.js';
import { messagesRouter } from './routes/messages.js';
import { filesRouter } from './routes/files.js';
import { adminRouter } from './routes/admin.js';
import { networkRouter } from './routes/network.js';
import { notificationsRouter } from './routes/notifications.js';
import { moderationRouter } from './routes/moderation.js';
import { voiceRouter } from './routes/voice.js';
import { ssoRouter } from './routes/sso.js';
import { integrationsRouter } from './routes/integrations.js';
import { e2eeRouter } from './routes/e2ee.js';
import { ttsRouter } from './routes/tts.js';
import { getDb, getReadDb, readReplicaMode } from './db/index.js';
import { cacheMode } from './cache/index.js';
import {
  metricsContentType,
  metricsMiddleware,
  metricsText,
} from './services/metrics.js';
import { storageHealth } from './services/storage.js';
import { antivirusHealth } from './services/antivirus.js';
import { searchHealth } from './services/search.js';

export function createApp() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((_req, res, next) => {
    res.setHeader('X-Deployment-Region', config.deploymentRegion);
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          // Cloudflare injects its integrity-protected Web Analytics beacon at
          // the edge. Keep all other third-party scripts blocked.
          'script-src': ["'self'", 'https://static.cloudflareinsights.com'],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:', ...config.mediaOrigins],
          'media-src': ["'self'", 'blob:', ...config.mediaOrigins],
          'font-src': ["'self'", 'data:'],
          'connect-src': [
            "'self'",
            'ws:',
            'wss:',
            'https://cloudflareinsights.com',
            ...config.clientOrigins,
          ],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'worker-src': ["'self'", 'blob:'],
          ...(config.secureCookies ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    cors((req, callback) => {
      callback(null, {
        origin(origin, originCallback) {
          // Module scripts include Origin even when loaded from this server.
          // Always accept that exact origin, plus explicitly configured clients.
          let sameOrigin = false;
          try {
            sameOrigin = Boolean(origin && new URL(origin).host === req.get('host'));
          } catch {
            sameOrigin = false;
          }
          if (!origin || sameOrigin || config.clientOrigins.includes(origin)) {
            return originCallback(null, true);
          }
          return originCallback(new Error('Origin not allowed'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
        maxAge: 600,
      });
    }),
  );

  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false, limit: '128kb' }));
  app.use(cookieParser());
  app.use(metricsMiddleware);

  app.use('/api', globalLimiter);
  app.use(loadSession);
  app.use(enforceApiKeyScope);
  app.use('/api', (req, _res, next) => {
    if (!config.allowWrites && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const error = new Error('This region is temporarily read-only during failover.');
      error.status = 503;
      error.code = 'region_read_only';
      return next(error);
    }
    return next();
  });
  app.use(csrfProtection);

  app.get('/api/health', async (_req, res) => {
    let database = 'down';
    try {
      await getDb().get('SELECT 1 AS ok');
      database = getDb().dialect;
    } catch {
      database = 'down';
    }
    res.json({
      ok: database !== 'down',
      app: config.appName,
      database,
      cache: cacheMode(),
      uptimeSeconds: Math.round(process.uptime()),
      region: config.deploymentRegion,
      role: config.deploymentRole,
    });
  });

  app.get('/api/traffic-ready', (_req, res) => {
    const acceptingTraffic = config.deploymentRole !== 'standby' || config.allowWrites;
    return res.status(acceptingTraffic ? 200 : 503).json({
      ok: acceptingTraffic,
      region: config.deploymentRegion,
      role: config.deploymentRole,
      writes: config.allowWrites,
    });
  });

  app.get('/api/ready', async (_req, res) => {
    let database = false;
    try {
      database = Boolean(await getDb().get('SELECT 1 AS ok'));
    } catch {
      database = false;
    }
    const storage = await storageHealth().catch((error) => ({
      driver: config.storageDriver,
      ok: false,
      error: error.message,
    }));
    const antivirus = await antivirusHealth();
    const search = await searchHealth();
    let livekit = { configured: false, ok: true };
    if (config.livekit.url && config.livekit.apiUrl) {
      try {
        const response = await fetch(config.livekit.apiUrl.replace(/^ws/, 'http'), {
          signal: AbortSignal.timeout(3000),
        });
        livekit = { configured: true, ok: response.ok };
      } catch (error) {
        livekit = { configured: true, ok: false, error: error.message };
      }
    }
    const redisReady = !config.requireRedis || cacheMode() === 'redis';
    const postgresReady = !config.requirePostgres || getDb().dialect === 'postgres';
    let readReplica = readReplicaMode() === 'replica';
    if (readReplica) {
      try {
        readReplica = Boolean(await getReadDb().get('SELECT 1 AS ok'));
      } catch {
        readReplica = false;
      }
    }
    const replicaReady = !config.requireReadReplica || readReplica;
    const ok =
      database &&
      storage.ok &&
      antivirus.ok &&
      livekit.ok &&
      redisReady &&
      postgresReady &&
      replicaReady;
    const searchReady = !config.openSearch.required || search.ok;
    const finalOk = ok && searchReady;
    return res.status(finalOk ? 200 : 503).json({
      ok: finalOk,
      checks: {
        database,
        storage,
        antivirus,
        livekit,
        redis: redisReady,
        postgres: postgresReady,
        readReplica: replicaReady,
        search,
      },
    });
  });

  app.get('/api/metrics', async (req, res) => {
    if (
      config.metricsToken &&
      req.get('authorization') !== `Bearer ${config.metricsToken}`
    ) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid metrics token.' } });
    }
    if (!config.metricsToken && config.isProd) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', metricsContentType);
    return res.send(await metricsText());
  });

  // /api/auth stays open to a user who must rotate their password — it is the
  // only place they can do it. Everything else is gated until they have.
  app.use('/api/auth', authRouter);
  app.use('/api/auth/sso', ssoRouter);
  app.use('/api', moderationProtection);
  app.use('/api/users', requirePasswordCurrent, usersRouter);
  app.use('/api/groups', requirePasswordCurrent, groupsRouter);
  app.use('/api/forums', requirePasswordCurrent, forumsRouter);
  app.use('/api/conversations', requirePasswordCurrent, conversationsRouter);
  app.use('/api/files', requirePasswordCurrent, filesRouter);
  app.use('/api/network', requirePasswordCurrent, networkRouter);
  app.use('/api/notifications', requirePasswordCurrent, notificationsRouter);
  app.use('/api/moderation', requirePasswordCurrent, moderationRouter);
  app.use('/api/voice', requirePasswordCurrent, voiceRouter);
  app.use('/api/integrations', requirePasswordCurrent, integrationsRouter);
  app.use('/api/e2ee', requirePasswordCurrent, e2eeRouter);
  app.use('/api/tts', requirePasswordCurrent, ttsRouter);
  app.use('/api/admin', requirePasswordCurrent, adminRouter);
  app.use('/api', requirePasswordCurrent, messagesRouter);

  // Serve the built SPA when it exists, so production is a single process.
  const clientDist = path.join(ROOT, 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        index: false,
        maxAge: '1y',
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
          if (filePath.endsWith('sw.js')) {
            res.setHeader('Service-Worker-Allowed', '/');
          }
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
