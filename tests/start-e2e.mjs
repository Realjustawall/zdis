import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.tmp', 'e2e');
await fs.rm(dataDir, { recursive: true, force: true });

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  PORT: '4000',
  DATA_DIR: dataDir,
  APP_SECRET: 'e2e-only-secret-that-is-longer-than-thirty-two-characters',
  DLP_MODE: 'block',
  SEED_ADMIN_EMAIL: 'office@intesho.com',
  SEED_ADMIN_USERNAME: 'admin',
  SEED_ADMIN_PASSWORD: 'cNL2*8o$1F;"',
});

await import('../server/src/index.js');
