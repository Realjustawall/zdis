import { test, expect } from './test-fixtures';

for (const locale of ['fa', 'en'] as const) {
  test(`phone side pages, back navigation and narrow controls (${locale})`, async ({ page, context }, info) => {
    test.skip(info.project.name !== 'mobile-chromium', 'Phone navigation coverage');
    const fa = locale === 'fa';
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(locale => {
      localStorage.setItem('zdis.locale', locale);
      localStorage.setItem('ZDIS.theme', 'dark');
    }, locale);
    await page.setViewportSize({ width: 320, height: 720 });
    const login = await context.request.post('/api/auth/login', { data: { identifier: 'admin', password: 'cNL2*8o$1F;"' } });
    expect(login.ok()).toBe(true);
    const auth = await login.json();
    const created = await context.request.post('/api/groups', { headers: { 'x-csrf-token': auth.csrfToken }, data: { name: 'Navigation ' + Date.now() + ' ' + 'W'.repeat(36) } });
    expect(created.status(), await created.text()).toBe(201);
    const { group } = await created.json();
    await page.goto('/');
    await page.locator('.mobile-server-rail').getByTitle(group.name, { exact: true }).click();
    const rail = await page.locator('.mobile-server-rail').boundingBox();
    expect(rail!.x).toBe(fa ? 248 : 0);
    await page.locator('.channel-nav-row').filter({ hasText: 'general' }).locator('button').first().click();
    await expect(page.locator('.composer textarea')).toBeVisible();
    await page.locator('.composer textarea').fill('A long mobile draft that must survive opening tools.');

    const sidePage = async () => {
      const dialog = page.locator('.modal').last();
      await expect(dialog).toHaveCSS('animation-name', 'page-from-end');
      const motion = await dialog.evaluate(el => {
        const animation = el.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'page-from-end');
        if (!animation) return null;
        animation.pause();
        animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
        const matrix = new DOMMatrix(getComputedStyle(el).transform);
        animation.finish();
        return { x: matrix.m41, y: matrix.m42 };
      });
      expect(motion).not.toBeNull();
      expect(Math.abs(motion!.x)).toBeGreaterThan(1);
      expect(motion!.y).toBe(0);
      expect(Math.sign(motion!.x)).toBe(fa ? -1 : 1);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeCloseTo(0, 1);
      expect(box.y).toBeCloseTo(0, 1);
      expect(box.width).toBeCloseTo(320, 1);
      expect(box.height).toBeCloseTo(720, 1);
      await expect(dialog).toHaveCSS('border-radius', '0px');
      return dialog;
    };

    await page.locator('.composer-more').click();
    let dialog = await sidePage();
    await dialog.getByRole('button', { name: fa ? 'ارسال قطعه‌کد' : 'Send a code block', exact: true }).click();
    dialog = await sidePage();
    await dialog.getByRole('button', { name: 'JavaScript', exact: true }).click();
    await expect(page.locator('.composer textarea')).toHaveValue(/```javascript/);
    await expect(page.locator('.composer textarea')).toHaveValue(/A long mobile draft/);
    await page.locator('.composer-emoji').click();
    dialog = await sidePage();
    await page.evaluate(() => window.dispatchEvent(new Event('native:back', { cancelable: true })));
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.composer textarea')).toBeVisible();

    // Edge swipes mirror with the document direction; no vertical gesture opens a page.
    await page.locator('.app').evaluate((el, rtl) => {
      const touch = (x: number, y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(rtl ? 318 : 2, 180)] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch(rtl ? 215 : 105, 183)] }));
    }, fa);
    await expect(page.locator('.app')).toHaveClass(/show-sidebar/);
    await page.getByRole('button', { name: fa ? 'حساب کاربری' : 'Your account', exact: true }).click();
    dialog = await sidePage();
    await page.locator('.account-tabs > button').first().click();
    await expect(page.locator('.account-detail')).toBeVisible();
    const badge = await page.locator('.profile-identity .badge.admin').boundingBox();
    expect(badge!.height).toBeLessThan(32);
    await page.evaluate(() => window.dispatchEvent(new Event('native:back', { cancelable: true })));
    await expect(page.locator('.account-tabs')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('native:back', { cancelable: true })));
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
