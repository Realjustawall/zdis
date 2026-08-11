import { expect, test } from '@playwright/test';

test('boots when Safari restricts storage and only exposes legacy media listeners', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage is disabled', 'SecurityError');
      },
    });

    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const media = nativeMatchMedia(query);
      return new Proxy(media, {
        get(target, property) {
          if (property === 'addEventListener') return undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
  });

  await page.goto('/');
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-app-booted', 'true');
  await expect(page.locator('.fatal-error-screen')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
