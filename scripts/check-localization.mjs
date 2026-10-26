import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const en = read('client/src/language/en.json');
const fa = read('client/src/language/fa.json');
assert.deepEqual(Object.keys(en).sort(),Object.keys(fa).sort(),'Language keys must match');
assert.deepEqual(read('language/en.json'),en,'English distribution catalog is stale');
assert.deepEqual(read('language/fa.json'),fa,'Persian distribution catalog is stale');
const tokens = value => [...new Set([...value.matchAll(/(?<!\$)\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match=>match[1]))].sort();
for(const [key,value] of Object.entries(fa)) {
  assert.equal(typeof value,'string',`${key} must be text`);
  assert.deepEqual(tokens(en[key]),tokens(value),`${key} changed interpolation tokens`);
}
for(const key of ['Save Changes','Permission Overrides','No user reports in this status.',
  'Could not load your workspace.','Incorrect credentials.','Password must be at least 10 characters.',
  'Password must contain a digit.','Welcome {mention} to **{server}**! You are member #{memberCount}.']) {
  assert.match(fa['text.'+key],/[\u0600-\u06ff]/,`Missing reviewed Persian copy: ${key}`);
}
const auditPath = process.argv[2];
if(auditPath) {
  const screens = read(auditPath);
  const allowedNames = new Set(['English','YouTube','Twitch','Kick','Instagram','TikTok','announcements','Voice Lounge',
    'party_parrot','sam','sam@example.com','video-ideas','discord']);
  const leftovers = [];
  for(const screen of screens) {
    for(const value of [...screen.text,...screen.attributes]) {
      const withoutTokens = value.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g,'').replace(/(?:^|\s)\/[a-z][a-z0-9_]*/gi,'').replace(/\bGIF\b/g,'');
      if(!/[A-Za-z]{2}/.test(withoutTokens) || allowedNames.has(value)) continue;
      if(/^ویرایش (?:#?announcements|Voice Lounge|Moderator Bot)$/.test(value)) continue;
      leftovers.push(`${screen.name}: ${value}`);
    }
  }
  assert.deepEqual([...new Set(leftovers)],[],'Unreviewed English interface text in phone captures');
  console.log(`Persian interface audit: ${screens.length} captured screens passed; user names, brands and template syntax preserved.`);
}
console.log(`Catalogs matched; interpolation tokens preserved; ${Object.keys(fa).length} language entries checked.`);
