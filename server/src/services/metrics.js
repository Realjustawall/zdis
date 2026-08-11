import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'youtbelimo_' });

export const httpDuration = new client.Histogram({
  name: 'youtbelimo_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const activeSockets = new client.Gauge({
  name: 'youtbelimo_socket_connections',
  help: 'Current authenticated Socket.IO connections',
  registers: [register],
});

export const activeVoiceParticipants = new client.Gauge({
  name: 'youtbelimo_voice_participants',
  help: 'Current participants tracked in voice rooms',
  registers: [register],
});

export const messagesCreated = new client.Counter({
  name: 'youtbelimo_messages_created_total',
  help: 'Messages created',
  labelNames: ['target'],
  registers: [register],
});

export const uploadsStored = new client.Counter({
  name: 'youtbelimo_uploads_stored_total',
  help: 'Uploads accepted',
  labelNames: ['provider', 'scan_status'],
  registers: [register],
});

export const moderationActions = new client.Counter({
  name: 'youtbelimo_moderation_actions_total',
  help: 'Moderation actions applied',
  labelNames: ['action'],
  registers: [register],
});

export const backgroundJobs = new client.Counter({
  name: 'youtbelimo_background_jobs_total',
  help: 'Background jobs completed or failed',
  labelNames: ['job', 'status'],
  registers: [register],
});

export const backupLastSuccess = new client.Gauge({
  name: 'youtbelimo_backup_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful application backup',
  registers: [register],
});

export function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.once('finish', () => {
    const route = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : req.path.replace(/[0-9a-z]{20,}/g, ':id');
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

export async function metricsText() {
  return register.metrics();
}

export const metricsContentType = register.contentType;
