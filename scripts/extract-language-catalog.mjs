import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectories = ['client/src/language', 'language'].map(dir => path.join(root, dir));
const sourceRoots = ['client/src', 'server/src'].map(dir => path.join(root, dir));
const strings = new Set();
const pairs = new Map();
const readable = value => {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 600 || !/[A-Za-z\u0600-\u06ff]/.test(text)) return null;
  if (text.includes('class=') || text.includes('className=') || text.includes('getDb(') || /^[a-z]+(?:-[a-z]+){2,}$/.test(text)) return null;
  if (/^(?:\/api\/|https?:\/\/|[.#][a-z-]+$|(?:AND|SELECT|UPDATE|INSERT|DELETE|JOIN|ORDER BY)\b)/.test(text)) return null;
  if (/[{};]|=>/.test(text) && !/\{[A-Za-z]+\}/.test(text)) return null;
  return text;
};
const add = value => { const text = readable(value); if (text) strings.add(text); };
const uiAttributes = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'description']);
const uiProperties = new Set(['title', 'label', 'description', 'placeholder', 'hint', 'help']);
const excludedAttributes = new Set(['className','id','style','key','type','name','value','role','method','target','rel','src','href']);
function scan(file) {
  if (/\/(?:i18n|localize)\.tsx?$/.test(file)) return;
  const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined);
  const literal = node => node && ts.isStringLiteralLike(node);
  const pair = (en, fa) => {
    if (literal(en) && literal(fa) && /[A-Za-z]/.test(en.text) && /[\u0600-\u06ff]/.test(fa.text)) {
      const key = readable(en.text); if (key) { strings.add(key); pairs.set(key, fa.text); }
    }
  };
  function visit(node) {
    if (ts.isJsxText(node)) add(node.text);
    if (ts.isJsxAttribute(node) && uiAttributes.has(node.name.text) && literal(node.initializer)) add(node.initializer.text);
    if (ts.isPropertyAssignment(node) && uiProperties.has(node.name.getText(source).replace(/['"]/g,'')) && literal(node.initializer)) add(node.initializer.text);
    if (ts.isConditionalExpression(node)) {
      let parent = node.parent, excluded = false;
      while (parent && !ts.isSourceFile(parent)) {
        if (ts.isJsxAttribute(parent)) { excluded = excludedAttributes.has(parent.name.text); break; }
        if (ts.isCallExpression(parent) && parent.expression.getText(source) === 'classNames') { excluded = true; break; }
        parent = parent.parent;
      }
      if (!excluded) {
        pair(node.whenFalse, node.whenTrue);
        // Only literal UI branches are collected; operator expressions and
        // comparisons are never treated as translatable strings.
        for (const branch of [node.whenTrue, node.whenFalse]) if (literal(branch) && /\s|[.!?…]/.test(branch.text)) add(branch.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (callee === 't' && node.arguments.length === 2) pair(node.arguments[0],node.arguments[1]);
      if (/^(?:toast\.(?:info|error|success)|badRequest|forbidden|notFound|conflict|unauthorized|translateUiText|window\.(?:prompt|confirm|alert))$/.test(callee)) {
        if (literal(node.arguments[0])) add(node.arguments[0].text);
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory()) { if(entry.name!=='language') walk(file); }
    else if(/\.(?:tsx?|jsx?)$/.test(file)) scan(file);
  }
}
sourceRoots.forEach(walk);
const en = JSON.parse(fs.readFileSync(path.join(outputDirectories[0],'en.json'),'utf8'));
const fa = JSON.parse(fs.readFileSync(path.join(outputDirectories[0],'fa.json'),'utf8'));
// Preserve reviewed translations, including errors that originate on the server.
const reviewed = Object.fromEntries(Object.entries(fa).filter(([key,value]) => key.startsWith('text.') && value !== en[key]));
const keep = key => !key.startsWith('text.');
const nextEn = Object.fromEntries(Object.entries(en).filter(([key])=>keep(key)));
const nextFa = Object.fromEntries(Object.entries(fa).filter(([key])=>keep(key)));
for(const key of new Set([...strings].map(value=>'text.'+value).concat(Object.keys(reviewed)))) {
  nextEn[key] = en[key] ?? key.slice(5);
  nextFa[key] = reviewed[key] ?? pairs.get(key.slice(5)) ?? nextEn[key];
}
for (const dir of outputDirectories) {
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'en.json'),JSON.stringify(nextEn,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'fa.json'),JSON.stringify(nextFa,null,2)+'\n');
}
console.log(`Extracted ${strings.size} UI/error strings with syntax-aware parsing; preserved ${Object.keys(reviewed).length} reviewed translations.`);
