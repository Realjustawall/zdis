import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { createSqlite } from './sqlite.js';
import { createPostgres } from './postgres.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('./sqlite.js').ReturnType | null} */
let db = null;
let readDb = null;

/**
 * PostgreSQL is used when the operator points us at one and it actually
 * answers. Anything else — no URL, refused connection, bad credentials — falls
 * back to the SQLite engine bundled inside Node, so the app always starts.
 */
function postgresRequested() {
  return Boolean(config.databaseUrl || process.env.PGHOST || process.env.PGUSER);
}

export async function initDb() {
  if (db) return db;

  if (postgresRequested()) {
    try {
      db = await createPostgres();
    } catch (error) {
      if (config.requirePostgres) throw error;
      logger.warn('postgres unavailable, falling back to sqlite', { error: error.message });
      db = null;
    }
  }

  if (!db) db = createSqlite();

  await migrate(db);
  if (db.dialect === 'postgres' && config.readDatabaseUrl) {
    try {
      readDb = await createPostgres(config.readDatabaseUrl, 'postgres read replica');
    } catch (error) {
      if (config.requireReadReplica) throw error;
      logger.warn('read replica unavailable, using primary', { error: error.message });
      readDb = null;
    }
  }
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

export function getReadDb() {
  return readDb ?? getDb();
}

export function readReplicaMode() {
  return readDb ? 'replica' : 'primary';
}

export async function closeDatabases() {
  if (readDb && readDb !== db) await readDb.close?.();
  await db?.close?.();
  readDb = null;
  db = null;
}

async function migrate(handle) {
  // Multiple API pods may boot together during a rollout. PostgreSQL advisory
  // locking serializes schema upgrades across the cluster.
  if (handle.dialect === 'postgres') {
    return handle.tx(async (tx) => {
      await tx.get('SELECT pg_advisory_xact_lock(?) AS locked', [918_273_645]);
      return migrateUnlocked(tx);
    });
  }
  return migrateUnlocked(handle);
}

async function migrateUnlocked(handle) {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  // Strip full-line comments before splitting. Comments are documentation, and
  // may legitimately contain semicolons; leaving them in would turn the text
  // after such a semicolon into an invalid SQL statement.
  const statements = schema
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  // Existing installations can be missing columns that are already referenced
  // by a new index. Create all tables first, upgrade their columns second, and
  // only then create indexes. This keeps upgrades and fresh installs on the
  // same schema without relying on a particular database engine's error rules.
  const tableStatements = statements.filter((statement) =>
    /^CREATE\s+TABLE\b/i.test(statement),
  );
  const remainingStatements = statements.filter(
    (statement) => !/^CREATE\s+TABLE\b/i.test(statement),
  );

  for (const statement of tableStatements) {
    await handle.exec(statement);
  }

  await addMissingColumns(handle);

  for (const statement of remainingStatements) {
    await handle.exec(statement);
  }

  await runVersionedMigrations(handle);
  // Some additive columns belong to tables introduced by a versioned
  // migration, so run the idempotent column pass once more afterwards.
  await addMissingColumns(handle);

  logger.info('database schema ready', { dialect: handle.dialect, tables: statements.length });
}

async function runVersionedMigrations(handle) {
  await handle.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`,
  );
  const migrationDir = path.join(here, 'migrations');
  if (!fs.existsSync(migrationDir)) return;
  const files = fs
    .readdirSync(migrationDir)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();

  for (const file of files) {
    const applied = await handle.get('SELECT 1 AS ok FROM schema_migrations WHERE version = ?', [
      file,
    ]);
    if (applied) continue;
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    await handle.tx(async (tx) => {
      for (const statement of statements) await tx.exec(statement);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        file,
        Date.now(),
      ]);
    });
    logger.info('versioned migration applied', { version: file });
  }
}

/**
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, so columns introduced after the first release are applied here.
 * Every entry is idempotent — adding one that is already present is a no-op.
 */
const ADDED_COLUMNS = [
  ['users', 'phone', 'TEXT'],
  ['users', 'first_name', 'TEXT'],
  ['users', 'last_name', 'TEXT'],
  ['users', 'nickname', 'TEXT'],
  ['chat_groups', 'discovery_requested', 'INTEGER NOT NULL DEFAULT 0'],
  ['chat_groups', 'discoverable', 'INTEGER NOT NULL DEFAULT 0'],
  ['chat_groups', 'discovery_verified_by', 'TEXT'],
  ['chat_groups', 'discovery_verified_at', 'BIGINT'],
  ['chat_groups', 'require_2fa_moderation', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'owner_streamer_id', 'TEXT'],
  ['channels', 'category_id', 'TEXT'],
  ['channels', 'voice_status', 'TEXT'],
  ['channels', 'permissions_synced', 'INTEGER NOT NULL DEFAULT 1'],
  ['attachments', 'duration_ms', 'INTEGER'],
  ['attachments', 'kind', "TEXT NOT NULL DEFAULT 'file'"],
  ['attachments', 'storage_provider', "TEXT NOT NULL DEFAULT 'local'"],
  ['attachments', 'storage_key', 'TEXT'],
  ['attachments', 'sha256', 'TEXT'],
  ['attachments', 'scan_status', "TEXT NOT NULL DEFAULT 'clean'"],
  ['users', 'suspended_until', 'BIGINT'],
  ['users', 'banned_at', 'BIGINT'],
  ['users', 'moderation_reason', 'TEXT'],
  ['audit_logs', 'previous_hash', 'TEXT'],
  ['audit_logs', 'entry_hash', 'TEXT'],
  ['audit_logs', 'signature_version', 'INTEGER'],
  ['message_reports', 'priority', "TEXT NOT NULL DEFAULT 'normal'"],
  ['message_reports', 'sla_due_at', 'BIGINT'],
  ['message_reports', 'resolved_at', 'BIGINT'],
  ['users', 'shadow_banned_at', 'BIGINT'],
  ['users', 'send_interval_seconds', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'send_restricted_until', 'BIGINT'],
  ['users', 'tts_button_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['messages', 'expires_at', 'BIGINT'],
  ['messages', 'suppress_embeds', 'INTEGER NOT NULL DEFAULT 0'],
  ['attachments', 'processing_status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['attachments', 'preview_provider', 'TEXT'],
  ['attachments', 'preview_key', 'TEXT'],
  ['attachments', 'preview_mime', 'TEXT'],
  ['attachments', 'retention_until', 'BIGINT'],
  ['attachments', 'last_scanned_at', 'BIGINT'],
  ['attachments', 'quarantined_at', 'BIGINT'],
  ['attachments', 'derived_provider', 'TEXT'],
  ['attachments', 'derived_key', 'TEXT'],
  ['attachments', 'derived_mime', 'TEXT'],
  ['notification_preferences', 'quiet_start', 'TEXT'],
  ['notification_preferences', 'quiet_end', 'TEXT'],
  ['notification_preferences', 'timezone', "TEXT NOT NULL DEFAULT 'UTC'"],
  ['notification_preferences', 'digest_frequency', "TEXT NOT NULL DEFAULT 'immediate'"],
  ['notification_preferences', 'digest_hour', 'INTEGER NOT NULL DEFAULT 9'],
  ['server_roles', 'is_default', 'INTEGER NOT NULL DEFAULT 0'],
  ['server_roles', 'hoist', 'INTEGER NOT NULL DEFAULT 0'],
  ['server_roles', 'mentionable', 'INTEGER NOT NULL DEFAULT 0'],
  ['server_roles', 'unicode_emoji', 'TEXT'],
  ['server_roles', 'icon_attachment_id', 'TEXT'],
  ['server_roles', 'secondary_color', 'TEXT'],
  ['server_roles', 'tertiary_color', 'TEXT'],
  ['server_roles', 'in_prompt', 'INTEGER NOT NULL DEFAULT 0'],
  ['server_roles', 'managed', 'INTEGER NOT NULL DEFAULT 0'],
  ['server_roles', 'managed_by', 'TEXT'],
  ['bot_installations', 'role_id', 'TEXT'],
  ['forum_posts', 'private', 'INTEGER NOT NULL DEFAULT 0'],
];

async function addMissingColumns(handle) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    if (!(await hasTable(handle, table))) continue;
    if (await hasColumn(handle, table, column)) continue;
    try {
      await handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      logger.info('schema upgraded', { table, column });
    } catch (error) {
      logger.warn('could not add column', { table, column, error: error.message });
    }
  }
}

async function hasTable(handle, table) {
  if (handle.dialect === 'postgres') {
    return Boolean(
      await handle.get(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ?`,
        [table],
      ),
    );
  }
  return Boolean(
    await handle.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", [table]),
  );
}

async function hasColumn(handle, table, column) {
  if (handle.dialect === 'postgres') {
    const row = await handle.get(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_name = ? AND column_name = ?`,
      [table, column],
    );
    return Boolean(row);
  }
  const rows = await handle.all(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

/** Case-insensitive contains match that behaves the same on both engines. */
export function likeClause(column) {
  return `LOWER(${column}) LIKE ? ESCAPE '\\'`;
}

export function likeValue(term) {
  const escaped = String(term)
    .toLowerCase()
    .replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}
