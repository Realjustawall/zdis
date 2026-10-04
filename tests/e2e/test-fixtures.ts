import { test as base } from '@playwright/test';
export { expect } from '@playwright/test';
export const test = base.extend({
  browser: [async ({ playwright, browserName, headless, launchOptions }, use) => {
    const type = playwright[browserName];
    const server = await type.launchServer({ ...launchOptions, headless });
    const browser = await type.connect(server.wsEndpoint());
    try { await use(browser); }
    finally {
      // Disconnect the remote client before waiting for server-side shutdown.
      await browser.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let graceful = false;
      await Promise.race([
        server.close().then(() => { graceful = true; }),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!graceful) {
        console.warn('Chrome teardown needed forced termination of the test-owned browser.');
        const owned = server.process();
        if (owned.exitCode === null) owned.kill();
        await Promise.race([server.kill(), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
      }
    }
  }, { scope: 'worker' }],
});
