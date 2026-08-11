import { createRequire } from 'node:module';

// Resolve the realtime client from the client workspace as well as from a
// traditional hoisted install. This keeps the test runner compatible with
// pnpm's isolated workspace layout.
const clientRequire = createRequire(new URL('../client/package.json', import.meta.url));
const { io: ioClient } = clientRequire('socket.io-client');

const BASE = 'http://localhost:4000';
const suffix = Math.random().toString(36).slice(2, 7);

class Client {
  constructor(name) { this.name = name; this.cookies = new Map(); this.csrf = null; }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, body, opts = {}) {
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';'); const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const json = await res.json().catch(() => null);
    if (!opts.allowFail && !res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return { status: res.status, body: json };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b, o); }
  del(p, b, o) { return this.req('DELETE', p, b, o); }
  async login(id, pw) { const r = await this.post('/api/auth/login', { identifier: id, password: pw }); this.csrf = r.body.csrfToken; return r.body.user; }
  socket() {
    return ioClient(BASE, {
      transports: ['websocket'],
      extraHeaders: { cookie: this.cookieHeader() },
      reconnection: false,
    });
  }
}

let passed = 0, failed = 0; const out = [];
async function check(label, fn) {
  try { await fn(); passed++; out.push(`  PASS  ${label}`); }
  catch (e) { failed++; out.push(`  FAIL  ${label}\n          ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const waitFor = (socket, event, ms = 6000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
const connected = (socket) => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
  setTimeout(() => reject(new Error('connect timed out')), 6000);
});

console.log('=== realtime / webrtc signalling ===\n');

const admin = new Client('admin');
await admin.login('office@intesho.com', 'cNL2*8o$1F;"');

const mk = async (role, label) => {
  const email = `${label}-${suffix}@example.com`;
  const pw = 'Realtime-Pass#26';
  const r = await admin.post('/api/admin/users', {
    email, username: `${label}${suffix}`, displayName: label, password: pw, role, mustChangePassword: false,
  });
  const c = new Client(label);
  await c.login(email, pw);
  return { user: r.body.user, client: c };
};

const host = await mk('youtuber', 'host');
const guest = await mk('member', 'guest');
const stranger = await mk('member', 'stranger');

const g = await host.client.post('/api/groups', { name: `RT ${suffix}` });
const groupId = g.body.group.id;
const textChannel = g.body.channels.find((c) => c.type === 'text');
const voiceChannel = g.body.channels.find((c) => c.type === 'voice');
await host.client.post(`/api/groups/${groupId}/members`, { userId: guest.user.id });

let hostSock, guestSock, strangerSock;

let cachedHostId = null;
async function hostId() {
  if (!cachedHostId) cachedHostId = (await host.client.get('/api/auth/me')).body.user.id;
  return cachedHostId;
}

await check('authenticated socket connects', async () => {
  hostSock = host.client.socket();
  guestSock = guest.client.socket();
  strangerSock = stranger.client.socket();
  await Promise.all([connected(hostSock), connected(guestSock), connected(strangerSock)]);
});

await check('socket without a session is rejected', async () => {
  const anon = ioClient(BASE, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    anon.once('connect_error', (e) => { assertSafe(e.message === 'unauthorized', `got "${e.message}"`); resolve(); });
    anon.once('connect', () => reject(new Error('anonymous socket was accepted')));
    setTimeout(() => reject(new Error('no response')), 6000);
  });
  anon.close();
  function assertSafe(c, m) { if (!c) throw new Error(m); }
});

await check('new message reaches group members live', async () => {
  const incoming = waitFor(guestSock, 'message:created');
  await host.client.post(`/api/channels/${textChannel.id}/messages`, { content: 'live ping' });
  const payload = await incoming;
  assert(payload.message.content === 'live ping', 'wrong payload');
});

await check('non-member receives nothing', async () => {
  let leaked = false;
  strangerSock.on('message:created', () => { leaked = true; });
  await host.client.post(`/api/channels/${textChannel.id}/messages`, { content: 'members only' });
  await new Promise((r) => setTimeout(r, 700));
  assert(!leaked, 'a non-member received a channel message');
});

await check('typing indicator relays', async () => {
  const typing = waitFor(guestSock, 'typing:start');
  hostSock.emit('typing:start', { channelId: textChannel.id });
  const payload = await typing;
  assert(payload.channelId === textChannel.id, 'wrong channel');
});

await check('typing into a channel you are not in is ignored', async () => {
  let leaked = false;
  guestSock.on('typing:start', () => { leaked = true; });
  strangerSock.emit('typing:start', { channelId: textChannel.id });
  await new Promise((r) => setTimeout(r, 700));
  assert(!leaked, 'typing leaked across membership boundary');
});

await check('message edit and delete propagate', async () => {
  const posted = await host.client.post(`/api/channels/${textChannel.id}/messages`, { content: 'draft' });
  const updated = waitFor(guestSock, 'message:updated');
  await host.client.req('PATCH', `/api/channels/${textChannel.id}/messages/${posted.body.message.id}`, { content: 'final' });
  const u = await updated;
  assert(u.message.content === 'final', 'edit not broadcast');

  const removed = waitFor(guestSock, 'message:deleted');
  await host.client.del(`/api/channels/${textChannel.id}/messages/${posted.body.message.id}`);
  const d = await removed;
  assert(d.messageId === posted.body.message.id, 'delete not broadcast');
});

await check('presence flips to online on a first connect, offline on last close', async () => {
  // A fresh account: someone who already has a socket open is already online,
  // so no transition would be published for them.
  const fresh = await mk('member', 'lurker');
  const watcher = waitFor(hostSock, 'presence:update');
  const s = fresh.client.socket();
  await connected(s);
  const online = await watcher;
  assert(online.userId === fresh.user.id, 'wrong user in presence event');
  assert(online.presence === 'online', `expected online, got ${online.presence}`);

  const goodbye = waitFor(hostSock, 'presence:update');
  s.close();
  const offline = await goodbye;
  assert(offline.presence === 'offline', `expected offline, got ${offline.presence}`);
});

// ------------------------------------------------------------------- voice

await check('joining a voice channel is authorised and announced', async () => {
  const announced = waitFor(guestSock, 'voice:state');
  const ack = await new Promise((resolve) =>
    hostSock.emit('voice:join', { channelId: voiceChannel.id, muted: false }, resolve));
  assert(ack.ok === true, `join refused: ${ack.error}`);
  assert(Array.isArray(ack.peers) && ack.peers.length === 0, 'first joiner should see no peers');
  const state = await announced;
  assert(state.participants.length === 1, 'participant not published');
});

await check('non-member cannot join the voice channel', async () => {
  const ack = await new Promise((resolve) =>
    strangerSock.emit('voice:join', { channelId: voiceChannel.id }, resolve));
  assert(ack.ok === false, 'a non-member was let into voice');
});

await check('second participant sees the first, first is notified', async () => {
  const notified = waitFor(hostSock, 'voice:peer-joined');
  const ack = await new Promise((resolve) =>
    guestSock.emit('voice:join', { channelId: voiceChannel.id, video: true }, resolve));
  assert(ack.ok === true, `join refused: ${ack.error}`);
  assert(ack.peers.length === 1, `expected 1 peer, got ${ack.peers.length}`);
  const evt = await notified;
  assert(evt.state.video === true, 'video flag not carried');
});

await check('SDP offer/answer and ICE relay between peers', async () => {
  const offerSeen = waitFor(hostSock, 'voice:offer');
  guestSock.emit('voice:offer', { to: (await hostId()), payload: { type: 'offer', sdp: 'v=0 fake' } });
  const offer = await offerSeen;
  assert(offer.payload.sdp === 'v=0 fake', 'offer body mangled');

  const answerSeen = waitFor(guestSock, 'voice:answer');
  hostSock.emit('voice:answer', { to: guest.user.id, payload: { type: 'answer', sdp: 'v=0 reply' } });
  const answer = await answerSeen;
  assert(answer.from === (await hostId()), 'answer attributed to the wrong peer');

  const iceSeen = waitFor(guestSock, 'voice:ice');
  hostSock.emit('voice:ice', { to: guest.user.id, payload: { candidate: 'candidate:1 udp' } });
  const ice = await iceSeen;
  assert(ice.payload.candidate.startsWith('candidate:'), 'ICE body mangled');
});

await check('signalling to someone outside the room is dropped', async () => {
  let leaked = false;
  strangerSock.on('voice:offer', () => { leaked = true; });
  hostSock.emit('voice:offer', { to: stranger.user.id, payload: { sdp: 'leak' } });
  await new Promise((r) => setTimeout(r, 700));
  assert(!leaked, 'signalling escaped the voice room');
});

await check('mute/video state updates broadcast', async () => {
  const updated = waitFor(guestSock, 'voice:peer-updated');
  hostSock.emit('voice:update', { muted: true, screen: true });
  const evt = await updated;
  assert(evt.state.muted === true && evt.state.screen === true, 'state not applied');
});

await check('leaving voice notifies the room', async () => {
  const left = waitFor(guestSock, 'voice:peer-left');
  hostSock.emit('voice:leave');
  const evt = await left;
  assert(evt.userId === (await hostId()), 'wrong user reported');
});

await check('disconnect removes the participant', async () => {
  const left = waitFor(guestSock, 'voice:state');
  const temp = host.client.socket();
  await connected(temp);
  await new Promise((resolve) => temp.emit('voice:join', { channelId: voiceChannel.id }, resolve));
  temp.close();
  const state = await left;
  assert(Array.isArray(state.participants), 'no state published after disconnect');
});

// ----------------------------------------------------- direct-message calls

let directConversationId;
await check('starting a DM call rings the other conversation member', async () => {
  const conversation = await host.client.post('/api/conversations/dm', { userId: guest.user.id });
  directConversationId = conversation.body.conversation.id;
  const roomId = `dm:${directConversationId}`;
  const incoming = waitFor(guestSock, 'voice:incoming');
  const ack = await new Promise((resolve) =>
    hostSock.emit('voice:join', { channelId: roomId, video: true }, resolve));
  assert(ack.ok === true, `DM call refused: ${ack.error}`);
  const call = await incoming;
  assert(call.conversationId === directConversationId, 'wrong conversation rang');
  assert(call.fromUserId === (await hostId()), 'wrong caller announced');
  assert(call.video === true, 'video call flag was lost');
});

await check('a DM member can answer and receives the existing peer', async () => {
  const ack = await new Promise((resolve) =>
    guestSock.emit('voice:join', { channelId: `dm:${directConversationId}` }, resolve));
  assert(ack.ok === true, `answer refused: ${ack.error}`);
  const callerId = await hostId();
  assert(ack.peers.some((peer) => peer.userId === callerId), 'caller was not in the room');
});

await check('a non-member cannot enter a DM call', async () => {
  const ack = await new Promise((resolve) =>
    strangerSock.emit('voice:join', { channelId: `dm:${directConversationId}` }, resolve));
  assert(ack.ok === false, 'a stranger entered a private DM call');
});

await check('declining and ending a DM call notify the caller and conversation', async () => {
  guestSock.emit('voice:leave');
  const declined = waitFor(hostSock, 'voice:declined');
  guestSock.emit('voice:decline', { channelId: `dm:${directConversationId}` });
  const response = await declined;
  assert(response.userId === guest.user.id, 'decline attributed to the wrong user');

  const ended = waitFor(guestSock, 'voice:ended');
  hostSock.emit('voice:leave');
  const payload = await ended;
  assert(payload.conversationId === directConversationId, 'wrong call ended');
});

// ------------------------------------------------------- membership changes

await check('being added to a group subscribes you live', async () => {
  const joined = waitFor(strangerSock, 'group:joined');
  await host.client.post(`/api/groups/${groupId}/members`, { userId: stranger.user.id });
  const evt = await joined;
  assert(evt.groupId === groupId, 'wrong group');

  const incoming = waitFor(strangerSock, 'message:created');
  await host.client.post(`/api/channels/${textChannel.id}/messages`, { content: 'welcome aboard' });
  const msg = await incoming;
  assert(msg.message.content === 'welcome aboard', 'not subscribed after join');
});

await check('being removed unsubscribes you live', async () => {
  const removed = waitFor(strangerSock, 'group:left');
  await host.client.del(`/api/groups/${groupId}/members/${stranger.user.id}`);
  await removed;

  let leaked = false;
  strangerSock.on('message:created', () => { leaked = true; });
  await new Promise((r) => setTimeout(r, 300));
  await host.client.post(`/api/channels/${textChannel.id}/messages`, { content: 'after removal' });
  await new Promise((r) => setTimeout(r, 800));
  assert(!leaked, 'removed member still receives messages');
});

await check('admin disabling an account drops its sockets', async () => {
  const closed = new Promise((resolve, reject) => {
    strangerSock.once('disconnect', resolve);
    setTimeout(() => reject(new Error('socket stayed open')), 6000);
  });
  await admin.req('PATCH', `/api/admin/users/${stranger.user.id}`, { isActive: false });
  await closed;
});

for (const s of [hostSock, guestSock, strangerSock]) s?.close();

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
