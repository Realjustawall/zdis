import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const SERVER_ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * The session/CSRF signing secret must survive restarts, otherwise every
 * deploy logs everybody out. If the operator has not supplied one we generate
 * it once and persist it with owner-only permissions.
 */
function resolveSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 32) {
    return process.env.APP_SECRET;
  }
  const secretFile = path.join(DATA_DIR, '.app_secret');
  if (fs.existsSync(secretFile)) {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const csv = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const publicOrigin = (value) => {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
};

// Signed object URLs are rendered by the browser, so their public S3/CDN
// origins must be present in the CSP. Derive them from the same endpoints used
// to create those URLs; MEDIA_ORIGINS remains available for extra hosts.
const mediaOrigins = () => [
  ...new Set([
    ...csv(process.env.MEDIA_ORIGINS),
    publicOrigin(process.env.S3_PUBLIC_ENDPOINT),
    publicOrigin(process.env.CDN_BASE_URL),
  ].filter(Boolean)),
];

const secretFromFile = (file) => {
  if (!file) return '';
  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim();
  } catch {
    return '';
  }
};

const pem = (value, file) =>
  (value || secretFromFile(file) || '').replaceAll('\\n', '\n').trim();

const livekitRegions = (value) =>
  csv(value).map((entry) => {
    const [name, url, apiUrl] = entry.split('|').map((part) => part?.trim());
    return { name, url, apiUrl: apiUrl || url };
  }).filter((region) => region.name && region.url);

