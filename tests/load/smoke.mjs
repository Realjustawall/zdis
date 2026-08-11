import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const server = spawn(process.execPath, ['tests/start-e2e.mjs'], {
  cwd: root,
  env: { ...process.env, LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
server.stdout.on('data', (chunk) => {
  output += chunk;
});
server.stderr.on('data', (chunk) => {
  output += chunk;
});

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`load server exited early:\n${output}`);
    try {
      if ((await fetch('http://127.0.0.1:4000/api/ready')).ok) break;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (Date.now() >= deadline) throw new Error(`load server did not become ready:\n${output}`);

  await new Promise((resolve, reject) => {
    const load = spawn(process.execPath, ['tests/load/realtime-load.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        LOAD_PASSWORD: 'cNL2*8o$1F;"',
        LOAD_CONNECTIONS: process.env.LOAD_SMOKE_CONNECTIONS || '100',
        LOAD_RAMP_PER_SECOND: process.env.LOAD_SMOKE_RAMP_PER_SECOND || '50',
        LOAD_HOLD_SECONDS: process.env.LOAD_SMOKE_HOLD_SECONDS || '2',
        LOAD_MAX_P95_MS: '8000',
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    load.once('error', reject);
    load.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`load smoke test exited ${code}`)),
    );
  });
} finally {
  server.kill('SIGTERM');
}
