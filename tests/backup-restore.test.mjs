import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.tmp', `backup-test-${process.pid}`);
await fs.rm(dataDir, { recursive: true, force: true });
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  APP_SECRET: 'backup-test-secret-that-is-longer-than-thirty-two-characters',
  BACKUP_RETENTION_DAYS: '7',
  STORAGE_DRIVER: 'local',
});

const { initDb, getDb } = await import('../server/src/db/index.js');
const { runBackup, restoreBackup, verifyBackup } = await import('../server/src/services/backups.js');
const { config } = await import('../server/src/config.js');

await initDb();
await getDb().run(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ['restore_test_marker', 'before-backup', Date.now()],
);
await fs.mkdir(config.uploadDir, { recursive: true });
await fs.writeFile(path.join(config.uploadDir, 'restore-test.txt'), 'backup payload');

const backup = await runBackup();
const verified = await verifyBackup(backup.location);
if (!verified.ok) throw new Error('backup verification failed');

await getDb().run('UPDATE settings SET value = ? WHERE key = ?', [
  'after-backup',
  'restore_test_marker',
]);
await fs.writeFile(path.join(config.uploadDir, 'restore-test.txt'), 'modified payload');
await restoreBackup(backup.location, { confirmed: true });

let marker;
if (getDb().dialect === 'sqlite') {
  const restored = new DatabaseSync(config.sqliteFile, { readOnly: true });
  marker = restored
    .prepare("SELECT value FROM settings WHERE key = 'restore_test_marker'")
    .get();
  restored.close();
} else {
  marker = await getDb().get("SELECT value FROM settings WHERE key = 'restore_test_marker'");
  await getDb().close?.();
}
if (marker?.value !== 'before-backup') throw new Error('database recovery did not restore snapshot');
if ((await fs.readFile(path.join(config.uploadDir, 'restore-test.txt'), 'utf8')) !== 'backup payload') {
  throw new Error('upload recovery did not restore snapshot');
}

await fs.rm(dataDir, { recursive: true, force: true });
console.log('  PASS  backup archive verification and destructive restore drill');
