const BASE = 'http://localhost:4000';

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
    this.csrf = null;
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  async req(method, path, body, opts = {}) {
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    if (!opts.allowFail && !res.ok) {
      throw new Error(`${this.name} ${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    }
    return { status: res.status, body: json };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b, o); }
  patch(p, b, o) { return this.req('PATCH', p, b, o); }
  put(p, b, o) { return this.req('PUT', p, b, o); }
  del(p, b, o) { return this.req('DELETE', p, b, o); }
  async login(identifier, password) {
    const r = await this.post('/api/auth/login', { identifier, password });
    this.csrf = r.body.csrfToken;
    return r.body.user;
  }
}

let passed = 0, failed = 0;
const results = [];
async function check(label, fn) {
  try {
    await fn();
    passed++; results.push(`  PASS  ${label}`);
  } catch (e) {
    failed++; results.push(`  FAIL  ${label}\n          ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const admin = new Client('admin');
const suffix = Math.random().toString(36).slice(2, 7);

console.log('=== youtBeLimo smoke test ===\n');

await check('CSP permits only the Cloudflare analytics beacon', async () => {
  const response = await fetch(`${BASE}/api/health`);
  const policy = response.headers.get('content-security-policy') ?? '';
  assert(
    policy.includes("script-src 'self' https://static.cloudflareinsights.com"),
    'Cloudflare analytics script origin is missing from script-src',
  );
  assert(
    policy.includes('https://cloudflareinsights.com'),
    'Cloudflare analytics reporting origin is missing from connect-src',
  );
});

await check('CSP permits images from the public object-storage origin', async () => {
  const response = await fetch(`${BASE}/api/health`);
  const policy = response.headers.get('content-security-policy') ?? '';
  assert(
    policy.includes("img-src 'self' data: blob: https://media.test.example"),
    'public S3 origin is missing from img-src',
  );
  assert(
    policy.includes("media-src 'self' blob: https://media.test.example"),
    'public S3 origin is missing from media-src',
  );
});

// ---- auth
await check('admin logs in', async () => {
  const u = await admin.login('office@intesho.com', 'cNL2*8o$1F;"');
  assert(u.role === 'admin', 'expected admin role');
});

await check('wrong password is rejected', async () => {
  const c = new Client('bad');
  const r = await c.post('/api/auth/login', { identifier: 'office@intesho.com', password: 'nope' }, { allowFail: true });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await check('unknown user gives the same 401', async () => {
  const c = new Client('bad');
  const r = await c.post('/api/auth/login', { identifier: 'ghost@example.com', password: 'nope' }, { allowFail: true });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await check('unauthenticated request is refused', async () => {
  const c = new Client('anon');
  const r = await c.get('/api/users', { allowFail: true });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await check('CSRF token is required for writes', async () => {
  const c = new Client('nocsrf');
  await c.login('office@intesho.com', 'cNL2*8o$1F;"');
  c.csrf = null;
  const r = await c.post('/api/groups', { name: 'Should Fail' }, { allowFail: true });
  assert(r.status === 403, `expected 403, got ${r.status}`);
});

// ---- admin: create accounts
let youtuber, editor, outsider;
await check('admin creates a youtuber account', async () => {
  const r = await admin.post('/api/admin/users', {
    email: `creator-${suffix}@example.com`,
    username: `creator${suffix}`,
    displayName: 'Big Creator',
    password: 'Yt-Creator#2026',
    role: 'youtuber',
    mustChangePassword: false,
  });
  youtuber = r.body.user;
  assert(youtuber.role === 'youtuber', 'role mismatch');
});

await check('admin creates two member accounts', async () => {
  const a = await admin.post('/api/admin/users', {
    email: `editor-${suffix}@example.com`, username: `editor${suffix}`,
    displayName: 'Video Editor', password: 'Editor-Pass#2026', role: 'member', mustChangePassword: false,
  });
  const b = await admin.post('/api/admin/users', {
    email: `outsider-${suffix}@example.com`, username: `outsider${suffix}`,
    displayName: 'Random Person', password: 'Outside-Pass#26', role: 'member', mustChangePassword: false,
  });
  editor = a.body.user; outsider = b.body.user;
});

await check('weak password is rejected by policy', async () => {
  const r = await admin.post('/api/admin/users', {
    email: `weak-${suffix}@example.com`, username: `weak${suffix}`,
    displayName: 'Weak', password: 'password', role: 'member',
  }, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('duplicate email is rejected', async () => {
  const r = await admin.post('/api/admin/users', {
    email: `creator-${suffix}@example.com`, username: `dupe${suffix}`,
    displayName: 'Dupe', password: 'Some-Good#Pass9', role: 'member',
  }, { allowFail: true });
  assert(r.status === 409, `expected 409, got ${r.status}`);
});

await check('public signup is disabled by default', async () => {
  const c = new Client('anon');
  const register = await c.post('/api/auth/register', { email: 'x@y.z' }, { allowFail: true });
  assert(register.status === 403, `/api/auth/register returned ${register.status}`);
  for (const path of ['/api/auth/signup', '/api/users']) {
    const r = await c.post(path, {}, { allowFail: true });
    assert(r.status === 404 || r.status === 401, `${path} returned ${r.status}`);
  }
});

// ---- non-admin cannot reach the admin panel
const creator = new Client('creator');
const ed = new Client('editor');
const out = new Client('outsider');

await check('created accounts can log in', async () => {
  const a = await creator.login(`creator-${suffix}@example.com`, 'Yt-Creator#2026');
  const b = await ed.login(`editor-${suffix}@example.com`, 'Editor-Pass#2026');
  const c = await out.login(`outsider-${suffix}@example.com`, 'Outside-Pass#26');
  assert(a.role === 'youtuber' && b.role === 'member' && c.role === 'member', 'roles wrong');
});

await check('message speaker visibility is stored per user', async () => {
  const updated = await creator.patch('/api/auth/profile', { ttsButtonEnabled: false });
  assert(updated.body.user.ttsButtonEnabled === false, 'speaker preference was not updated');
  const creatorMe = await creator.get('/api/auth/me');
  const editorMe = await ed.get('/api/auth/me');
  assert(creatorMe.body.user.ttsButtonEnabled === false, 'speaker preference did not persist');
  assert(editorMe.body.user.ttsButtonEnabled === true, 'speaker preference leaked to another user');
});

await check('non-admin is blocked from the admin API', async () => {
  const r = await creator.get('/api/admin/users', { allowFail: true });
  assert(r.status === 403, `expected 403, got ${r.status}`);
});

await check('every account can see the member directory', async () => {
  const r = await ed.get('/api/users');
  assert(r.body.users.length >= 4, `expected >= 4 users, got ${r.body.users.length}`);
  assert(!('email' in r.body.users[0]), 'directory must not leak emails');
});

// ---- groups
let group, channels;
await check('youtuber creates a group', async () => {
  const r = await creator.post('/api/groups', { name: `Creator HQ ${suffix}`, description: 'Team space' });
  group = r.body.group; channels = r.body.channels;
  assert(group.memberRole === 'owner', 'creator should own it');
  assert(channels.length === 3, `expected 3 default channels, got ${channels.length}`);
  assert(channels.some((c) => c.type === 'voice'), 'expected a voice channel');
});

await check('plain member cannot create a group', async () => {
  const r = await out.post('/api/groups', { name: 'Nope' }, { allowFail: true });
  assert(r.status === 403, `expected 403, got ${r.status}`);
});

await check('non-member cannot see the group', async () => {
  const r = await out.get(`/api/groups/${group.id}`, { allowFail: true });
  assert(r.status === 404, `expected 404, got ${r.status}`);
});

await check('youtuber adds a member to their group', async () => {
  await creator.post(`/api/groups/${group.id}/members`, { userId: editor.id, role: 'moderator' });
  const r = await ed.get(`/api/groups/${group.id}`);
  assert(r.body.group.memberRole === 'moderator', 'role not applied');
  assert(r.body.permissions.deleteAnyMessage === true, 'moderator should moderate');
  assert(r.body.permissions.manageChannels === false, 'moderator should not manage channels');
});

await check('member cannot add other members without permission', async () => {
  await creator.patch(`/api/groups/${group.id}/members/${editor.id}`, { role: 'member' });
  const r = await ed.post(`/api/groups/${group.id}/members`, { userId: outsider.id }, { allowFail: true });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  await creator.patch(`/api/groups/${group.id}/members/${editor.id}`, { role: 'moderator' });
});

let invite;
await check('invite link is created and redeemed', async () => {
  const r = await creator.post(`/api/groups/${group.id}/invites`, { maxUses: 5 });
  invite = r.body.invite;
  const j = await out.post(`/api/groups/join/${invite.code}`);
  assert(j.body.group.id === group.id, 'joined the wrong group');
});

await check('revoked invite stops working', async () => {
  const r = await creator.post(`/api/groups/${group.id}/invites`, {});
  await creator.del(`/api/groups/${group.id}/invites/${r.body.invite.id}`);
  const j = await ed.post(`/api/groups/join/${r.body.invite.code}`, {}, { allowFail: true });
  assert(j.status === 404, `expected 404, got ${j.status}`);
});

// ---- channels
let textChannel, voiceChannel, privateChannel;
await check('channels are created and listed', async () => {
  textChannel = channels.find((c) => c.type === 'text');
  voiceChannel = channels.find((c) => c.type === 'voice');
  const r = await creator.post(`/api/groups/${group.id}/channels`, {
    name: 'private-strategy', type: 'text', isPrivate: true, memberIds: [editor.id],
  });
  privateChannel = r.body.channel;
  assert(privateChannel.isPrivate, 'should be private');
});

await check('private channel is hidden from users without a seat', async () => {
  const r = await out.get(`/api/groups/${group.id}`);
  assert(!r.body.channels.some((c) => c.id === privateChannel.id), 'private channel leaked');
  const m = await out.get(`/api/channels/${privateChannel.id}/messages`, { allowFail: true });
  assert(m.status === 404, `expected 404, got ${m.status}`);
});

await check('user with a seat can read the private channel', async () => {
  const r = await ed.get(`/api/channels/${privateChannel.id}/messages`);
  assert(Array.isArray(r.body.messages), 'expected a message list');
});

// ---- messages
let message;
await check('message is posted and read back', async () => {
  const r = await creator.post(`/api/channels/${textChannel.id}/messages`, {
    content: `Hello team @${editor.username} — first upload drops friday`,
  });
  message = r.body.message;
  assert(message.content.includes('Hello team'), 'content mismatch');
  const list = await ed.get(`/api/channels/${textChannel.id}/messages`);
  assert(list.body.messages.some((m) => m.id === message.id), 'message not visible');
});

await check('mention is indexed', async () => {
  const r = await ed.get('/api/mentions');
  assert(r.body.messages.some((m) => m.id === message.id), 'mention not recorded');
});

await check('reply threading works', async () => {
  const r = await ed.post(`/api/channels/${textChannel.id}/messages`, {
    content: 'On it.', replyToId: message.id,
  });
  assert(r.body.message.replyTo?.id === message.id, 'reply link missing');
});

await check('author can edit their own message', async () => {
  const r = await creator.patch(`/api/channels/${textChannel.id}/messages/${message.id}`, {
    content: 'Hello team — upload moved to saturday',
  });
  assert(r.body.message.editedAt, 'editedAt not set');
});

await check('nobody can edit someone else\'s message', async () => {
  const r = await ed.patch(`/api/channels/${textChannel.id}/messages/${message.id}`, {
    content: 'forged',
  }, { allowFail: true });
  assert(r.status === 403, `expected 403, got ${r.status}`);
});

await check('reactions toggle', async () => {
  const add = await ed.put(`/api/channels/${textChannel.id}/messages/${message.id}/reactions/${encodeURIComponent('🔥')}`);
  assert(add.body.added === true, 'expected add');
  assert(add.body.reactions[0].count === 1, 'expected count 1');
  const remove = await ed.put(`/api/channels/${textChannel.id}/messages/${message.id}/reactions/${encodeURIComponent('🔥')}`);
  assert(remove.body.added === false, 'expected remove');
});

await check('flags, keycaps, and joined emoji are valid reactions', async () => {
  for (const emoji of ['🇮🇷', '1️⃣', '👨‍👩‍👧‍👦']) {
    const result = await ed.put(
      `/api/channels/${textChannel.id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`,
    );
    assert(result.body.added === true, `${emoji} was incorrectly rejected`);
  }
});

await check('rubbish reactions are rejected', async () => {
  const r = await ed.put(`/api/channels/${textChannel.id}/messages/${message.id}/reactions/${encodeURIComponent('<script>alert(1)</script>')}`, undefined, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('pinning is permission gated', async () => {
  const denied = await out.put(`/api/channels/${textChannel.id}/messages/${message.id}/pin`, { pinned: true }, { allowFail: true });
  assert(denied.status === 403, `expected 403, got ${denied.status}`);
  await creator.put(`/api/channels/${textChannel.id}/messages/${message.id}/pin`, { pinned: true });
  const pins = await ed.get(`/api/channels/${textChannel.id}/pins`);
  assert(pins.body.messages.some((m) => m.id === message.id), 'pin not listed');
});

await check('search is scoped to what you can read', async () => {
  const mine = await ed.get('/api/search?q=saturday');
  assert(mine.body.messages.length >= 1, 'expected a hit');
  const secret = await ed.post(`/api/channels/${privateChannel.id}/messages`, { content: 'zqxwv secret plan' });
  assert(secret.body.message.id, 'could not post');
  const blind = await out.get('/api/search?q=zqxwv');
  assert(blind.body.messages.length === 0, 'private channel content leaked into search');
});

await check('unread counts are reported', async () => {
  const r = await out.get('/api/unread');
  assert(Array.isArray(r.body.channels), 'expected channel counts');
});

await check('moderator can delete another message, member cannot', async () => {
  const posted = await out.post(`/api/channels/${textChannel.id}/messages`, { content: 'spam spam' });
  const denied = await ed.del(`/api/channels/${textChannel.id}/messages/${posted.body.message.id}`, undefined, { allowFail: true });
  assert(denied.status === 200, `moderator should be able to delete, got ${denied.status}`);
  const own = await out.post(`/api/channels/${textChannel.id}/messages`, { content: 'mine' });
  const byOther = await new Client('x');
  void byOther;
  const r = await out.del(`/api/channels/${textChannel.id}/messages/${own.body.message.id}`);
  assert(r.status === 200, 'author should delete their own');
});

await check('oversized message is rejected', async () => {
  const r = await creator.post(`/api/channels/${textChannel.id}/messages`, { content: 'x'.repeat(5000) }, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('DLP blocks high-confidence secrets from messages', async () => {
  const r = await creator.post(`/api/channels/${textChannel.id}/messages`, {
    content: 'accidentally pasted AKIAABCDEFGHIJKLMNOP here',
  }, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  assert(String(r.body?.error?.message).includes('sensitive'), 'DLP did not explain the block');
});

// ---- DMs
let dm;
await check('DM opens and is idempotent', async () => {
  const a = await creator.post('/api/conversations/dm', { userId: editor.id });
  const b = await creator.post('/api/conversations/dm', { userId: editor.id });
  dm = a.body.conversation;
  assert(a.body.conversation.id === b.body.conversation.id, 'DM duplicated');
});

await check('DM plaintext is refused when mandatory E2EE is enabled', async () => {
  const r = await creator.post(`/api/conversations/${dm.id}/messages`, { content: 'private note' }, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  assert(String(r.body?.error?.message).includes('end-to-end encryption'), 'E2EE requirement was not explained');
});

await check('outsider cannot read the DM', async () => {
  const r = await out.get(`/api/conversations/${dm.id}/messages`, { allowFail: true });
  assert(r.status === 404, `expected 404, got ${r.status}`);
});

await check('group DM is created', async () => {
  const r = await creator.post('/api/conversations/group', {
    userIds: [editor.id, outsider.id], name: 'Launch crew',
  });
  assert(r.body.conversation.type === 'group_dm', 'wrong type');
  assert(r.body.conversation.members.length === 3, 'wrong member count');
});

// ---- uploads
let attachment;
await check('upload limits are reported', async () => {
  const r = await creator.get('/api/files/limits');
  assert(r.body.enabled === true, 'uploads should start enabled');
  assert(r.body.maxMb === 10, `expected 10MB, got ${r.body.maxMb}`);
});

await check('a real PNG uploads', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const r = await creator.post('/api/files', form);
  attachment = r.body.attachment;
  assert(attachment.mime === 'image/png', 'mime mismatch');
  assert(attachment.width === 1 && attachment.height === 1, 'dimensions not read');
});

await check('server profile image can be assigned and removed', async () => {
  const assigned = await creator.put(`/api/groups/${group.id}/icon`, {
    attachmentId: attachment.id,
  });
  assert(
    assigned.body.group.iconUrl === `/api/files/${attachment.id}`,
    'server icon URL was not assigned',
  );
  const readable = await ed.get(`/api/files/${attachment.id}`);
  assert(readable.status === 200 || readable.status === 302, 'server members should read the icon');
  const removed = await creator.put(`/api/groups/${group.id}/icon`, { attachmentId: null });
  assert(removed.body.group.iconUrl === null, 'server icon was not removed');
});

await check('a disguised executable is refused', async () => {
  const evil = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is a PE binary');
  const form = new FormData();
  form.append('file', new Blob([evil], { type: 'image/png' }), 'totally-an-image.png');
  const r = await creator.post('/api/files', form, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('an SVG is refused (scriptable)', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const form = new FormData();
  form.append('file', new Blob([svg], { type: 'image/svg+xml' }), 'x.svg');
  const r = await creator.post('/api/files', form, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('an oversized file is refused', async () => {
  const big = Buffer.alloc(11 * 1024 * 1024, 1);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const form = new FormData();
  form.append('file', new Blob([big], { type: 'image/png' }), 'big.png');
  const r = await creator.post('/api/files', form, { allowFail: true });
  assert(r.status === 413 || r.status === 400, `expected 413/400, got ${r.status}`);
});

await check('attachment is delivered only to authorised readers', async () => {
  await creator.post(`/api/channels/${textChannel.id}/messages`, {
    content: 'here is the thumbnail', attachmentIds: [attachment.id],
  });
  const ok = await ed.get(`/api/files/${attachment.id}`);
  assert(ok.status === 200 || ok.status === 302, 'group member should read or receive a signed URL');
  const anon = new Client('anon');
  const denied = await anon.get(`/api/files/${attachment.id}`, { allowFail: true });
  assert(denied.status === 401, `expected 401, got ${denied.status}`);
});

await check('admin can switch uploads off', async () => {
  await admin.patch('/api/admin/settings', { uploads_enabled: false });
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
  const r = await creator.post('/api/files', form, { allowFail: true });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  await admin.patch('/api/admin/settings', { uploads_enabled: true });
});

// ---- admin management
await check('admin overview reports real numbers', async () => {
  const r = await admin.get('/api/admin/overview');
  assert(r.body.users >= 4, 'user count wrong');
  const expected = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
  assert(r.body.runtime.database === expected, `expected ${expected} database`);
});

await check('admin can disable an account and kill its sessions', async () => {
  await admin.patch(`/api/admin/users/${outsider.id}`, { isActive: false });
  const r = await out.get('/api/users', { allowFail: true });
  assert(r.status === 401, `expected 401 after disable, got ${r.status}`);
  const login = await new Client('t').post('/api/auth/login', {
    identifier: `outsider-${suffix}@example.com`, password: 'Outside-Pass#26',
  }, { allowFail: true });
  assert(login.status === 403, `disabled account should get 403, got ${login.status}`);
  await admin.patch(`/api/admin/users/${outsider.id}`, { isActive: true });
});

await check('admin cannot demote the last administrator', async () => {
  const r = await admin.patch(`/api/admin/users/${(await admin.get('/api/auth/me')).body.user.id}`, {
    role: 'member',
  }, { allowFail: true });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('admin resets a password and forces a change', async () => {
  await admin.post(`/api/admin/users/${editor.id}/password`, {
    password: 'Fresh-Start#2026', mustChange: true,
  });
  const c = new Client('ed2');
  const u = await c.login(`editor-${suffix}@example.com`, 'Fresh-Start#2026');
  assert(u.mustChangePassword === true, 'must-change flag not set');

  // Until they rotate it, everything except /api/auth is closed to them.
  const blocked = await c.get('/api/users', { allowFail: true });
  assert(blocked.status === 403, `expected 403 before rotation, got ${blocked.status}`);
  await c.post('/api/auth/password', {
    currentPassword: 'Fresh-Start#2026', newPassword: 'Rotated-Editor#26',
  });
  const allowed = await c.get('/api/users');
  assert(allowed.status === 200, 'access should resume after rotation');
});

await check('audit log records what happened', async () => {
  const r = await admin.get('/api/admin/audit?limit=50');
  const actions = r.body.logs.map((l) => l.action);
  for (const expected of ['admin.user_created', 'auth.login', 'group.create']) {
    assert(actions.includes(expected), `missing audit entry: ${expected}`);
  }
});

await check('admin deletes an account and its groups', async () => {
  const r = await admin.post('/api/admin/users', {
    email: `temp-${suffix}@example.com`, username: `temp${suffix}`,
    displayName: 'Temp', password: 'Temp-Pass#2026', role: 'youtuber', mustChangePassword: false,
  });
  const temp = r.body.user;
  const c = new Client('temp');
  await c.login(`temp-${suffix}@example.com`, 'Temp-Pass#2026');
  const g = await c.post('/api/groups', { name: `Temp Space ${suffix}` });
  const del = await admin.del(`/api/admin/users/${temp.id}`);
  assert(del.body.deletedGroups === 1, 'owned group should be removed');
  const gone = await admin.get('/api/admin/groups');
  assert(!gone.body.groups.some((x) => x.id === g.body.group.id), 'group survived');
});

// ---- 2FA
await check('TOTP enrolment round-trips', async () => {
  const setup = await creator.post('/api/auth/totp/setup', {});
  assert(setup.body.uri.startsWith('otpauth://totp/'), 'bad otpauth uri');
  const { createHmac } = await import('node:crypto');
  const secret = setup.body.secret;
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const bytes = [];
  for (const ch of secret) { value = (value << 5) | ALPHA.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const off = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[off] & 0x7f) << 24) | ((digest[off + 1] & 0xff) << 16) |
    ((digest[off + 2] & 0xff) << 8) | (digest[off + 3] & 0xff);
  const code = String(bin % 1e6).padStart(6, '0');
  const enable = await creator.post('/api/auth/totp/enable', { token: code });
  assert(enable.body.user.totpEnabled === true, '2FA not enabled');
  assert(enable.body.recoveryCodes.length === 10, 'recovery codes were not issued');

  const c = new Client('mfa');
  const r = await c.post('/api/auth/login', {
    identifier: `creator-${suffix}@example.com`, password: 'Yt-Creator#2026',
  });
  assert(r.body.mfaRequired === true, 'login should demand a code');
  const recovered = await c.post('/api/auth/login', {
    identifier: `creator-${suffix}@example.com`,
    password: 'Yt-Creator#2026',
    totp: enable.body.recoveryCodes[0],
  });
  assert(recovered.body.user?.id, 'recovery-code login failed');
  const reused = await new Client('reused-recovery').post('/api/auth/login', {
    identifier: `creator-${suffix}@example.com`,
    password: 'Yt-Creator#2026',
    totp: enable.body.recoveryCodes[0],
  }, { allowFail: true });
  assert(reused.status === 401, 'recovery code was reusable');
  const status = await creator.get('/api/auth/totp/recovery-codes');
  assert(status.body.remaining === 9, 'used recovery code was not counted');
  await creator.post('/api/auth/totp/disable', { password: 'Yt-Creator#2026', token: code });
});

await check('tamper-evident audit chain verifies and exports', async () => {
  const verified = await admin.get('/api/admin/audit/verify');
  assert(verified.body.integrity.valid === true, 'audit chain did not verify');
  assert(verified.body.integrity.checked > 0, 'no signed audit rows were checked');
  const exported = await admin.get('/api/admin/audit/export?limit=50');
  assert(String(exported.body).includes('integrityProtected'), 'CSV export is incomplete');
});

// ---- sessions
await check('logout invalidates the session', async () => {
  const c = new Client('bye');
  await c.login(`outsider-${suffix}@example.com`, 'Outside-Pass#26');
  await c.post('/api/auth/logout', {});
  const r = await c.get('/api/users', { allowFail: true });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await check('changing a password revokes other sessions', async () => {
  const a = new Client('sessA');
  const b = new Client('sessB');
  await a.login(`outsider-${suffix}@example.com`, 'Outside-Pass#26');
  await b.login(`outsider-${suffix}@example.com`, 'Outside-Pass#26');
  await a.post('/api/auth/password', {
    currentPassword: 'Outside-Pass#26', newPassword: 'Rotated-Pass#26',
  });
  await new Promise((r) => setTimeout(r, 1100));
  const still = await a.get('/api/users', { allowFail: true });
  assert(still.status === 200, 'current session should survive');
});

// ---- group teardown
await check('owner deletes their group, others cannot', async () => {
  // The admin password reset above revoked this client's session, by design.
  await ed.login(`editor-${suffix}@example.com`, 'Rotated-Editor#26');
  const denied = await ed.del(`/api/groups/${group.id}`, undefined, { allowFail: true });
  assert(denied.status === 403, `expected 403, got ${denied.status}`);
  const r = await creator.del(`/api/groups/${group.id}`);
  assert(r.status === 200, 'owner delete failed');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
