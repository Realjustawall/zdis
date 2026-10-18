import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function checkWorker(command, label) {
  assert.equal(command[0], 'node', `${label} must run without npm in the runtime image`);
  assert.equal(command.at(-1), 'server/src/scripts/worker.js');
  assert.ok(fs.existsSync(path.join(root, command.at(-1))));
  const importIndex = command.indexOf('--import');
  assert.ok(importIndex > 0, `${label} must preserve telemetry initialization`);
  assert.ok(fs.existsSync(path.join(root, command[importIndex + 1])));
}

for (const variant of ['scale', 'enterprise']) {
  test(`${variant}: PostgreSQL selection and worker command/health match the runtime image`, () => {
    const compose = parse(read(`infra/docker-compose.${variant}.yml`), { merge: true });
    for (const [name, service] of Object.entries(compose.services)) {
      const env = service.environment;
      if (!env?.REQUIRE_POSTGRES) continue;
      assert.equal(env.DATABASE_DRIVER, 'postgres', `${name} must select PostgreSQL explicitly`);
      assert.ok(env.DATABASE_URL.includes('postgres://'));
    }
    const worker = compose.services.worker;
    checkWorker(worker.command, variant);
    const port = worker.environment.WORKER_METRICS_PORT || 9464;
    assert.equal(worker.healthcheck.test.at(-1), `http://127.0.0.1:${port}/health`);
    assert.equal(compose.services['app-1'].healthcheck.test.at(-1), 'http://127.0.0.1:4000/api/ready');
  });
}

test('Kubernetes selects PostgreSQL and starts its worker directly with telemetry', () => {
  const docs = parseAllDocuments(read('infra/kubernetes/app.yaml')).map((doc) => {
    assert.deepEqual(doc.errors, []);
    return doc.toJS();
  });
  const config = docs.find((doc) => doc.kind === 'ConfigMap' && doc.metadata.name === 'zdis-config');
  assert.equal(config.data.REQUIRE_POSTGRES, 'true');
  assert.equal(config.data.DATABASE_DRIVER, 'postgres');
  const workers = docs.filter((doc) => doc.kind === 'Deployment')
    .flatMap((doc) => doc.spec.template.spec.containers)
    .filter((container) => container.command?.at(-1) === 'server/src/scripts/worker.js');
  assert.equal(workers.length, 1);
  checkWorker(workers[0].command, 'Kubernetes');
  assert.equal(workers[0].readinessProbe.httpGet.path, '/health');
});

test('Standalone Ubuntu and Windows installers retain their explicit SQLite default', () => {
  for (const file of ['.env.example', 'ubuntu/.env.ubuntu.example', 'windows/.env.windows.example']) {
    assert.match(read(file), /^DATABASE_DRIVER=sqlite\s*$/m, file);
  }
});
