import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.tmp', `e2e-${process.pid}`);
const port = process.env.TEST_E2E_PORT || (process.platform === 'win32' ? '18081' : '4000');
await fs.rm(dataDir, { recursive: true, force: true });

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  PORT: port,
  HOST: '127.0.0.1',
  SQLITE_FILE: path.join(dataDir, 'e2e.sqlite3'),
  PUBLIC_URL: 'http://127.0.0.1:' + port,
  CLIENT_ORIGIN: 'http://127.0.0.1:' + port,
  DATABASE_DRIVER: 'sqlite',
  DATABASE_URL: '',
  REDIS_URL: '',
  REDIS_CLUSTER_NODES: '',
  REQUIRE_REDIS: 'false',
  REQUIRE_POSTGRES: 'false',
  AUDIT_SIGNING_KEY: 'e2e-only-audit-key-that-is-longer-than-thirty-two-characters',
  DATA_DIR: dataDir,
  APP_SECRET: 'e2e-only-secret-that-is-longer-than-thirty-two-characters',
  DLP_MODE: 'block',
  SEED_ADMIN_EMAIL: 'office@intesho.com',
  SEED_ADMIN_USERNAME: 'admin',
  SEED_ADMIN_PASSWORD: 'cNL2*8o$1F;"',
});

await import('../server/src/index.js');
for (let attempt = 0; attempt < 100; attempt++) {
  if (await fetch(process.env.PUBLIC_URL + '/api/ready').then(r => r.ok).catch(() => false)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}

// Browser suites share this disposable administrator; production quotas remain unchanged.
const { getDb } = await import('../server/src/db/index.js');
const db = getDb();
const admin = await db.get('SELECT id FROM users WHERE username=?', ['admin']);
await db.run('INSERT INTO user_access_policies(user_id,policy,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at',
  [admin.id, JSON.stringify({ maxOwnedGroups: 500, maxJoinedGroups: 500 }), admin.id, Date.now()]);
