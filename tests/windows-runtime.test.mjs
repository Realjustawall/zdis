import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const externalCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zdis-windows-cwd-'));
const relativeData = `.tmp/windows-runtime-${process.pid}`;
const data = path.join(root, relativeData);
const env = { ...process.env, DATA_DIR: relativeData, SQLITE_FILE: `${relativeData}/nested/test.sqlite3`, APP_SECRET: 'windows-test-secret-at-least-thirty-two-characters', PGHOST: 'unreachable.invalid', PGUSER: 'inherited-user', DATABASE_URL: 'postgres://invalid:invalid@unreachable.invalid/db', REQUIRE_POSTGRES: 'false', REQUIRE_READ_REPLICA: 'false' };
delete env.DATABASE_DRIVER;
const configUrl = pathToFileURL(path.join(root, 'server/src/config.js')).href;
const dbUrl = pathToFileURL(path.join(root, 'server/src/db/index.js')).href;
try {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { config } = await import(${JSON.stringify(configUrl)});
    assert.equal(config.dataDir, ${JSON.stringify(data)});
    assert.equal(config.databaseDriver, 'sqlite');
    const { initDb, closeDatabases } = await import(${JSON.stringify(dbUrl)});
    let db = await initDb();
    assert.equal(db.dialect, 'sqlite');
    await db.exec('CREATE TABLE windows_runtime_probe (id INTEGER PRIMARY KEY, value TEXT)');
    await db.run('INSERT INTO windows_runtime_probe VALUES (?, ?)', [1, 'persisted']);
    for (let i = 0; i < 200; i++) assert.equal((await db.get('SELECT value FROM windows_runtime_probe WHERE id = ?', [1])).value, 'persisted');
    await db.exec('ALTER TABLE windows_runtime_probe ADD COLUMN extra TEXT');
    await db.run('UPDATE windows_runtime_probe SET extra = ? WHERE id = ?', ['new-column', 1]);
    await closeDatabases();
    db = await initDb();
    assert.equal((await db.get('SELECT * FROM windows_runtime_probe WHERE id = ?', [1])).extra, 'new-column');
    await closeDatabases();
  `], { cwd: externalCwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout);
  console.log('PASS: SQLite default ignores inherited PostgreSQL settings; relative paths, nested directory, cached queries, schema change and restart persist correctly.');
} finally {
  await fs.rm(data, { recursive: true, force: true });
  await fs.rm(externalCwd, { recursive: true, force: true });
}
