import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const namespace = process.env.CHAOS_NAMESPACE || 'youtbelimo';
const baseUrl = process.env.CHAOS_BASE_URL;
const confirm = process.env.CHAOS_CONFIRM === 'yes';
const target = process.env.CHAOS_TARGET || 'api';
const maxRecoverySeconds = Number(process.env.CHAOS_MAX_RECOVERY_SECONDS || 180);

if (!baseUrl) throw new Error('CHAOS_BASE_URL is required.');
if (!confirm) {
  throw new Error('Refusing disruptive drill. Set CHAOS_CONFIRM=yes after selecting a test cluster.');
}

const kubectl = (...args) =>
  run('kubectl', ['--namespace', namespace, ...args], {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });

async function healthy() {
  try {
    const response = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

let selector;
if (target === 'api') selector = 'app.kubernetes.io/name=youtbelimo,app.kubernetes.io/component=api';
else if (target === 'redis') selector = 'app.kubernetes.io/name=redis-cluster';
else if (target === 'postgres') selector = 'cnpg.io/instanceRole=primary';
else throw new Error('CHAOS_TARGET must be api, redis or postgres.');

const before = JSON.parse((await kubectl('get', 'pods', '-l', selector, '-o', 'json')).stdout);
const pod = before.items[0]?.metadata?.name;
if (!pod) throw new Error(`No ${target} pod found.`);
const startedAt = Date.now();
await kubectl('delete', 'pod', pod, '--wait=false');
let downtimeStarted = null;
let recoveredAt = null;
while (Date.now() - startedAt < maxRecoverySeconds * 1000) {
  const ok = await healthy();
  if (!ok && downtimeStarted === null) downtimeStarted = Date.now();
  if (ok && downtimeStarted !== null) {
    recoveredAt = Date.now();
    break;
  }
  if (ok && Date.now() - startedAt > 15_000) {
    recoveredAt = Date.now();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!recoveredAt) throw new Error(`${target} failover did not recover within ${maxRecoverySeconds}s.`);
console.log(
  JSON.stringify(
    {
      target,
      deletedPod: pod,
      totalRecoverySeconds: (recoveredAt - startedAt) / 1000,
      observedDowntimeSeconds: downtimeStarted ? (recoveredAt - downtimeStarted) / 1000 : 0,
    },
    null,
    2,
  ),
);
