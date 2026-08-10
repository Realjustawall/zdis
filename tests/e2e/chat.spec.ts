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
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByText('In-app inbox')).toBeVisible();
  await expect(page.getByText('Push delivery')).toBeVisible();
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
  expect(selectionPillBox).not.toBeNull();
  expect(selectionPillBox!.x + selectionPillBox!.width).toBeLessThan(serverBox!.x);
  expect(Math.abs(
    selectionPillBox!.y + selectionPillBox!.height / 2 - (serverBox!.y + serverBox!.height / 2),
  )).toBeLessThan(1);
  await page.getByText('general', { exact: true }).first().click();
  const composer = page.getByPlaceholder(/Message .*general/);
  await expect(composer).toBeVisible();
  await composer.fill(content);
  await composer.press('Enter');
  await expect(page.locator('.message .content').filter({ hasText: content })).toBeVisible();
});
