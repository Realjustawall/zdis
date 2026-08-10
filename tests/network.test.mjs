const BASE = 'http://localhost:4000';

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
    this.csrf = null;
  }
  cookieHeader() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }
  async req(method, path, body, { allowFail = false } = {}) {
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const json = await res.json().catch(() => null);
    if (!allowFail && !res.ok) {
      throw new Error(`${this.name} ${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    }
    return { status: res.status, body: json };
  }
  get(path, options) { return this.req('GET', path, undefined, options); }
  post(path, body, options) { return this.req('POST', path, body, options); }
  patch(path, body, options) { return this.req('PATCH', path, body, options); }
  put(path, body, options) { return this.req('PUT', path, body, options); }
  del(path, body, options) { return this.req('DELETE', path, body, options); }
  async login(identifier, password) {
    const result = await this.post('/api/auth/login', { identifier, password });
    this.csrf = result.body.csrfToken;
    return result.body.user;
  }
}

const suffix = Math.random().toString(36).slice(2, 8);
const password = 'Network-Pass#26';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
let passed = 0;
let failed = 0;
const results = [];
async function check(label, action) {
  try {
    await action();
    passed += 1;
    results.push(`  PASS  ${label}`);
  } catch (error) {
    failed += 1;
    results.push(`  FAIL  ${label}\n          ${error.message}`);
  }
}

console.log('=== badges / network / roster / categories ===\n');

const admin = new Client('admin');
await admin.login('office@intesho.com', 'cNL2*8o$1F;"');

async function createAccount(role, name) {
  const result = await admin.post('/api/admin/users', {
    email: `${name}-${suffix}@example.com`,
    username: `${name}${suffix}`,
    displayName: `${name} ${suffix}`,
    password,
    role,
    mustChangePassword: false,
  });
  const client = new Client(name);
  const self = await client.login(`${name}-${suffix}@example.com`, password);
  return { user: result.body.user, self, client };
}

const streamerA = await createAccount('youtuber', 'neta');
const streamerB = await createAccount('youtuber', 'netb');
const staff = await createAccount('member', 'netstaff');
let rosterUser;
let groupA;
let groupB;
let inviteB;
let accessId;

await check('legacy roles are backfilled into capability badges', async () => {
  assert(streamerA.self.badges.some((badge) => badge.id === 'streamer'), 'streamer badge missing');
  const catalogue = await streamerA.client.get('/api/network/badges');
  assert(catalogue.body.badges.some((badge) => badge.id === 'editor'), 'catalogue missing editor');
});

await check('streamer provisions a scoped roster account', async () => {
  const result = await streamerA.client.post('/api/network/roster', {
    email: `roster-${suffix}@example.com`,
    username: `roster${suffix}`,
    displayName: `Roster ${suffix}`,
    password,
    mustChangePassword: false,
  });
  assert(result.body.user.ownerStreamerId === streamerA.user.id, 'roster owner was not stored');
  const client = new Client('roster');
  const self = await client.login(`roster-${suffix}@example.com`, password);
  rosterUser = { user: result.body.user, self, client };
});

await check('channel categories round-trip and attach to channels', async () => {
  groupA = (await streamerA.client.post('/api/groups', { name: `Network A ${suffix}` })).body.group;
  const category = (
    await streamerA.client.post(`/api/groups/${groupA.id}/categories`, { name: 'Production' })
  ).body.category;
  const channel = (
    await streamerA.client.post(`/api/groups/${groupA.id}/channels`, {
      name: 'edits',
      type: 'text',
      categoryId: category.id,
    })
  ).body.channel;
  assert(channel.categoryId === category.id, 'channel category missing');
  const detail = await streamerA.client.get(`/api/groups/${groupA.id}`);
  assert(detail.body.categories.some((item) => item.id === category.id), 'category not listed');
  await streamerA.client.del(`/api/groups/${groupA.id}/categories/${category.id}`);
  const after = await streamerA.client.get(`/api/groups/${groupA.id}`);
  assert(
    after.body.channels.find((item) => item.id === channel.id)?.categoryId === null,
    'deleted category was not detached',
  );
});

await check('scoped account cannot use an unrelated streamer invite', async () => {
  groupB = (await streamerB.client.post('/api/groups', { name: `Network B ${suffix}` })).body.group;
  inviteB = (
    await streamerB.client.post(`/api/groups/${groupB.id}/invites`, {})
  ).body.invite;
  const denied = await rosterUser.client.post(`/api/groups/join/${inviteB.code}`, {}, { allowFail: true });
  assert(denied.status === 403, `expected 403, got ${denied.status}`);
});

await check('access request approval opens the other streamer roster', async () => {
  const request = (
    await streamerB.client.post('/api/network/access-requests', {
      userId: rosterUser.user.id,
      message: 'Join the production workspace',
    })
  ).body.request;
  accessId = request.id;
  await rosterUser.client.patch(`/api/network/access-requests/${accessId}`, { status: 'accepted' });
  const joined = await rosterUser.client.post(`/api/groups/join/${inviteB.code}`, {});
  assert(joined.body.group.id === groupB.id, 'approved roster member did not join');
});

await check('streamer labels an approved roster member', async () => {
  const result = await streamerB.client.put(
    `/api/network/badges/${rosterUser.user.id}/secondary`,
    { badgeIds: ['editor', 'team'] },
  );
  assert(result.body.badges.some((badge) => badge.id === 'editor'), 'editor badge missing');
  const profile = await streamerB.client.get(`/api/users/${rosterUser.user.id}`);
  assert(profile.body.user.badges.some((badge) => badge.id === 'team'), 'team badge not public');
});

let friendshipId;
await check('friend request can be sent by exact username', async () => {
  friendshipId = (
    await streamerA.client.post('/api/network/friends', { username: `@${streamerB.user.username}` })
  ).body.friendship.id;

  const incoming = await streamerB.client.get('/api/network/friends');
  assert(
    incoming.body.friendships.some(
      (item) => item.id === friendshipId && item.status === 'pending' && item.direction === 'incoming',
    ),
    'incoming friend request missing',
  );

  const duplicate = await streamerA.client.post(
    '/api/network/friends',
    { username: streamerB.user.username },
    { allowFail: true },
  );
  assert(duplicate.status === 409, `duplicate request returned ${duplicate.status}`);

  const senderAccept = await streamerA.client.patch(
    `/api/network/friends/${friendshipId}`,
    { status: 'accepted' },
    { allowFail: true },
  );
  assert(senderAccept.status === 403, `sender accepted its own request: ${senderAccept.status}`);
});

await check('friend request recipient can accept', async () => {
  await streamerB.client.patch(`/api/network/friends/${friendshipId}`, { status: 'accepted' });
  const friends = await streamerA.client.get('/api/network/friends');
  assert(
    friends.body.friendships.some((item) => item.id === friendshipId && item.status === 'accepted'),
    'accepted friendship missing',
  );
});

await check('blocking removes friendship and prevents new requests', async () => {
  await streamerA.client.post(`/api/users/${streamerB.user.id}/block`, {});
  const friends = await streamerB.client.get('/api/network/friends');
  assert(
    !friends.body.friendships.some((item) => item.id === friendshipId),
    'blocked friendship was not removed',
  );
  const blockedRequest = await streamerB.client.post(
    '/api/network/friends',
    { username: streamerA.user.username },
    { allowFail: true },
  );
  assert(blockedRequest.status === 403, `blocked request returned ${blockedRequest.status}`);
  await streamerA.client.del(`/api/users/${streamerB.user.id}/block`);
});

await check('outgoing friend request can be cancelled', async () => {
  const request = (
    await streamerB.client.post('/api/network/friends', { username: streamerA.user.username })
  ).body.friendship;
  await streamerB.client.del(`/api/network/friends/${request.id}`);
  const friends = await streamerA.client.get('/api/network/friends');
  assert(
    !friends.body.friendships.some((item) => item.id === request.id),
    'cancelled friend request still exists',
  );
});

await check('linked profile can be added and verified', async () => {
  const linked = (
    await streamerA.client.post('/api/network/linked-accounts', {
      platform: 'youtube',
      handle: `channel-${suffix}`,
      url: `https://youtube.com/@channel-${suffix}`,
    })
  ).body.linkedAccount;
  const verified = (
    await admin.patch(`/api/admin/linked-accounts/${linked.id}/verification`, { verified: true })
  ).body.linkedAccount;
  assert(verified.verified, 'linked account was not verified');
  const publicLinks = await streamerB.client.get(`/api/network/linked-accounts/${streamerA.user.id}`);
  assert(publicLinks.body.linkedAccounts.some((item) => item.id === linked.id), 'link is not public');
});

await check('accepted collaboration creates a shared group', async () => {
  const collab = (
    await streamerA.client.post('/api/network/collabs', {
      partnerId: streamerB.user.id,
      title: `Shared ${suffix}`,
    })
  ).body.collab;
  const accepted = (
    await streamerB.client.patch(`/api/network/collabs/${collab.id}`, { status: 'accepted' })
  ).body;
  assert(accepted.group?.id, 'shared group was not created');
  const detail = await streamerB.client.get(`/api/groups/${accepted.group.id}`);
  assert(detail.body.group.memberRole === 'admin', 'partner did not receive group admin role');
});

await check('staff badge grants platform moderation without admin settings access', async () => {
  await admin.put(`/api/admin/users/${staff.user.id}/badges`, { badgeIds: ['staff'] });
  const group = await staff.client.get(`/api/groups/${groupA.id}`);
  assert(group.body.permissions.deleteAnyMessage, 'staff moderation permission missing');
  const adminDenied = await staff.client.get('/api/admin/settings', { allowFail: true });
  assert(adminDenied.status === 403, `staff reached admin settings: ${adminDenied.status}`);
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
