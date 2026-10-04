import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './test-fixtures';

test.use({ launchOptions: {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--enable-usermedia-screen-capturing',
    '--auto-select-desktop-capture-source=Entire screen'],
} });
test.setTimeout(90_000);
const password = 'Media-Regression#2026';

async function post(context: BrowserContext, endpoint: string, data: unknown, csrf: string, status = 201) {
  const response = await context.request.post(endpoint, { data, headers: { 'x-csrf-token': csrf } });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function setup(browser: Browser, baseURL: string) {
  const contexts: BrowserContext[] = [];
  const newContext = async () => {
    const context = await browser.newContext({ baseURL, permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 900 } });
    contexts.push(context);
    await context.addInitScript(() => {
      localStorage.setItem('zdis.locale', 'en');
      const state = window as unknown as { mediaCaptures: MediaStream[]; mediaPeers: RTCPeerConnection[] };
      state.mediaCaptures = []; state.mediaPeers = [];
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(config?: RTCConfiguration) { super(config); state.mediaPeers.push(this); }
      };
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async (options) => {
        const stream = await original(options); state.mediaCaptures.push(stream); return stream;
      };
    });
    return context;
  };
  const admin = await newContext();
  const login = await post(admin, '/api/auth/login', { identifier: 'admin', password: 'cNL2*8o$1F;"' }, '', 200);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const users = [];
  for (let i = 0; i < 2; i++) {
    const name = 'Media ' + (i ? 'Bob ' : 'Alice ') + suffix;
    const { user } = await post(admin, '/api/admin/users', { email: 'media' + i + suffix + '@example.com', username: 'media' + i + suffix, displayName: name, password, role: 'member', mustChangePassword: false }, login.csrfToken);
    const context = await newContext();
    const session = await post(context, '/api/auth/login', { identifier: user.email, password }, '', 200);
    users.push({ context, user, csrf: session.csrfToken });
  }
  return { admin, adminCsrf: login.csrfToken, users, contexts };
}
async function ready(context: BrowserContext) {
  const page = await context.newPage(); await page.goto('/');
  await expect(page.getByText('Direct messages', { exact: true })).toBeVisible(); return page;
}
async function inbound(page: Page, kind: string) {
  return page.evaluate(async (kind) => {
    const state = window as unknown as { mediaPeers: RTCPeerConnection[] };
    const rows = [];
    for (const pc of state.mediaPeers) {
      if (pc.connectionState === 'closed') continue;
      for (const row of (await pc.getStats()).values()) {
        if (row.type === 'inbound-rtp' && row.kind === kind) rows.push(kind === 'audio' ? row.bytesReceived : row.framesDecoded);
      }
    }
    return rows.reduce((n, value) => n + (value || 0), 0);
  }, kind);
}

test('voice media renegotiates in both directions and displays screen over an active camera', async ({ browser, baseURL }) => {
  const s = await setup(browser, baseURL!);
  try {
    const { group, channels } = await post(s.admin, '/api/groups', { name: 'Media regression ' + Date.now() }, s.adminCsrf);
    const { invite } = await post(s.admin, '/api/groups/' + group.id + '/invites', { maxUses: 2 }, s.adminCsrf);
    for (const u of s.users) await post(u.context, '/api/groups/join/' + invite.code, {}, u.csrf, 200);
    const pages = await Promise.all(s.users.map(u => ready(u.context)));
    for (const p of pages) {
      await p.getByTitle(group.name, { exact: true }).click();
      await p.locator('.sidebar').getByText(channels.find((c: {type: string}) => c.type === 'voice').name, { exact: true }).click();
      await p.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(p.getByRole('button', { name: 'Leave', exact: true })).toBeVisible();
    }
    for (const p of pages) await expect.poll(() => inbound(p, 'audio'), { timeout: 15_000 }).toBeGreaterThan(1000);
    // Simultaneous offers exercise glare handling, rather than just first join.
    await Promise.all(pages.map(p => p.getByTitle('Turn camera on', { exact: true }).click()));
    for (const p of pages) await expect.poll(() => inbound(p, 'video'), { timeout: 15_000 }).toBeGreaterThan(5);
    const [a, b] = pages;
    await a.getByTitle('Share your screen', { exact: true }).click();
    await expect(a.getByTitle('Stop sharing', { exact: true })).toBeVisible();
    const screenId = await a.evaluate(() => (window as unknown as {mediaCaptures: MediaStream[]}).mediaCaptures.at(-1)!.getVideoTracks()[0].id);
    const remoteVideo = b.locator('.voice-tile').filter({ hasText: s.users[0].user.displayName }).locator('video');
    await expect.poll(() => remoteVideo.evaluate(v => (v.srcObject as MediaStream)?.getVideoTracks()[0]?.id), { timeout: 15_000 }).toBe(screenId);
    await expect.poll(() => remoteVideo.evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    const time = await remoteVideo.evaluate(v => v.currentTime);
    await expect.poll(() => remoteVideo.evaluate(v => v.currentTime)).toBeGreaterThan(time);
    await a.getByTitle('Stop sharing', { exact: true }).click();
    await expect.poll(() => remoteVideo.evaluate(v => (v.srcObject as MediaStream)?.getVideoTracks()[0]?.id), { timeout: 15_000 }).not.toBe(screenId);
    await expect.poll(() => remoteVideo.evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    for (const p of pages) await p.getByRole('button', { name: 'Leave', exact: true }).click();
  } finally { for (const c of s.contexts) await c.close(); }
});

test('private call receives media, ends on both sides and closes after decline', async ({ browser, baseURL }) => {
  const s = await setup(browser, baseURL!);
  try {
    await post(s.users[0].context, '/api/conversations/dm', { userId: s.users[1].user.id }, s.users[0].csrf);
    const [a, b] = await Promise.all(s.users.map(u => ready(u.context)));
    await a.locator('.sidebar').getByText(s.users[1].user.displayName, { exact: true }).click();
    await b.locator('.sidebar').getByText(s.users[0].user.displayName, { exact: true }).click();
    await a.getByTitle('Start video call', { exact: true }).click();
    await b.getByTitle('Answer', { exact: true }).click();
    for (const p of [a, b]) await expect.poll(() => inbound(p, 'video'), { timeout: 15_000 }).toBeGreaterThan(5);
    await a.getByTitle('End call', { exact: true }).click();
    await expect(b.getByTitle('End call', { exact: true })).toHaveCount(0);
    await a.getByTitle('Start voice call', { exact: true }).click();
    await b.getByTitle('Decline', { exact: true }).click();
    await expect(a.getByTitle('End call', { exact: true })).toHaveCount(0);
  } finally { for (const c of s.contexts) await c.close(); }
});
