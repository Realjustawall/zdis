import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { withBootstrapLock } from '../server/src/services/bootstrapLock.js';

test('Bootstrap lock surrounds provisioning with the PostgreSQL transaction lock', async () => {
  const calls = [];
  const db = { dialect: 'postgres', tx: async (fn) => {
    calls.push('begin');
    try { return await fn({ get: async (sql, params) => {
      assert.match(sql, /pg_advisory_xact_lock/);
      assert.deepEqual(params, [918_273_646]);
      calls.push('locked');
    } }); } finally { calls.push('release'); }
  } };
  assert.equal(await withBootstrapLock(async () => { calls.push('provision'); return 42; }, db), 42);
  assert.deepEqual(calls, ['begin', 'locked', 'provision', 'release']);
  const failure = new Error('provision failed');
  await assert.rejects(withBootstrapLock(async () => { throw failure; }, db), (error) => error === failure);
  assert.equal(calls.at(-1), 'release');
});

test('SQLite bootstrap retains its existing local transaction behavior', async () => {
  assert.equal(await withBootstrapLock(async () => 'ready', {
    dialect: 'sqlite', tx: () => { throw Error('unexpected outer transaction'); },
  }), 'ready');
});

test('Four PostgreSQL processes seed one administrator and the same official bots', {
  skip: !process.env.DATABASE_URL,
  timeout: 90_000,
}, async () => {
  const suffix = crypto.randomBytes(5).toString('hex');
  const env = { ...process.env, DATABASE_DRIVER: 'postgres', REQUIRE_POSTGRES: 'true',
    SEED_ADMIN_EMAIL: `bootstrap-${suffix}@example.test`, SEED_ADMIN_USERNAME: `bootstrap${suffix}`,
    SEED_ADMIN_PASSWORD: 'Bootstrap-Regression-Password-2026!' };
  const program = `
    const {initDb,closeDatabases}=await import('./server/src/db/index.js');
    const {initCache,closeCache}=await import('./server/src/cache/index.js');
    const {ensureBadgeCatalogue}=await import('./server/src/services/badges.js');
    const {ensureSeedAdmin}=await import('./server/src/scripts/seed.js');
    const {ensureBuiltinBots}=await import('./server/src/services/builtinBots.js');
    await initDb(); await initCache(); await ensureBadgeCatalogue();
    process.on('message',async()=>{try{
      const admin=await ensureSeedAdmin();const bots=await ensureBuiltinBots();
      process.send({result:{admin:admin.id,bots}});
      await closeCache();await closeDatabases();process.exit(0);
    }catch(error){console.error(error);process.exit(1);}});
    process.send({ready:true});
  `;
  const children = [];
  try {
    const jobs = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
        cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      });
      children.push(child);
      let output = '', result, readyResolve, readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('message', (message) => {
        if (message.ready) readyResolve();
        if (message.result) result = message.result;
      });
      const done = new Promise((resolve, reject) => {
        child.once('error', (error) => { readyReject(error); reject(error); });
        child.once('exit', (code) => {
          if (code === 0 && result) resolve(result);
          else { const error = Error(`Bootstrap process exited ${code}: ${output.slice(-10000)}`); readyReject(error); reject(error); }
        });
      });
      // Observe early failures while the other processes are reaching the barrier.
      done.catch(() => {});
      return { child, ready, done };
    });
    await Promise.all(jobs.map((job) => job.ready));
    for (const job of jobs) job.child.send('start');
    const results = await Promise.all(jobs.map((job) => job.done));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.notEqual(results[0].bots.welcomer, results[0].bots.moderator);
    assert.ok(results[0].admin);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});
