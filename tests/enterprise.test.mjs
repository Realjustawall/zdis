import crypto from 'node:crypto';

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
  async req(method, route, body, { allowFail = false } = {}) {
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(BASE + route, { method, headers, body: payload });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const result = await response.json().catch(() => null);
    if (!allowFail && !response.ok) {
      throw new Error(`${this.name} ${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    }
    return { status: response.status, body: result };
  }
  get(route, options) { return this.req('GET', route, undefined, options); }
  post(route, body, options) { return this.req('POST', route, body, options); }
  put(route, body, options) { return this.req('PUT', route, body, options); }
  patch(route, body, options) { return this.req('PATCH', route, body, options); }
  del(route, options) { return this.req('DELETE', route, undefined, options); }
  async login(identifier, password) {
    const result = await this.post('/api/auth/login', { identifier, password });
    this.csrf = result.body.csrfToken;
    return result.body.user;
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const suffix = Math.random().toString(36).slice(2, 9);
const admin = new Client('admin');
const author = new Client('author');
const reporter = new Client('reporter');

console.log('=== enterprise features test ===\n');
await admin.login('office@intesho.com', 'cNL2*8o$1F;"');
// Enterprise moderation/search workflows intentionally exercise the optional
// server-readable DM mode. The dedicated E2EE suite turns mandatory mode back
// on and verifies ciphertext transport separately.
await admin.patch('/api/admin/settings', { e2ee_required_for_dms: false });

const authorUser = (
  await admin.post('/api/admin/users', {
    email: `enterprise-author-${suffix}@example.com`,
    username: `entauthor${suffix}`,
    displayName: 'Enterprise Author',
    password: 'Enterprise-Author#26',
    role: 'member',
    mustChangePassword: false,
  })
).body.user;
const reporterUser = (
  await admin.post('/api/admin/users', {
    email: `enterprise-reporter-${suffix}@example.com`,
    username: `entreporter${suffix}`,
    displayName: 'Enterprise Reporter',
    password: 'Enterprise-Reporter#26',
    role: 'member',
    mustChangePassword: false,
  })
).body.user;
await author.login(authorUser.email, 'Enterprise-Author#26');
await reporter.login(reporterUser.email, 'Enterprise-Reporter#26');

const conversation = (
  await author.post('/api/conversations/dm', { userId: reporterUser.id })
).body.conversation;
const message = (
  await author.post(`/api/conversations/${conversation.id}/messages`, {
    content: 'Message used by the enterprise moderation test.',
  })
).body.message;

const reportId = (
  await reporter.post(`/api/conversations/${conversation.id}/messages/${message.id}/report`, {
    reason: 'harassment',
    details: 'Automated end-to-end moderation report.',
  })
).body.reportId;
assert(reportId, 'new report id was not returned');

const reports = await admin.get('/api/moderation/reports?status=open');
assert(reports.body.reports.some((item) => item.id === reportId), 'report missing from queue');
const queuedReport = reports.body.reports.find((item) => item.id === reportId);
assert(queuedReport.evidence?.hash?.length === 64, 'report evidence was not captured');
assert(queuedReport.slaDueAt > queuedReport.createdAt, 'report SLA was not assigned');
const reviewed = await admin.patch(`/api/moderation/reports/${reportId}`, {
  status: 'resolved',
  assignedToMe: true,
  resolution: 'Reviewed by automated test.',
});
assert(reviewed.body.report.status === 'resolved', 'report was not resolved');

const timeoutAction = await admin.post(`/api/moderation/users/${authorUser.id}/actions`, {
  action: 'timeout',
  reason: 'Enterprise automated test',
  durationMinutes: 5,
});
const blocked = await author.post(
  `/api/conversations/${conversation.id}/messages`,
  { content: 'This write must be blocked.' },
  { allowFail: true },
);
assert(blocked.status === 403, `timed-out write returned ${blocked.status}`);
const timeoutAppeal = await author.post('/api/auth/moderation-appeals', {
  actionId: timeoutAction.body.actionId,
  reason: 'This automated timeout should be reversed after review.',
});
const openAppeals = await admin.get('/api/moderation/appeals?status=open');
assert(
  openAppeals.body.appeals.some((item) => item.id === timeoutAppeal.body.appeal.id),
  'appeal missing from queue',
);
await admin.patch(`/api/moderation/appeals/${timeoutAppeal.body.appeal.id}`, {
  status: 'approved',
  decision: 'Approved by the automated enterprise review.',
});
const afterAppeal = await author.post(`/api/conversations/${conversation.id}/messages`, {
  content: 'Appeal restored write access.',
});
assert(afterAppeal.status === 201, 'approved appeal did not revoke timeout');

await admin.post(`/api/moderation/users/${authorUser.id}/actions`, {
  action: 'shadowban',
  reason: 'Enterprise shadow test',
});
const shadowMessage = await author.post(`/api/conversations/${conversation.id}/messages`, {
  content: 'Only the shadowed author should see this.',
});
const reporterHistory = await reporter.get(`/api/conversations/${conversation.id}/messages`);
assert(
  !reporterHistory.body.messages.some((item) => item.id === shadowMessage.body.message.id),
  'shadow-banned message leaked into history',
);
await admin.post(`/api/moderation/users/${authorUser.id}/actions`, {
  action: 'unshadow',
  reason: 'Enterprise shadow test completed',
});

await admin.post(`/api/moderation/users/${authorUser.id}/actions`, {
  action: 'slow',
  reason: 'Enterprise user slow mode',
  durationMinutes: 5,
  intervalSeconds: 30,
});
await author.post(`/api/conversations/${conversation.id}/messages`, { content: 'First slow message.' });
const slowed = await author.post(
  `/api/conversations/${conversation.id}/messages`,
  { content: 'Second slow message.' },
  { allowFail: true },
);
assert(slowed.status === 400, 'per-user slow mode did not block rapid sending');
await admin.post(`/api/moderation/users/${authorUser.id}/actions`, {
  action: 'unslow',
  reason: 'Enterprise user slow mode completed',
});
await admin.patch('/api/admin/settings', {
  blocked_terms: 'blocked-enterprise-term',
  spam_messages_per_30s: 3,
});
const filtered = await author.post(
  `/api/conversations/${conversation.id}/messages`,
  { content: 'This includes blocked-enterprise-term.' },
  { allowFail: true },
);
assert(filtered.status === 400, `content filter returned ${filtered.status}`);
await admin.patch('/api/admin/settings', { blocked_terms: '', spam_messages_per_30s: 5 });
await admin.post(`/api/moderation/users/${authorUser.id}/actions`, {
  action: 'ban',
  reason: 'Enterprise automated ban test',
});
const bannedLogin = await new Client('banned').post(
  '/api/auth/login',
  { identifier: authorUser.email, password: 'Enterprise-Author#26' },
  { allowFail: true },
);
assert(bannedLogin.status === 403, `banned login returned ${bannedLogin.status}`);
assert(bannedLogin.body.error.details.appealToken, 'ban response did not issue an appeal token');
const banAppeal = await new Client('ban-appeal').post('/api/auth/moderation-appeals', {
  actionId: bannedLogin.body.error.details.actionId,
  appealToken: bannedLogin.body.error.details.appealToken,
  reason: 'Please review this automated ban because it is part of a test.',
});
await admin.patch(`/api/moderation/appeals/${banAppeal.body.appeal.id}`, {
  status: 'approved',
  decision: 'Automated ban appeal accepted.',
});
await new Client('unbanned').login(authorUser.email, 'Enterprise-Author#26');
await author.login(authorUser.email, 'Enterprise-Author#26');

const role = await admin.post('/api/admin/roles', {
  name: `Reviewers ${suffix}`,
  description: 'Custom moderation role',
  capabilities: ['moderate'],
});
await admin.put(`/api/admin/users/${reporterUser.id}/roles/${role.body.role.id}`, { granted: true });
const assignedRoles = await admin.get(`/api/admin/users/${reporterUser.id}/roles`);
assert(
  assignedRoles.body.roles.some((item) => item.id === role.body.role.id && item.granted),
  'custom RBAC assignment was not visible to the admin panel',
);
const delegated = await reporter.get('/api/moderation/reports?status=resolved');
assert(Array.isArray(delegated.body.reports), 'custom RBAC role did not grant moderation');

const draft = await author.put(`/api/conversations/${conversation.id}/draft`, {
  content: 'A durable cross-device draft.',
  replyToId: message.id,
  attachmentIds: [],
});
assert(draft.body.draft.content.includes('cross-device'), 'draft was not stored');
const loadedDraft = await author.get(`/api/conversations/${conversation.id}/draft`);
assert(loadedDraft.body.draft.replyToId === message.id, 'draft reply context was not restored');

const reply = await author.post(`/api/conversations/${conversation.id}/messages`, {
  content: 'A reply visible in the full thread.',
  replyToId: message.id,
});
const thread = await author.get(
  `/api/conversations/${conversation.id}/messages/${reply.body.message.id}/thread`,
);
assert(thread.body.rootId === message.id, 'thread did not resolve its root');
assert(thread.body.messages.some((item) => item.id === reply.body.message.id), 'thread reply missing');

const poll = await author.post(`/api/conversations/${conversation.id}/polls`, {
  question: 'Which enterprise feature should ship first?',
  options: ['Search', 'Calls', 'Storage'],
  multiple: false,
  anonymous: false,
});
assert(poll.body.message.poll.options.length === 3, 'poll options were not created');
const selectedOption = poll.body.message.poll.options[1].id;
const voted = await reporter.put(
  `/api/conversations/${conversation.id}/messages/${poll.body.message.id}/poll-vote`,
  { optionIds: [selectedOption] },
);
assert(
  voted.body.message.poll.options.find((item) => item.id === selectedOption).votes === 1,
  'poll vote was not counted',
);

await author.put(`/api/conversations/${conversation.id}/messages/${message.id}/saved`, {
  saved: true,
});
const saved = await author.get('/api/saved');
assert(saved.body.messages.some((item) => item.id === message.id), 'saved message was not listed');

const disappearing = await author.post(`/api/conversations/${conversation.id}/messages`, {
  content: 'This message has a server-enforced retention deadline.',
  expiresInSeconds: 60,
});
assert(disappearing.body.message.expiresAt > Date.now(), 'message expiry was not persisted');

const scheduled = await author.post(`/api/conversations/${conversation.id}/scheduled`, {
  content: 'A durable scheduled message.',
  sendAt: Date.now() + 60_000,
});
assert(scheduled.body.scheduled.status === 'scheduled', 'scheduled message was not persisted');
const scheduledList = await author.get(`/api/conversations/${conversation.id}/scheduled`);
assert(
  scheduledList.body.scheduled.some((item) => item.id === scheduled.body.scheduled.id),
  'scheduled message was not listed',
);

const apiCredentials = await author.post('/api/integrations/api-keys', {
  name: 'Enterprise automation',
  scopes: ['read', 'write'],
  expiresAt: Date.now() + 3600_000,
});
assert(apiCredentials.body.token.startsWith('ytbl_'), 'API token was not returned once');
const tokenResponse = await fetch(`${BASE}/api/conversations`, {
  headers: { authorization: `Bearer ${apiCredentials.body.token}` },
});
assert(tokenResponse.ok, `scoped API key returned ${tokenResponse.status}`);

const bot = await author.post('/api/integrations/bots', {
  name: `Build Bot ${suffix}`,
  description: 'Enterprise automation bot',
});
assert(bot.body.bot.id && bot.body.token.startsWith('ytbl_'), 'bot credentials were not created');
await author.del(`/api/integrations/bots/${bot.body.bot.id}`);
const disabledBots = await author.get('/api/integrations/bots');
assert(
  disabledBots.body.bots.some((item) => item.id === bot.body.bot.id && !item.active),
  'bot disable/revocation was not persisted',
);

const webhook = await author.post('/api/integrations/webhooks', {
  targetType: 'conversation',
  targetId: conversation.id,
  name: 'Enterprise webhook',
  endpoint: 'http://localhost:9/hooks',
  events: ['message.created', 'test'],
});
assert(webhook.body.secret.startsWith('whsec_'), 'webhook signing secret was not returned');

const sync = await author.get('/api/integrations/sync?limit=100');
assert(
  sync.body.events.some((item) => item.entityId === message.id),
  'offline sync feed did not contain message event',
);
const exported = await author.get('/api/integrations/export');
assert(exported.body.schemaVersion === 1 && exported.body.messages.length > 0, 'export failed');
const imported = await author.post('/api/integrations/import', {
  targetType: 'conversation',
  targetId: conversation.id,
  messages: [{ sourceId: 'legacy-1', content: 'Imported legacy history row.' }],
});
assert(imported.body.imported[0].sourceId === 'legacy-1', 'history import mapping was lost');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const pngHash = crypto.createHash('sha256').update(png).digest('hex');
const uploadSession = await author.post('/api/files/resumable', {
  filename: 'resumable-pixel.png',
  mime: 'image/png',
  size: png.length,
  sha256: pngHash,
});
const partResponse = await fetch(
  `${BASE}/api/files/resumable/${uploadSession.body.upload.id}/parts/1`,
  {
    method: 'PUT',
    headers: {
      cookie: author.cookieHeader(),
      'x-csrf-token': author.csrf,
      'content-type': 'application/octet-stream',
      'content-sha256': pngHash,
    },
    body: png,
  },
);
assert(partResponse.ok, `resumable part returned ${partResponse.status}`);
const completedUpload = await author.post(
  `/api/files/resumable/${uploadSession.body.upload.id}/complete`,
  {},
);
assert(completedUpload.body.attachment.mime === 'image/png', 'resumable upload was not finalized');
const quota = await author.get('/api/files/quota');
assert(
  quota.body.quota.usedBytes >= png.length && quota.body.quota.reservedBytes === 0,
  'storage quota reservation was not committed',
);

const callGroup = (
  await admin.post('/api/groups', { name: `Enterprise Call ${suffix}` })
).body.group;
await admin.post(`/api/groups/${callGroup.id}/members`, {
  userId: authorUser.id,
  role: 'member',
});
await admin.post(`/api/groups/${callGroup.id}/members`, {
  userId: reporterUser.id,
  role: 'member',
});
const voiceChannel = (
  await admin.post(`/api/groups/${callGroup.id}/channels`, {
    name: 'town-hall',
    type: 'voice',
  })
).body.channel;
const callSettings = await admin.patch(`/api/voice/${voiceChannel.id}/settings`, {
  lobbyEnabled: true,
  recordingConsentRequired: true,
});
assert(callSettings.body.room.lobbyEnabled, 'call lobby setting was not stored');
const lobbyRequest = await author.post(`/api/voice/${voiceChannel.id}/lobby`, {});
assert(lobbyRequest.status === 202, 'non-host was not placed in the lobby');
const memberCallState = await author.get(`/api/voice/${voiceChannel.id}`);
assert(memberCallState.body.lobby.length === 0, 'lobby identities leaked to a non-host');
const callState = await admin.get(`/api/voice/${voiceChannel.id}`);
assert(
  callState.body.lobby.some((item) => item.userId === authorUser.id),
  'host could not see lobby request',
);
await admin.patch(`/api/voice/${voiceChannel.id}/lobby/${authorUser.id}`, { approved: true });
await author.put(`/api/voice/${voiceChannel.id}/consent`, {
  recording: true,
  transcript: true,
});
const consentState = await author.get(`/api/voice/${voiceChannel.id}`);
assert(
  consentState.body.consent.recording && consentState.body.consent.transcript,
  'current call consent was not returned',
);
await author.post(`/api/voice/${voiceChannel.id}/quality`, {
  quality: 'good',
  rttMs: 42,
  jitterMs: 4,
  packetLoss: 0.2,
  bitrateKbps: 1200,
  region: 'default',
});
const quality = await admin.get(`/api/voice/${voiceChannel.id}/quality`);
assert(quality.body.samples === 1 && quality.body.avgRttMs === 42, 'call quality was not aggregated');

const preferences = await reporter.patch('/api/notifications/preferences', {
  email: false,
  push: false,
  mentions: true,
  directMessages: true,
  quietStart: '23:00',
  quietEnd: '07:00',
  timezone: 'Asia/Tehran',
  digestFrequency: 'daily',
  digestHour: 9,
});
assert(preferences.body.preferences.directMessages, 'notification preference was not saved');
assert(
  preferences.body.preferences.timezone === 'Asia/Tehran' &&
    preferences.body.preferences.digestFrequency === 'daily',
  'quiet hours and digest preference were not saved',
);
const notifications = await reporter.get('/api/notifications');
assert(
  notifications.body.notifications.some((item) => item.type === 'direct_message'),
  'direct-message notification was not created',
);
await reporter.post('/api/notifications/read', { id: null });
const afterRead = await reporter.get('/api/notifications');
assert(afterRead.body.unread === 0, 'mark-all-read did not clear unread notifications');
const channelPreference = await reporter.put(
  `/api/notifications/channels/conversation/${conversation.id}`,
  { level: 'none', email: false, push: false },
);
assert(channelPreference.body.preference.level === 'none', 'per-conversation mute was not stored');
await author.post(`/api/conversations/${conversation.id}/messages`, {
  content: 'This direct message is muted by a per-conversation preference.',
});
const afterMutedMessage = await reporter.get('/api/notifications');
assert(afterMutedMessage.body.unread === 0, 'muted conversation still generated a notification');
const deadLetters = await admin.get('/api/admin/notification-dlq');
assert(Array.isArray(deadLetters.body.deadLetters), 'notification DLQ is not observable');
const operations = await admin.get('/api/admin/operations');
assert(
  operations.body.services.database.ok && operations.body.services.storage.ok,
  'admin operations health did not report core services',
);
assert(typeof operations.body.features.dlp === 'string', 'admin feature matrix is incomplete');

const ready = await admin.get('/api/ready');
assert(ready.body.ok, 'readiness probe failed');
const metrics = await fetch(`${BASE}/api/metrics`);
assert(metrics.ok && (await metrics.text()).includes('youtbelimo_http_request_duration_seconds'), 'metrics unavailable');

console.log('  PASS  moderation, RBAC, chat, integrations, sync, notifications and readiness');
