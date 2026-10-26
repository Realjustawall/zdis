import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const ts = require('typescript');
const { create } = require('zustand');
const source = ts.transpileModule(fs.readFileSync(new URL('../client/src/store/chat.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const responses = [];
const modules = {
  zustand: {create},
  '../lib/api': {api: {get: () => new Promise(resolve => responses.push(resolve))}},
  './session': {useSession: {getState: () => ({user: {id: 'self'}})}},
};
const exports = {};
vm.runInNewContext(source, {exports, require: name => modules[name], Map, Set, Date, Promise}, {filename: 'production-chat-store.cjs'});
const store = exports.useChat;
const target = {kind: 'conversation', conversationId: 'room'};
const key = 'conversation:room';
const message = (id, content = id) => ({id, content, conversationId: 'room', channelId: null, authorId: 'other', createdAt: 1});
const old = message('old'), edited = message('edited', 'before'), deleted = message('deleted');
store.setState({target, messages: {[key]: [old, edited, deleted]}});
const loading = store.getState().loadMessages(target);
store.getState().applyIncoming(message('live', 'new socket message'));
store.getState().applyUpdated(message('edited', 'after'));
store.getState().applyDeleted({messageId: 'deleted', conversationId: 'room', channelId: null});
responses.shift()({messages: [old, edited, deleted, message('offline')], hasMore: false});
await loading;
const rows = () => store.getState().messages[key];
assert.equal(rows().find(row => row.id === 'edited').content, 'after');
assert(rows().some(row => row.id === 'live'));
assert(rows().some(row => row.id === 'offline'));
assert(!rows().some(row => row.id === 'deleted'));
console.log('PASS delayed HTTP snapshots preserve concurrent socket creates, edits and deletes');

const refresh = store.getState().loadMessages(target);
responses.shift()({messages: [], hasMore: false});
await refresh;
assert.equal(rows().length, 0, 'Authoritative reconnect snapshot must still remove stale cached messages');
console.log('PASS reconnect snapshots still remove messages deleted while disconnected');

const pending = {...message('local-1'), deliveryStatus: 'sending'};
store.setState({messages: {[key]: [pending]}});
const withPending = store.getState().loadMessages(target);
responses.shift()({messages: [], hasMore: false});
await withPending;
assert.equal(rows()[0], pending, 'A pending send must survive loading history');
console.log('PASS pending messages survive loading history');
