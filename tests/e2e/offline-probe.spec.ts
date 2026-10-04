import { test, expect } from './test-fixtures';
test('offline app shell remains bootable with its service worker cache', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('input[type="password"]')).toBeVisible();
  const worker = await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Service worker readiness timeout')), 15000)),
    ]);
    return Boolean(registration.active);
  });
  expect(worker).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-booted', 'true');
  await expect(page.locator('.fatal-error-screen')).toHaveCount(0);
  await context.setOffline(false);
});
