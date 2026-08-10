import { io } from 'socket.io-client';
import { writeFile } from 'node:fs/promises';

const baseUrl = process.env.LOAD_BASE_URL || 'http://127.0.0.1:4000';
const connections = Number(process.env.LOAD_CONNECTIONS || 3000);
const rampPerSecond = Number(process.env.LOAD_RAMP_PER_SECOND || 200);
const holdSeconds = Number(process.env.LOAD_HOLD_SECONDS || 60);
const minimumSuccessRate = Number(process.env.LOAD_MIN_SUCCESS_RATE || 0.99);
const maxP95Ms = Number(process.env.LOAD_MAX_P95_MS || 5000);
const maxDisconnectRate = Number(
  process.env.LOAD_MAX_DISCONNECT_RATE || 1 - minimumSuccessRate,
);
const reconnect = process.env.LOAD_RECONNECT === 'true';
const reportFile = process.env.LOAD_REPORT_FILE;
const email = process.env.LOAD_EMAIL || 'office@intesho.com';
const password = process.env.LOAD_PASSWORD;

if (!password) {
  console.error('LOAD_PASSWORD is required. Use a dedicated non-admin load-test account.');
  process.exit(2);
}
if (!Number.isInteger(connections) || connections < 1 || connections > 20_000) {
  console.error('LOAD_CONNECTIONS must be between 1 and 20000.');
  process.exit(2);
}

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: email, password }),
});
if (!login.ok) {
  console.error(`Load account login failed (${login.status}): ${await login.text()}`);
  process.exit(2);
}
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(';', 1)[0])
  .join('; ');

const sockets = [];
const latencies = [];
let connected = 0;
let failed = 0;
let disconnectedDuringHold = 0;
let recovered = 0;
const startedAt = Date.now();

function openConnection(index) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = io(baseUrl, {
      transports: ['websocket'],
      reconnection: reconnect,
      reconnectionAttempts: reconnect ? Number.POSITIVE_INFINITY : 0,
      reconnectionDelay: 250,
      reconnectionDelayMax: 2000,
      timeout: 15_000,
      extraHeaders: { Cookie: cookie },
    });
    sockets.push(socket);
    let initiallyResolved = false;
    let hadConnected = false;
    const deadline = setTimeout(() => {
      if (initiallyResolved) return;
      initiallyResolved = true;
      failed += 1;
      resolve();
    }, 30_000);
    socket.on('connect', () => {
      if (hadConnected) recovered += 1;
      hadConnected = true;
      if (!initiallyResolved) {
        initiallyResolved = true;
        clearTimeout(deadline);
        connected += 1;
        latencies.push(performance.now() - started);
        if (index % 25 === 0) socket.emit('presence:set', { presence: 'online' });
        resolve();
      }
    });
    socket.on('connect_error', () => {
      if (!reconnect && !initiallyResolved) {
        initiallyResolved = true;
        clearTimeout(deadline);
        failed += 1;
        resolve();
      }
    });
    socket.on('disconnect', () => {
      if (Date.now() < holdUntil) disconnectedDuringHold += 1;
    });
  });
}

let holdUntil = Number.POSITIVE_INFINITY;
for (let offset = 0; offset < connections; offset += rampPerSecond) {
  const batchSize = Math.min(rampPerSecond, connections - offset);
  await Promise.all(
    Array.from({ length: batchSize }, (_, index) => openConnection(offset + index)),
  );
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  console.log(
    `ramp ${connected + failed}/${connections}; connected=${connected}; ` +
      `failed=${failed}; rate=${Math.round((connected + failed) / elapsedSeconds)}/s`,
  );
  if (offset + batchSize < connections) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

holdUntil = Date.now() + holdSeconds * 1000;
console.log(`holding ${connected} WebSocket connections for ${holdSeconds}s`);
const heartbeat = setInterval(() => {
  const sample = sockets.find((socket) => socket.connected);
  sample?.emit('presence:set', { presence: 'online' });
}, 10_000);
await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
clearInterval(heartbeat);

const connectedAtEnd = sockets.filter((socket) => socket.connected).length;
for (const socket of sockets) socket.disconnect();
latencies.sort((a, b) => a - b);
const percentile = (value) =>
  latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)] ?? 0;
const successRate = connected / connections;
const report = {
  requested: connections,
  connected,
  failed,
  disconnectedDuringHold,
  recovered,
  connectedAtEnd,
  successRate,
  connectLatencyMs: {
    p50: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    p99: Math.round(percentile(0.99)),
  },
  durationSeconds: Math.round((Date.now() - startedAt) / 1000),
};
console.log(JSON.stringify(report, null, 2));
if (reportFile) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);

if (
  successRate < minimumSuccessRate ||
  report.connectLatencyMs.p95 > maxP95Ms ||
  disconnectedDuringHold > connections * maxDisconnectRate ||
  (reconnect && connectedAtEnd < connections * minimumSuccessRate)
) {
  process.exitCode = 1;
}
