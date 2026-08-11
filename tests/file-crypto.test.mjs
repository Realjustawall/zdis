import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { transformWithEsbuild } from '../client/node_modules/vite/dist/node/index.js';

const source = await fs.readFile(new URL('../client/src/lib/fileCrypto.ts', import.meta.url), 'utf8');
const transformed = await transformWithEsbuild(source, 'fileCrypto.ts', { loader: 'ts', format: 'esm' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
const { encryptUploadFile, decryptAttachment } = await import(moduleUrl);

const clear = crypto.randomBytes(9 * 1024 * 1024 + 137);
const encrypted = await encryptUploadFile(new File([clear], 'large.log', { type: 'text/plain' }));
const stored = Buffer.from(await encrypted.file.arrayBuffer());
const ranges = [];
const server = http.createServer((request, response) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  if (match) {
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), stored.length - 1);
    ranges.push([start, end]);
    response.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${stored.length}`,
      'content-length': end - start + 1,
    });
    response.end(stored.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { 'content-length': stored.length });
  response.end(stored);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  const progress = [];
  const decrypted = await decryptAttachment(
    `http://127.0.0.1:${address.port}/file`,
    encrypted.metadata,
    (value) => progress.push(value),
  );
  assert.deepEqual(Buffer.from(await decrypted.arrayBuffer()), clear);
  assert.equal(progress.at(-1), 1);
  assert.ok(ranges.length >= 4, 'decryption did not use range requests');
  assert.equal(ranges[0][1] - ranges[0][0] + 1, 20, 'header request was not bounded');
  assert.ok(
    ranges.slice(1).every(([start, end]) => end - start + 1 <= 4 * 1024 * 1024 + 16),
    'a ciphertext range exceeded one authenticated chunk',
  );
  console.log('  PASS  chunked file encryption uses bounded authenticated ranges');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
