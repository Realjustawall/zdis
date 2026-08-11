import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zdis.locale', 'en'));
  page.on('pageerror', (error) => console.error(`browser page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`browser console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      console.error(`browser response ${response.status()} ${response.url()}`);
    }
  });
  await page.goto('/');
  await page.getByLabel('Email or username').fill('office@intesho.com');
  await page.getByLabel('Password').fill('cNL2*8o$1F;"');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Direct messages', { exact: true })).toBeVisible();
});

test('administrator can inspect runtime and accounts', async ({ page }) => {
  await page.getByTitle('Administration').click();
  await expect(page.getByRole('heading', { name: 'داشبورد' })).toBeVisible();
  await expect(page.getByText('پایگاه‌داده', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /کاربران/ }).click();
  await expect(page.getByRole('heading', { name: 'مدیریت متمرکز کاربران' })).toBeVisible();
  await expect(page.getByText('office@intesho.com')).toBeVisible();
});

test('administrator can create an account through the browser', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name.replace(/\W/g, '')}${Date.now()}`.slice(-18).toLowerCase();
  await page.getByTitle('Administration').click();
  await page.getByRole('button', { name: /کاربران/ }).click();
  await page.getByRole('button', { name: /ساخت حساب جدید/ }).click();
  await page.getByLabel('نام نمایشی').fill('E2E Member');
  await page.getByLabel('نام کاربری').fill(`e2e${suffix}`);
  await page.getByLabel('ایمیل').fill(`e2e-${suffix}@example.com`);
  await page.getByLabel('رمز عبور موقت').fill('E2E-Secure#2026');
  await page.getByRole('button', { name: 'ساخت حساب', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'حساب با موفقیت ساخته شد' })).toBeVisible();
});

test('admin theme and operations center are functional', async ({ page }) => {
  await page.getByTitle('Administration').click();
  await page.getByLabel(/Change theme/).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: /عملیات و سلامت/ }).click();
  await expect(page.getByRole('heading', { name: 'مرکز عملیات و قابلیت اطمینان' })).toBeVisible();
  await expect(page.getByText('پایگاه‌داده', { exact: true })).toBeVisible();
  await expect(page.getByText('صف خطاهای تحویل')).toBeVisible();
});

test('notification inbox and preference controls are reachable', async ({ page }) => {
  await page.getByTitle('Notifications').click();
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Close/i }).click();

  await page.getByTitle('Account settings').click();
  await page.getByRole('tab', { name: 'Notifications' }).click();
  await expect(page.getByText('In-app inbox')).toBeVisible();
  await expect(page.getByText('Push delivery')).toBeVisible();
});

test('offers the expanded dark theme collection', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The same theme studio is shared by desktop and mobile.');
  await page.getByTitle('Customize appearance').click();
  await expect(page.getByRole('heading', { name: 'Appearance & themes' })).toBeVisible();
  await expect(page.locator('.theme-preset-card')).toHaveCount(11);
  await page.getByRole('button', { name: /Tokyo night/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-custom-theme', 'true');
  await expect(page.locator('html')).toHaveCSS('--zdis-accent', '#7aa2f7');
});

test('creates a group and sends a realtime chat message', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/\W/g, '').slice(-12);
  const groupName = `E2E Room ${suffix}`;
  const content = `Browser message ${suffix}`;

  await page.getByTitle('Create a group').click();
  await page.getByLabel('Name', { exact: true }).fill(groupName);
  await page.getByLabel('Description (optional)').fill('Created by the Playwright browser suite.');
  await page.getByRole('button', { name: 'Create group' }).click();

  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
  const activeServer = page.locator('.rail').getByTitle(groupName);
  const serverBox = await activeServer.boundingBox();
  const selectionPillBox = await activeServer.locator('.pill').boundingBox();
  expect(serverBox).not.toBeNull();
  if (testInfo.project.name === 'chromium') {
    expect(selectionPillBox).not.toBeNull();
    expect(selectionPillBox!.x + selectionPillBox!.width).toBeLessThan(serverBox!.x);
    expect(Math.abs(
      selectionPillBox!.y + selectionPillBox!.height / 2 - (serverBox!.y + serverBox!.height / 2),
    )).toBeLessThan(1);
  } else {
    await expect(activeServer).toHaveClass(/active/);
  }
  await page.getByText('general', { exact: true }).first().click();
  const composer = page.getByPlaceholder(/Message .*general/);
  await expect(composer).toBeVisible();
  await composer.fill(content);
  await composer.press('Enter');
  await expect(page.locator('.message .content').filter({ hasText: content })).toBeVisible();
  await expect(page.locator('.message .content').filter({ hasText: content })).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('opens at the newest message and follows messages sent by the viewer', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/\W/g, '').slice(-12);
  const groupName = `Scroll ${suffix}`;

  await page.getByTitle('Create a group').click();
  await page.getByLabel('Name', { exact: true }).fill(groupName);
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.getByText('general', { exact: true }).first().click();

  const composer = page.getByPlaceholder(/Message .*general/);
  const scroll = page.locator('.message-scroll');
  const tallMessage = Array.from({ length: 80 }, (_, index) => `History line ${index + 1}`).join('\n');
  await composer.fill(tallMessage);
  await composer.press('Enter');
  await expect(page.locator('.message .content').filter({ hasText: 'History line 80' })).toBeVisible();
  await expect.poll(() => scroll.evaluate((node) => node.scrollHeight > node.clientHeight + 100)).toBe(true);

  await scroll.evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(100);

  const latest = `Newest message ${suffix}`;
  await composer.fill(latest);
  await composer.press('Enter');
  await expect(page.locator('.message .content').filter({ hasText: latest })).toBeVisible();
  await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);

  // Reopening a populated channel should also land at its newest message.
  if (testInfo.project.name === 'chromium') {
    await scroll.evaluate((node) => { node.scrollTop = 0; });
    await page.getByText('announcements', { exact: true }).first().click();
    await page.getByText('general', { exact: true }).first().click();
    await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
  }
});

test('removes a deleted message without leaving a tombstone row', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Desktop interaction coverage is sufficient for the shared deletion state.');
  const suffix = `${Date.now()}`.slice(-10);
  const groupName = `Delete ${suffix}`;
  const content = `Remove me ${suffix}`;

  await page.getByTitle('Create a group').click();
  await page.getByLabel('Name', { exact: true }).fill(groupName);
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.getByText('general', { exact: true }).first().click();

  const composer = page.getByPlaceholder(/Message .*general/);
  await composer.fill(`Upper message ${suffix}`);
  await composer.press('Enter');
  await expect(page.locator('.message .content').filter({ hasText: `Upper message ${suffix}` })).toBeVisible();
  await composer.fill(content);
  await composer.press('Enter');
  const message = page.locator('.message').filter({ hasText: content });
  await expect(message).toHaveCount(1);
  await message.hover();
  const toolbar = message.locator('.msg-actions');
  await expect(toolbar).toBeVisible();
  expect(await toolbar.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit && node.contains(hit));
  })).toBe(true);
  await message.getByTitle('Delete').click();
  await page.getByRole('dialog', { name: 'Delete message' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();

  await expect(message).toHaveCount(0);
  await expect(page.getByText('This message was deleted.', { exact: true })).toHaveCount(0);
});

test('renders mixed-direction text and a bounded native text preview', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/\W/g, '').slice(-10);
  const groupName = `Preview ${suffix}`;
  await page.getByTitle('Create a group').click();
  await page.getByLabel('Name', { exact: true }).fill(groupName);
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.getByText('general', { exact: true }).first().click();

  const content = 'سلام John، ساعت 8 میای؟ Version 2.1 آماده شد! https://example.com';
  const composer = page.getByPlaceholder(/Message .*general/);
  await composer.fill(content);
  await page.locator('.composer input[type="file"]').setInputFiles({
    name: 'نمونه-mixed.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# Preview\n${content}\n`),
  });
  await expect(page.locator('.pending-chip').filter({ hasText: 'mixed.md' })).toBeVisible();
  await composer.press('Enter');

  const message = page.locator('.message').filter({ hasText: 'Version 2.1' }).last();
  await expect(message).toBeVisible();
  await expect(message.locator('.content')).toHaveAttribute('dir', 'auto');
  await expect(message.locator('.attachment-text')).toContainText('Preview');
  await expect(message.locator('.attachment-text pre')).toHaveAttribute('dir', 'auto');
});
