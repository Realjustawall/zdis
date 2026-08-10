import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const distDir = new URL('../dist/', import.meta.url).pathname;
const failures = [];

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

function webPath(path) {
  return `/${relative(distDir, path).split(sep).join('/')}`;
}

function cleanReference(reference) {
  return reference.split('#')[0].split('?')[0];
}

function isRemote(reference) {
  return /^(?:https?:)?\/\//i.test(reference);
}

async function requireLocalReference(reference, sourcePath) {
  const cleaned = cleanReference(reference);
  if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return;
  if (isRemote(cleaned)) {
    failures.push(`${webPath(sourcePath)} loads a remote build resource: ${reference}`);
    return;
  }

  const target = cleaned.startsWith('/')
    ? join(distDir, cleaned.slice(1))
    : resolve(dirname(sourcePath), cleaned);
  if (!target.startsWith(distDir)) {
    failures.push(`${webPath(sourcePath)} references a file outside dist: ${reference}`);
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error('not a file');
  } catch {
    failures.push(`${webPath(sourcePath)} references a missing local file: ${reference}`);
  }
}

const files = (await listFiles(distDir)).filter((path) => !path.endsWith('.map'));
const filePaths = new Set(files.map(webPath));
const indexPath = join(distDir, 'index.html');
const serviceWorkerPath = join(distDir, 'sw.js');

for (const required of [
  '/index.html',
  '/sw.js',
  '/offline.html',
  '/manifest.webmanifest',
  '/fonts/vazirmatn-arabic.woff2',
  '/fonts/vazirmatn-latin.woff2',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
]) {
  if (!filePaths.has(required)) failures.push(`Required offline asset is missing: ${required}`);
}

const html = await readFile(indexPath, 'utf8');
for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
  await requireLocalReference(match[1], indexPath);
}

for (const cssPath of files.filter((path) => path.endsWith('.css'))) {
  const css = await readFile(cssPath, 'utf8');
  for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
    await requireLocalReference(match[1], cssPath);
  }
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) {
    await requireLocalReference(match[1], cssPath);
  }
}

for (const jsPath of files.filter((path) => path.endsWith('.js') && path !== serviceWorkerPath)) {
  const javascript = await readFile(jsPath, 'utf8');
  for (const match of javascript.matchAll(
    /(?:\bfrom\s*|\bimport\s*\()\s*["']((?:https?:\/\/|\/\/|\/|\.\.?\/)[^"']+)["']/g,
  )) {
    await requireLocalReference(match[1], jsPath);
  }
  for (const match of javascript.matchAll(/\bimportScripts\s*\(\s*["']([^"']+)["']/g)) {
    await requireLocalReference(match[1], jsPath);
  }
}

const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
const precacheMatch = serviceWorker.match(/const PRECACHE_ASSETS = (\[[\s\S]*?\]);/);
if (!precacheMatch) {
  failures.push('The generated service worker has no readable precache manifest.');
} else {
  const precached = new Set(JSON.parse(precacheMatch[1]));
  const expected = new Set([
    '/',
    ...files.filter((path) => path !== serviceWorkerPath).map(webPath),
  ]);
  for (const asset of expected) {
    if (!precached.has(asset)) failures.push(`Build output is not precached: ${asset}`);
  }
  for (const asset of precached) {
    if (isRemote(asset)) failures.push(`Precache contains a remote URL: ${asset}`);
    if (!expected.has(asset)) failures.push(`Precache contains an unknown asset: ${asset}`);
  }
}

if (failures.length) {
  console.error('Offline build verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Offline build verified: ${files.length - 1} local files precached; no remote scripts, styles, or fonts.`,
  );
}
