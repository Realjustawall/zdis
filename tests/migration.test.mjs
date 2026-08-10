import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = await mkdtemp(path.join(tmpdir(), 'youtbelimo-migration-'));
const databaseFile = path.join(dataDir, 'legacy.db');
const database = new DatabaseSync(databaseFile);

// The last pre-badge schema: these tables exist, but the columns introduced by
// the interrupted upgrade do not. Index creation must wait until they are added.
database.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL, password_hash TEXT NOT NULL, password_changed_at BIGINT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'member',
    avatar_url TEXT, banner_color TEXT, bio TEXT, presence TEXT NOT NULL DEFAULT 'offline',
    custom_status TEXT, is_active INTEGER NOT NULL DEFAULT 1, totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0, failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until BIGINT, last_login_at BIGINT, last_seen_at BIGINT, created_by TEXT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, topic TEXT,
    type TEXT NOT NULL DEFAULT 'text', position INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0, slowmode INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, message_id TEXT, uploader_id TEXT NOT NULL, filename TEXT NOT NULL,
    stored_name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, width INTEGER,
    height INTEGER, created_at BIGINT NOT NULL
  );
`);
database.close();

const port = 4100 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    SQLITE_FILE: databaseFile,
    SEED_ADMIN_EMAIL: `migration-${port}@example.com`,
    SEED_ADMIN_USERNAME: `migration${port}`,
    SEED_ADMIN_PASSWORD: 'Migration-Pass#26',
    DATABASE_URL: '',
    REDIS_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      healthy = response.ok;
      if (healthy) break;
    } catch {
      // Startup is still in progress.
    }
  }
  if (!healthy) throw new Error(`upgraded server did not start\n${output}`);

  const upgraded = new DatabaseSync(databaseFile);
  for (const [table, column] of [
    ['users', 'owner_streamer_id'],
    ['channels', 'category_id'],
    ['attachments', 'duration_ms'],
    ['attachments', 'kind'],
    ['attachments', 'storage_provider'],
    ['attachments', 'storage_key'],
    ['attachments', 'sha256'],
    ['attachments', 'scan_status'],
    ['users', 'suspended_until'],
    ['users', 'banned_at'],
    ['audit_logs', 'previous_hash'],
    ['audit_logs', 'entry_hash'],
    ['audit_logs', 'signature_version'],
    ['messages', 'expires_at'],
    ['scheduled_messages', 'encrypted'],
  ]) {
    const names = upgraded.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!names.includes(column)) throw new Error(`${table}.${column} was not migrated`);
  }
  const tables = upgraded
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  upgraded.close();
  if (
    !tables.includes('badges') ||
    !tables.includes('collabs') ||
    !tables.includes('schema_migrations') ||
    !tables.includes('message_reports') ||
    !tables.includes('notifications') ||
    !tables.includes('backup_runs') ||
    !tables.includes('recovery_codes') ||
    !tables.includes('external_identities') ||
    !tables.includes('security_events') ||
    !tables.includes('audit_chain_state') ||
    !tables.includes('moderation_evidence') ||
    !tables.includes('moderation_appeals') ||
    !tables.includes('custom_roles') ||
    !tables.includes('user_custom_roles') ||
    !tables.includes('message_drafts') ||
    !tables.includes('scheduled_messages') ||
    !tables.includes('polls') ||
    !tables.includes('poll_options') ||
    !tables.includes('poll_votes') ||
    !tables.includes('saved_messages')
    || !tables.includes('runtime_configuration')
    || !tables.includes('e2ee_identities')
    || !tables.includes('api_keys')
    || !tables.includes('bots')
    || !tables.includes('outgoing_webhooks')
    || !tables.includes('webhook_deliveries')
    || !tables.includes('sync_events')
    || !tables.includes('storage_quotas')
    || !tables.includes('storage_reservations')
    || !tables.includes('resumable_uploads')
    || !tables.includes('resumable_parts')
    || !tables.includes('call_rooms')
    || !tables.includes('call_lobby')
    || !tables.includes('call_consents')
    || !tables.includes('call_recordings')
    || !tables.includes('call_transcript_segments')
    || !tables.includes('call_quality_samples')
    || !tables.includes('notification_channel_preferences')
    || !tables.includes('notification_digest_items')
    || !tables.includes('notification_dead_letters')
  ) {
    throw new Error('new network and enterprise tables were not created');
  }
  console.log('  PASS  legacy database upgrades before dependent indexes');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
  await rm(dataDir, { recursive: true, force: true });
}
