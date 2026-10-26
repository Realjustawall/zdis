import { test, expect } from './test-fixtures';
import type { Page } from '@playwright/test';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });

async function inboundAudio(page: Page) {
  return page.evaluate(async () => {
    let bytes = 0;
    for (const peer of (window as any).qaPeers as RTCPeerConnection[]) {
      if (peer.connectionState === 'closed') continue;
      (await peer.getStats()).forEach(stat => { if (stat.type === 'inbound-rtp' && stat.kind === 'audio') bytes += stat.bytesReceived || 0; });
    }
    return bytes;
  });
}

for (const scenario of ['explicit', 'no-devices', 'denied', 'camera-denied'] as const) {
  test(`production call supports ${scenario} and preserves receive-only audio`, async ({ browser, baseURL }, info) => {
    test.setTimeout(60000);
    const signallingOnly = process.env.VOICE_QA_SIGNALLING_ONLY === '1';
    if (process.env.CI && signallingOnly) throw new Error('CI must verify actual received media; signalling-only mode is local diagnostics only.');
    if (signallingOnly) info.annotations.push({type: 'limitation', description: 'Only signalling and capture controls verified; this runner cannot enumerate network interfaces for ICE.'});
    const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL,
      viewport: info.project.name === 'mobile-chromium' ? { width: 360, height: 780 } : { width: 1280, height: 900 },
      permissions: ['microphone', 'camera', 'local-network-access'] })));
    const [owner, member] = contexts;
    for (const context of contexts) await context.addInitScript(() => {
      localStorage.setItem('zdis.locale', 'en');
      const w = window as any, NativePeer = RTCPeerConnection, NativeSocket = WebSocket;
      w.qaPeers = []; w.qaSockets = []; w.qaReady = 0;
      w.RTCPeerConnection = class extends NativePeer { constructor(config: RTCConfiguration) { super(config); w.qaPeers.push(this); } };
      w.WebSocket = class extends NativeSocket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); w.qaSockets.push(this); this.addEventListener('message', event => { if (String(event.data).includes('["ready",')) w.qaReady++; }); } };
      w.qaMediaPolicy = 'real'; w.qaCaptures = [];
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        w.qaCaptures.push(constraints);
        if (w.qaMediaPolicy === 'none') throw new DOMException('No input devices', 'NotFoundError');
        if (w.qaMediaPolicy === 'denied') throw new DOMException('Capture denied', 'NotAllowedError');
        if (w.qaMediaPolicy === 'camera-denied' && constraints.video) throw new DOMException('No webcam', 'NotFoundError');
        return capture(constraints);
      };
    });
    let groupId: string | undefined, userId: string | undefined;
    const auth = await (await owner.request.post('/api/auth/login', { data: { identifier: 'admin', password: 'cNL2*8o$1F;"' } })).json();
    const headers = { 'x-csrf-token': auth.csrfToken };
    try {
      const username = `listener${Date.now()}${Math.random().toString(36).slice(2, 5)}`, password = 'Listener-Test#2026';
      const added = await owner.request.post('/api/admin/users', { headers, data: { username, email: username + '@example.test', displayName: 'Listener peer', role: 'member', mustChangePassword: false, password } });
      expect(added.status()).toBe(201); userId = (await added.json()).user.id;
      const created = await owner.request.post('/api/groups', { headers, data: { name: 'Listener QA ' + Date.now() } });
      expect(created.status()).toBe(201); const { group, channels } = await created.json(); groupId = group.id;
      const voice = channels.find((channel: { type: string }) => channel.type === 'voice');
      expect((await owner.request.post(`/api/groups/${groupId}/members`, { headers, data: { userId } })).status()).toBe(201);
      expect((await member.request.post('/api/auth/login', { data: { identifier: username, password } })).ok()).toBe(true);
      const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
      const errors: string[] = []; for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
      for (const page of [a, b]) {
        await page.goto('/'); await page.getByTitle(group.name, { exact: true }).click();
        await page.locator('.sidebar').getByText(voice.name, { exact: true }).click();
      }
      await a.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(a.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
      await b.evaluate(policy => { (window as any).qaMediaPolicy = policy; }, scenario === 'denied' ? 'denied' : scenario === 'camera-denied' ? 'camera-denied' : 'none');
      await b.getByRole('button', { name: scenario === 'explicit' ? 'Join as listener' : scenario === 'camera-denied' ? 'Join with camera' : 'Join voice', exact: true }).click();
      await expect(b.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
      if (scenario === 'explicit' && info.project.name === 'mobile-chromium') await b.screenshot({path: 'docs/assets/screenshots/listener-only-mobile.png', animations: 'disabled'});
      if (!signallingOnly) {
        try { await expect.poll(() => inboundAudio(b), { timeout: 15000 }).toBeGreaterThan(1000); }
        catch (error) {
          console.error('MEDIA DIAGNOSTICS', JSON.stringify(await Promise.all([a,b].map(page=>page.evaluate(async()=>Promise.all(((window as any).qaPeers as RTCPeerConnection[]).map(async pc=>({state:pc.connectionState,ice:pc.iceConnectionState,gathering:pc.iceGatheringState,candidates:Array.from((await pc.getStats()).values()).filter(s=>['candidate-pair','local-candidate','remote-candidate'].includes(s.type)).length}))))))));
          throw error;
        }
      }
      if (scenario === 'camera-denied') {
        await expect(b.getByTitle('Mute', { exact: true })).toBeVisible();
        await expect(b.getByTitle('Turn camera on', { exact: true })).toBeVisible();
      } else {
        await expect(b.getByTitle('Unmute', { exact: true })).toBeVisible();
        if (scenario === 'explicit') expect(await b.evaluate(() => (window as any).qaCaptures.length)).toBe(0);
        await b.getByTitle('Deafen', { exact: true }).click();
        await b.getByTitle('Undeafen', { exact: true }).click();
        await expect(b.getByTitle('Unmute', { exact: true })).toBeVisible();
        const attempts = await b.evaluate(() => (window as any).qaCaptures.length);
        await b.getByTitle('Unmute', { exact: true }).click();
        await expect.poll(() => b.evaluate(() => (window as any).qaCaptures.length)).toBeGreaterThan(attempts);
        await expect(b.getByTitle('Unmute', { exact: true })).toBeVisible();
        await expect(b.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
        // Grant an input later: publishing is negotiated without leaving the call.
        await b.evaluate(() => { (window as any).qaMediaPolicy = 'real'; });
        await b.getByTitle('Unmute', { exact: true }).click();
        await expect(b.getByTitle('Mute', { exact: true })).toBeVisible();
        if (!signallingOnly) await expect.poll(() => inboundAudio(a), { timeout: 15000 }).toBeGreaterThan(1000);
        await b.getByTitle('Mute', { exact: true }).click();
        await b.getByTitle('Deafen', { exact: true }).click(); await b.getByTitle('Undeafen', { exact: true }).click();
        await expect(b.getByTitle('Unmute', { exact: true })).toBeVisible();
      }
      // A transport reconnect restores room registration without another capture.
      const capturesBefore = await b.evaluate(() => (window as any).qaCaptures.length);
      const readyBefore = await b.evaluate(() => (window as any).qaReady);
      await b.evaluate(() => { for (const socket of (window as any).qaSockets as WebSocket[]) if (socket.url.includes('/socket.io') && socket.readyState === WebSocket.OPEN) socket.close(); });
      await expect.poll(() => b.evaluate(() => (window as any).qaReady), { timeout: 15000 }).toBeGreaterThan(readyBefore);
      await expect(b.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
      if (!signallingOnly) {
        const received = await inboundAudio(b);
        await expect.poll(() => inboundAudio(b), { timeout: 15000 }).toBeGreaterThan(received + 1000);
      }
      expect(await b.evaluate(() => (window as any).qaCaptures.length)).toBe(capturesBefore);
      expect(errors).toEqual([]);
    } finally {
      for (const context of contexts) for (const page of context.pages()) await page.close();
      if (groupId) await owner.request.delete('/api/groups/' + groupId, { headers });
      if (userId) await owner.request.delete('/api/admin/users/' + userId, { headers });
      for (const context of contexts) await context.close();
    }
  });
}
