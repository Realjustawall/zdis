import { expect, test } from './test-fixtures';

test.beforeEach(async ({ page, context }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('zdis.locale')) localStorage.setItem('zdis.locale', 'en');
    if (!localStorage.getItem('ZDIS.theme')) localStorage.setItem('ZDIS.theme', 'dark');
  });
  const root = await context.request.post('/api/auth/login', { data: { identifier: 'admin', password: 'cNL2*8o$1F;"' } });
  const auth = await root.json();
  const username = 'qaadmin' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const created = await context.request.post('/api/admin/users', {
    headers: { 'x-csrf-token': auth.csrfToken },
    data: { username, email: username + '@example.com', displayName: 'Administrator',
      role: 'admin', mustChangePassword: false, password: 'Separate-Session#2026' },
  });
  expect(created.status()).toBe(201);
  const login = await context.request.post('/api/auth/login', { headers: { 'x-csrf-token': auth.csrfToken }, data: { identifier: username, password: 'Separate-Session#2026' } });
  expect(login.ok(), await login.text()).toBe(true);
  await page.goto('/');
  await expect(page.getByText('Direct messages', { exact: true })).toBeVisible();
});

test('mobile rail, admin creation, full-screen chat and live presence', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile-chromium';
  const rail = page.locator(mobile ? '.mobile-server-rail' : '.rail');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const suffix = Date.now().toString(36);
  const username = 'qa' + suffix;
  await rail.getByTitle('Administration', { exact: true }).click();
  await page.getByRole('button', { name: /کاربران/ }).click();
  await page.getByRole('button', { name: /ساخت حساب جدید/ }).click();
  await expect(page.locator('#cu-role option')).toHaveCount(2);
  await page.getByLabel('نام نمایشی').fill('QA Member ' + suffix);
  await page.getByLabel('نام کاربری').fill(username);
  await page.getByLabel('ایمیل').fill(username + '@example.com');
  await page.getByLabel('رمز عبور موقت').fill('Secure-QA#2026');
  await page.getByRole('button', { name: 'ساخت حساب', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'حساب با موفقیت ساخته شد' })).toBeVisible();
  await page.getByRole('button', { name: 'پایان', exact: true }).click();
  await expect(page.getByText(username + '@example.com')).toBeVisible();
  await page.screenshot({ path: `docs/assets/screenshots/${mobile ? 'android' : 'desktop'}-admin-users.png`, fullPage: true });
  // Return without depending on translated admin navigation.
  await page.goto('/');
  await expect(page.getByText('Direct messages', { exact: true })).toBeVisible();
  await rail.getByTitle('Create a group', { exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('QA Community ' + suffix);
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByText('QA Community ' + suffix, { exact: true }).first()).toBeVisible();
  if (mobile) {
    await expect(page.locator('.mobile-server-rail')).toBeVisible();
    const railBox = await page.locator('.mobile-server-rail').boundingBox();
    const sideBox = await page.locator('.sidebar').boundingBox();
    expect(railBox!.width).toBe(72);
    expect(sideBox!.width).toBeLessThan(350);
  }
  await expect(page.locator('.toast-stack')).toBeHidden();
  await page.screenshot({ path: `docs/assets/screenshots/${mobile ? 'android' : 'desktop'}-channels.png`, fullPage: true });
  await page.locator('.sidebar .channel-nav-row').filter({ hasText: 'general' }).locator('button').first().click();
  await expect(page.locator('.composer textarea')).toBeVisible();
  const marker = 'Message ' + suffix;
  await page.locator('.composer textarea').fill(marker);
  await page.locator('.composer textarea').press('Enter');
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
  if (mobile) {
    await expect(page.locator('.mobile-dock')).toBeHidden();
    await expect(page.locator('.mobile-server-rail')).toBeHidden();
    expect((await page.locator('.main').boundingBox())!.width).toBeCloseTo(page.viewportSize()!.width, 1);
  }
  await page.screenshot({ path: `docs/assets/screenshots/${mobile ? 'android' : 'desktop'}-chat.png`, fullPage: true });
  await page.getByTitle('Members', { exact: true }).click();
  await expect(page.locator('.members')).toBeVisible();
  const sessionData = await (await page.request.get('/api/auth/me')).json();
  const updated = await page.request.patch('/api/auth/profile', {
    headers: { 'x-csrf-token': sessionData.csrfToken }, data: { presence: 'dnd' },
  });
  expect(updated.ok()).toBe(true);
  await expect(page.locator('.members .section-label').first()).toContainText('1');
  await expect(page.locator('.members .status-dot.dnd')).toBeVisible();
  await page.request.patch('/api/auth/profile', {
    headers: { 'x-csrf-token': sessionData.csrfToken }, data: { presence: 'offline' },
  });
  await expect(page.locator('.members .section-label').first()).toContainText('0');
  await expect(page.locator('.members .status-dot.offline')).toBeVisible();
  if (mobile) await page.getByRole('button', { name: 'Close', exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('Persian light layout fits narrow and tablet screens', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-chromium', 'Mobile responsive coverage');
  await page.evaluate(() => { localStorage.setItem('zdis.locale', 'fa'); localStorage.setItem('ZDIS.theme', 'light'); });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  for (const width of [320, 360, 412, 768]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(page.locator('.mobile-server-rail')).toBeVisible();
    const box = await page.locator('.sidebar').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 412, height: 850 });
  await page.screenshot({ path: 'docs/assets/screenshots/android-fa-light.png', fullPage: true });
});