export const config = {
  appName: process.env.APP_NAME || 'sahsha',
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, 4000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl:
    process.env.PUBLIC_URL ||
    `http://localhost:${int(process.env.PORT, 4000)}`,
  deploymentRegion: process.env.DEPLOYMENT_REGION || 'local',
  deploymentRole: process.env.DEPLOYMENT_ROLE || 'primary',

  dataDir: DATA_DIR,
  uploadDir: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(DATA_DIR, 'uploads'),
  sqliteFile: process.env.SQLITE_FILE
    ? path.resolve(process.env.SQLITE_FILE)
    : path.join(DATA_DIR, 'youtbelimo.db'),

  databaseUrl: process.env.DATABASE_URL || '',
  readDatabaseUrl: process.env.READ_DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  redisClusterNodes: csv(process.env.REDIS_CLUSTER_NODES),
  requirePostgres: bool(process.env.REQUIRE_POSTGRES, false),
  requireReadReplica: bool(process.env.REQUIRE_READ_REPLICA, false),
  requireRedis: bool(process.env.REQUIRE_REDIS, false),
  allowWrites: bool(process.env.ALLOW_WRITES, true),
  postgresPoolMax: Math.max(2, int(process.env.POSTGRES_POOL_MAX, 8)),

  secret: resolveSecret(),
  previousSecrets: csv(process.env.APP_SECRET_PREVIOUS),
  auditSigningKey:
    process.env.AUDIT_SIGNING_KEY ||
    secretFromFile(process.env.AUDIT_SIGNING_KEY_FILE) ||
    '',
  recoverySigningKey:
    process.env.RECOVERY_CODE_SIGNING_KEY ||
    secretFromFile(process.env.RECOVERY_CODE_SIGNING_KEY_FILE) ||
    '',
  recoveryPreviousSigningKeys: csv(process.env.RECOVERY_CODE_PREVIOUS_KEYS),

  // Public origin(s) allowed to talk to the API with credentials.
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  trustProxy: bool(process.env.TRUST_PROXY, false),
  secureCookies: bool(process.env.SECURE_COOKIES, (process.env.NODE_ENV || '') === 'production'),
  cookieName: process.env.COOKIE_NAME || 'ytbl_session',
  csrfCookieName: 'ytbl_csrf',

  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 24 * 14) * 60 * 60 * 1000,
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 100) * 1024 * 1024,
  userStorageQuotaBytes: int(process.env.USER_STORAGE_QUOTA_GB, 10) * 1024 * 1024 * 1024,
  resumableChunkBytes: int(process.env.RESUMABLE_CHUNK_MB, 5) * 1024 * 1024,
  uploadRetentionDays: int(process.env.UPLOAD_RETENTION_DAYS, 365),
  antivirusRescanDays: int(process.env.ANTIVIRUS_RESCAN_DAYS, 7),

  storageDriver: process.env.STORAGE_DRIVER || 'local',
  s3: {
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || '',
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || '',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, false),
    kmsKeyId: process.env.S3_KMS_KEY_ID || '',
    serverSideEncryption: ['AES256', 'aws:kms'].includes(
      process.env.S3_SERVER_SIDE_ENCRYPTION,
    )
      ? process.env.S3_SERVER_SIDE_ENCRYPTION
      : '',
    signedUrlTtlSeconds: int(process.env.S3_SIGNED_URL_TTL_SECONDS, 300),
  },
  cdnBaseUrl: process.env.CDN_BASE_URL || '',
  cdnKeyPairId: process.env.CDN_KEY_PAIR_ID || '',
  cdnPrivateKeyPath: process.env.CDN_PRIVATE_KEY_PATH
    ? path.resolve(process.env.CDN_PRIVATE_KEY_PATH)
    : '',
  mediaOrigins: mediaOrigins(),
  clamav: {
    host: process.env.CLAMAV_HOST || '',
    port: int(process.env.CLAMAV_PORT, 3310),
    required: bool(process.env.CLAMAV_REQUIRED, false),
    timeoutMs: int(process.env.CLAMAV_TIMEOUT_MS, 20_000),
  },

  loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 8),
  loginLockoutMs: int(process.env.LOGIN_LOCKOUT_MINUTES, 15) * 60 * 1000,
  dlpMode: ['off', 'audit', 'block'].includes(process.env.DLP_MODE)
    ? process.env.DLP_MODE
    : 'off',
  openSearch: {
    url: process.env.OPENSEARCH_URL || '',
    username: process.env.OPENSEARCH_USERNAME || '',
    password:
      process.env.OPENSEARCH_PASSWORD ||
      secretFromFile(process.env.OPENSEARCH_PASSWORD_FILE),
    index: process.env.OPENSEARCH_INDEX || 'youtbelimo-messages-v1',
    timeoutMs: int(process.env.OPENSEARCH_TIMEOUT_MS, 5_000),
    required: bool(process.env.OPENSEARCH_REQUIRED, false),
  },
  fishAudio: {
    apiKey: process.env.FISH_AUDIO_API_KEY || secretFromFile(process.env.FISH_AUDIO_API_KEY_FILE),
    model: ['s1', 's2-pro'].includes(process.env.FISH_AUDIO_MODEL) ? process.env.FISH_AUDIO_MODEL : 's2-pro',
    referenceId: process.env.FISH_AUDIO_REFERENCE_ID || '',
  },

  oidc: {
    issuer: process.env.OIDC_ISSUER || '',
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret:
      process.env.OIDC_CLIENT_SECRET ||
      secretFromFile(process.env.OIDC_CLIENT_SECRET_FILE),
    label: process.env.OIDC_LABEL || 'Company SSO',
    scopes: process.env.OIDC_SCOPES || 'openid profile email',
    autoProvision: bool(process.env.OIDC_AUTO_PROVISION, false),
    allowedDomains: csv(process.env.OIDC_ALLOWED_DOMAINS).map((domain) => domain.toLowerCase()),
  },
  saml: {
    entryPoint: process.env.SAML_ENTRY_POINT || '',
    issuer: process.env.SAML_SP_ISSUER || '',
    idpIssuer: process.env.SAML_IDP_ISSUER || '',
    idpCert: pem(process.env.SAML_IDP_CERT, process.env.SAML_IDP_CERT_FILE),
    privateKey: pem(process.env.SAML_SP_PRIVATE_KEY, process.env.SAML_SP_PRIVATE_KEY_FILE),
    publicCert: pem(process.env.SAML_SP_PUBLIC_CERT, process.env.SAML_SP_PUBLIC_CERT_FILE),
    label: process.env.SAML_LABEL || 'SAML SSO',
    autoProvision: bool(process.env.SAML_AUTO_PROVISION, false),
    allowedDomains: csv(process.env.SAML_ALLOWED_DOMAINS).map((domain) => domain.toLowerCase()),
  },
  ldap: {
    url: process.env.LDAP_URL || '',
    bindDn: process.env.LDAP_BIND_DN || '',
    bindPassword:
      process.env.LDAP_BIND_PASSWORD ||
      secretFromFile(process.env.LDAP_BIND_PASSWORD_FILE),
    searchBase: process.env.LDAP_SEARCH_BASE || '',
    searchFilter:
      process.env.LDAP_SEARCH_FILTER ||
      '(&(objectClass=person)(|(mail={{username}})(uid={{username}})(sAMAccountName={{username}})))',
    emailAttribute: process.env.LDAP_EMAIL_ATTRIBUTE || 'mail',
    displayNameAttribute: process.env.LDAP_DISPLAY_NAME_ATTRIBUTE || 'displayName',
    usernameAttribute: process.env.LDAP_USERNAME_ATTRIBUTE || 'uid',
    ca: pem('', process.env.LDAP_CA_FILE),
    allowInsecure: bool(process.env.LDAP_ALLOW_INSECURE, false),
    autoProvision: bool(process.env.LDAP_AUTO_PROVISION, false),
    allowedDomains: csv(process.env.LDAP_ALLOWED_DOMAINS).map((domain) => domain.toLowerCase()),
    label: process.env.LDAP_LABEL || 'Directory account',
  },

  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || 'office@intesho.com',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || '',
  seedAdminUsername: process.env.SEED_ADMIN_USERNAME || 'admin',

  // WebRTC ICE servers. TURN is optional but strongly recommended in production.
  stunUrls: csv(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnPassword: process.env.TURN_PASSWORD || '',
  turnSharedSecret: process.env.TURN_SHARED_SECRET || '',
  turnCredentialTtlSeconds: int(process.env.TURN_CREDENTIAL_TTL_SECONDS, 3600),
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiUrl: process.env.LIVEKIT_API_URL || process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    maxParticipants: int(process.env.LIVEKIT_MAX_PARTICIPANTS, 500),
    regions: livekitRegions(process.env.LIVEKIT_REGIONS),
    egressEnabled: bool(process.env.LIVEKIT_EGRESS_ENABLED, false),
    transcriptWebhookSecret:
      process.env.CALL_TRANSCRIPT_WEBHOOK_SECRET ||
      secretFromFile(process.env.CALL_TRANSCRIPT_WEBHOOK_SECRET_FILE),
  },

  metricsToken:
    process.env.METRICS_TOKEN ||
    secretFromFile(process.env.METRICS_TOKEN_FILE) ||
    '',
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  serviceName: process.env.OTEL_SERVICE_NAME || 'youtbelimo',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || '',
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  jobConcurrency: Math.max(1, int(process.env.JOB_CONCURRENCY, 4)),
  mediaConcurrency: Math.max(1, int(process.env.MEDIA_CONCURRENCY, 2)),
  workerMetricsPort: int(process.env.WORKER_METRICS_PORT, 9464),
  backupDir: process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(DATA_DIR, 'backups'),
  backupRetentionDays: int(process.env.BACKUP_RETENTION_DAYS, 30),
};

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.backupDir, { recursive: true });
