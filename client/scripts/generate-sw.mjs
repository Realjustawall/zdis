import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const distDir = new URL('../dist/', import.meta.url);
const serviceWorkerPath = new URL('../dist/sw.js', import.meta.url);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }

  return files;
}

const emittedFiles = (await listFiles(distDir.pathname))
  .filter((path) => path !== serviceWorkerPath.pathname && !path.endsWith('.map'))
  .sort();

const assets = emittedFiles.map((path) => `/${relative(distDir.pathname, path).split(sep).join('/')}`);
if (assets.includes('/index.html')) assets.unshift('/');

let source = await readFile(serviceWorkerPath, 'utf8');
const fingerprint = createHash('sha256');
fingerprint.update(source);
for (const path of emittedFiles) {
  fingerprint.update(relative(distDir.pathname, path));
  fingerprint.update(await readFile(path));
}
const version = `zdis-pwa-${fingerprint.digest('hex').slice(0, 16)}`;

source = source.replace(
  "const VERSION = 'zdis-pwa-dev'; // __CACHE_VERSION__",
  `const VERSION = '${version}';`,
);
source = source.replace(
  /const PRECACHE_ASSETS = \[[\s\S]*?\]; \/\/ __PRECACHE_ASSETS__/,
  `const PRECACHE_ASSETS = ${JSON.stringify(assets, null, 2)};`,
);

if (source.includes('__CACHE_VERSION__') || source.includes('__PRECACHE_ASSETS__')) {
  throw new Error('Could not replace the service-worker build placeholders.');
}

await writeFile(serviceWorkerPath, source);
console.log(`Generated ${version} with ${assets.length} precached files.`);
