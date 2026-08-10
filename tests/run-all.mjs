import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.tmp', `test-${process.pid}`);
const inheritedDatabase = process.env.DATABASE_URL || '';
const useExternalDatabase = Boolean(inheritedDatabase);

if (!useExternalDatabase) await fs.rm(dataDir, { recursive: true, force: true });

const testFiles = [
  'tests/migration.test.mjs',
  'tests/antivirus.test.mjs',
  'tests/backup-restore.test.mjs',
  'tests/turn.test.mjs',
  'tests/e2ee-migration.test.mjs',
  'tests/api.test.mjs',
  'tests/realtime.test.mjs',
  'tests/network.test.mjs',
  'tests/enterprise.test.mjs',
  'tests/platform-e2ee.test.mjs',
];

function run(file, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`)),
    );
  });
}

await run(testFiles[0]);
await run(testFiles[1]);
await run(testFiles[2]);
await run(testFiles[3]);
await run(testFiles[4]);

const serverEnv = {
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  PORT: '4000',
  WORKER_METRICS_PORT: '9464',
  DATA_DIR: dataDir,
  APP_SECRET: 'test-only-secret-that-is-longer-than-thirty-two-characters',
  AUDIT_SIGNING_KEY: 'test-only-audit-key-that-is-longer-than-thirty-two-characters',
  DLP_MODE: 'block',
  S3_PUBLIC_ENDPOINT: 'https://media.test.example/files',
  SEED_ADMIN_EMAIL: 'office@intesho.com',
  SEED_ADMIN_USERNAME: 'admin',
  SEED_ADMIN_PASSWORD: 'cNL2*8o$1F;"',
};
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: root,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let worker = null;
let workerOutput = '';

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`test server exited early:\n${serverOutput}`);
    }
    try {
      const response = await fetch('http://localhost:4000/api/ready');
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`test server did not become ready:\n${serverOutput}`);
}

try {
  await waitForServer();
  if (process.env.REDIS_URL || process.env.REDIS_CLUSTER_NODES) {
    worker = spawn(process.execPath, ['server/src/scripts/worker.js'], {
      cwd: root,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    worker.stdout.on('data', (chunk) => {
      workerOutput += chunk;
    });
    worker.stderr.on('data', (chunk) => {
      workerOutput += chunk;
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (worker.exitCode !== null) throw new Error(`test worker exited early:\n${workerOutput}`);
      try {
        if ((await fetch('http://localhost:9464/health')).ok) break;
      } catch {
        // Worker is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (Date.now() >= deadline) throw new Error(`test worker did not become ready:\n${workerOutput}`);
  }
  for (const file of testFiles.slice(5)) await run(file);
} finally {
  worker?.kill('SIGTERM');
  server.kill('SIGTERM');
  await Promise.all(
    [worker, server].filter(Boolean).map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('exit', resolve);
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5_000).unref();
        }),
    ),
  );
  if (!useExternalDatabase) await fs.rm(dataDir, { recursive: true, force: true });
}
