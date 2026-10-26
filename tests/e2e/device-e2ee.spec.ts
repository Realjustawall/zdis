import { test, expect } from './test-fixtures';

test('two devices generate private keys locally and exchange encrypted messages', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'chromium', 'Two independent desktop devices');
  const admin = await browser.newContext({ baseURL });
  const login = await admin.request.post('/api/auth/login', { data: { identifier: 'admin', password: 'cNL2*8o$1F;"' } });
  const auth = await login.json();
  const peers = [];
  try {
    for (const label of ['Alice', 'Bob']) {
      const username = label.toLowerCase() + Date.now().toString(36);
      const created = await admin.request.post('/api/admin/users', {
        headers: { 'x-csrf-token': auth.csrfToken },
        data: { username, displayName: label, email: username + '@example.com', password: 'Device-Private#2026', role: 'member', mustChangePassword: false },
      });
      expect(created.status()).toBe(201);
      const user = (await created.json()).user;
      const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 850 } });
      await context.addInitScript(() => localStorage.setItem('zdis.locale', 'en'));
      const response = await context.request.post('/api/auth/login', { data: { identifier: username, password: 'Device-Private#2026' } });
      expect(response.ok()).toBe(true);
      const session = await response.json();
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByText('Direct messages', { exact: true })).toBeVisible();
      await expect.poll(async () => (await (await context.request.get('/api/e2ee/identity')).json()).identity?.publicKey?.encryption?.x).toBeTruthy();
      const bootstrap = await (await context.request.get('/api/e2ee/identity/bootstrap')).json();
      expect(bootstrap.identity.privateKey).toBeNull();
      const extractable = await page.evaluate(async (id) => new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open('zdis-e2ee');
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('identity').objectStore('identity').get('user:' + id);
          read.onsuccess = () => { resolve(read.result.encryptionPrivate.extractable); db.close(); };
          read.onerror = () => reject(read.error);
        };
        request.onerror = () => reject(request.error);
      }), user.id);
      expect(extractable).toBe(false);
      peers.push({ context, page, user, session });
    }
    const [alice, bob] = peers;
    const dm = await alice.context.request.post('/api/conversations/dm', {
      headers: { 'x-csrf-token': alice.session.csrfToken }, data: { userId: bob.user.id },
    });
    expect(dm.status()).toBe(201);
    const conversation = (await dm.json()).conversation;
    await alice.page.reload();
    await alice.page.locator('.sidebar .nav-item').filter({ hasText: 'Bob' }).click();
    await bob.page.locator('.sidebar .nav-item').filter({ hasText: 'Alice' }).click();
    const plaintext = 'Private device message ' + Date.now();
    await alice.page.locator('.composer textarea').fill(plaintext);
    await alice.page.locator('.composer textarea').press('Enter');
    await expect(bob.page.getByText(plaintext, { exact: true })).toBeVisible();
    const messages = await (await alice.context.request.get(`/api/conversations/${conversation.id}/messages`)).json();
    expect(JSON.stringify(messages)).not.toContain(plaintext);
    expect(JSON.stringify(messages)).toContain('e2ee:v1:');
    await bob.page.reload();
    await bob.page.locator('.sidebar .nav-item').filter({ hasText: 'Alice' }).click();
    await expect(bob.page.getByText(plaintext, { exact: true })).toBeVisible();
  } finally {
    for (const peer of peers) await peer.context.close();
    await admin.close();
  }
});
