import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientSourceRoot = path.join(root, 'client', 'src');
const sourceRoots = [clientSourceRoot, path.join(root, 'server', 'src')];
const outputRoot = path.join(clientSourceRoot, 'language');
const rootOutputRoot = path.join(root, 'language');
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
  }
}

function decode(value) {
  return value
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleCandidate(value) {
  const text = decode(value);
  if (text.length < 2 || text.length > 240) return null;
  if (/^(https?:\/\/|\/api\/|--|#[0-9a-f]{3,8}$)/i.test(text)) return null;
  if (/[{};]|=>|\b(?:const|return|function|await|async|import|export|class|interface|SELECT|UPDATE|INSERT)\b/.test(text)) return null;
  if (/^(?:[\W_]|\d|[\d\s:./?%#-])+$/.test(text)) return null;
  if (/^(?:[.#/]|\(|\[|\{|')/.test(text)) return null;
  if (/(?:var\(|rgba?\(|px\b|rem\b|vw\b|vh\b|\/api\/|window\.|event\.|current[A-Z]|api\.|set[A-Z]|\?\.)/.test(text)) return null;
  if (/^[^\s]+\s+[^\s]+\s+[^\s]+$/.test(text) && /[.:/()[\]]/.test(text)) return null;
  if (/^[\W_]+$/.test(text)) return null;
  if (/^[A-Za-z0-9_./:@#?=&%+{}$()[\]-]+$/.test(text) && !/\s/.test(text)) {
    const common = new Set([
      'Add', 'Back', 'Ban', 'Cancel', 'Close', 'Copy', 'Create', 'Delete', 'Done',
      'Edit', 'Loading', 'Manage', 'Next', 'Open', 'Remove', 'Reply', 'Report',
      'Save', 'Search', 'Send', 'Settings', 'Share', 'Submit', 'Test', 'View',
      'Yes', 'No', 'Owner', 'Admin', 'Moderator', 'Unknown', 'Expired', 'Never',
    ]);
    if (!common.has(text)) return null;
  }
  if (/^(fa|en|ltr|rtl|primary|secondary|small|large|true|false|null|undefined|user|channel|message|group|role|member|admin|open|closed|active|inactive)$/i.test(text)) return null;
  return text;
}

for (const sourceRoot of sourceRoots) walk(sourceRoot);
const strings = new Set();
for (const file of files) {
  let source = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const match of source.matchAll(/>([^<>\n]{2,240})</g)) {
    const value = visibleCandidate(match[1]);
    if (value) strings.add(value);
  }
  for (const match of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\n])*?)\1/g)) {
    if (match[1] === '`' && match[2].includes('${')) continue;
    const value = visibleCandidate(match[2]);
    if (value) strings.add(value);
  }
}

const currentEn = JSON.parse(fs.readFileSync(path.join(outputRoot, 'en.json'), 'utf8'));
const currentFa = JSON.parse(fs.readFileSync(path.join(outputRoot, 'fa.json'), 'utf8'));
const existingEn = Object.fromEntries(Object.entries(currentEn).filter(([key]) => !key.startsWith('text.')));
const existingFa = Object.fromEntries(Object.entries(currentFa).filter(([key]) => !key.startsWith('text.')));
const catalog = Object.fromEntries([...strings].sort((a, b) => a.localeCompare(b)).map((value) => [`text.${value}`, value]));
const preservedText = (current) => Object.fromEntries(
  Object.keys(catalog)
    .filter((key) => typeof current[key] === 'string')
    .map((key) => [key, current[key]]),
);
const en = { ...catalog, ...preservedText(currentEn), ...existingEn };
const fa = { ...catalog, ...preservedText(currentFa), ...existingFa };

for (const directory of [outputRoot, rootOutputRoot]) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'en.json'), `${JSON.stringify(en, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'fa.json'), `${JSON.stringify(fa, null, 2)}\n`);
}

console.log(`Extracted ${Object.keys(catalog).length} user-facing text candidates from ${files.length} client/server files.`);
