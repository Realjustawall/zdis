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
