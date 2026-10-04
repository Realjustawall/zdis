import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zdis-sqlite-isolation-'));
process.env.DATA_DIR = dir;
process.env.SQLITE_FILE = path.join(dir, 'test.sqlite3');
process.env.APP_SECRET = 'sqlite-isolation-test-secret-longer-than-thirty-two-characters';
const { createSqlite } = await import('../server/src/db/sqlite.js');
const db = createSqlite();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await db.exec('CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, value TEXT)');
  await Promise.all(Array.from({ length: 20 }, (_, id) => db.tx(async (tx) => {
    await tx.run('INSERT INTO tx_probe VALUES (?, ?)', [id, 'committed']);
    await pause(2);
    assert.equal((await tx.get('SELECT value FROM tx_probe WHERE id = ?', [id])).value, 'committed');
  })));
  assert.equal((await db.get('SELECT count(*) AS n FROM tx_probe')).n, 20);
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const rollback = db.tx(async (tx) => {
    await tx.run('INSERT INTO tx_probe VALUES (?, ?)', [100, 'rolled back']);
    notifyStarted();
    await pause(20);
    throw new Error('intentional rollback');
  });
  // Register rejection immediately; the unrelated request must wait outside this transaction.
  const expectedFailure = assert.rejects(rollback, /intentional rollback/);
  await started;
  await db.run('INSERT INTO tx_probe VALUES (?, ?)', [101, 'independent']);
  await expectedFailure;
  assert.equal(await db.get('SELECT * FROM tx_probe WHERE id = 100'), null);
  assert.equal((await db.get('SELECT value FROM tx_probe WHERE id = 101')).value, 'independent');
  // A write queued just before BEGIN must not accidentally join its rollback.
  const earlyWrite = db.run('INSERT INTO tx_probe VALUES (?, ?)', [102, 'queued-before']);
  const laterRollback = assert.rejects(db.tx(async (tx) => {
    await tx.run('INSERT INTO tx_probe VALUES (?, ?)', [103, 'rolled-back']);
    throw new Error('later rollback');
  }), /later rollback/);
  await Promise.all([earlyWrite, laterRollback]);
  assert.equal((await db.get('SELECT value FROM tx_probe WHERE id = 102'))?.value, 'queued-before');
  assert.equal(await db.get('SELECT * FROM tx_probe WHERE id = 103'), null);
  console.log('PASS: twenty concurrent SQLite transactions and rollback isolation for unrelated writes before and during BEGIN');
} finally {
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
