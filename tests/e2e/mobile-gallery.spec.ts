import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './test-fixtures';

test('capture every mobile workspace and settings section in Persian', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'mobile-chromium', 'Gallery requires phone layout');
  test.setTimeout(180000);
  const phase = process.env.GALLERY_PHASE || 'after';
  const folder = `docs/assets/screenshots/mobile-${phase}`;
  await fs.mkdir(folder, { recursive: true });
  type LayoutCheck = {width: number; direction: string; issues: string[]};
  const audit: Array<{name: string; file: string; text: string[]; attributes: string[]; layoutChecks: LayoutCheck[]}> = [];
  const shot = async (name: string) => {
    await page.locator('.spinner').last().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    await page.evaluate(() => { for (const animation of document.getAnimations()) { if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish(); } });
    const file = `${String(audit.length + 1).padStart(2,'0')}-${name}.png`;
    const layoutChecks: LayoutCheck[] = [];
    const originalViewport = page.viewportSize()!;
    if (process.env.GALLERY_LAYOUT_AUDIT === '1') {
      for (const width of [320, 360, 412, 768]) {
        await page.setViewportSize({ width, height: 850 });
        for (const direction of ['rtl', 'ltr']) {
          await page.locator('html').evaluate((el, dir) => el.setAttribute('dir', dir), direction);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const issues = await page.evaluate(() => {
            const found: string[] = [];
            const topModal = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).at(-1);
            const scope = topModal ?? document.body;
            for (const el of scope.querySelectorAll<HTMLElement>('*')) {
              if (!(el instanceof HTMLElement) || !el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) || el.closest('script,style')) continue;
              const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
              if (!rect.width || !rect.height) continue;
              // Scrollable tables, token strips and ellipsized labels intentionally
              // contain wider children. Check their viewport, not offscreen content.
              let clipped = false;
              for (let parent = el.parentElement; parent && parent !== scope; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (['auto','scroll','hidden','clip'].includes(style.overflowX)) { clipped = true; break; }
              }
              const control = el.matches('button,input:not([type="hidden"]),select,textarea,a[href]');
              const intentionalScroll = Boolean(el.closest('.table-wrap, .pending-attachments, pre'));
              if (control && !intentionalScroll) {
                if (rect.left < -2 || rect.right > innerWidth + 2) found.push(`control ${el.tagName}.${el.className}: ${Math.round(rect.left)}..${Math.round(rect.right)} viewport ${innerWidth}`);
                for (let parent = el.parentElement; parent && parent !== scope; parent = parent.parentElement) {
                  const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
                  if (['hidden','clip'].includes(style.overflowX) && (rect.left < box.left - 2 || rect.right > box.right + 2)) found.push(`clipped control ${el.tagName}.${el.className} inside ${parent.className}`);
                }
                if (css.overflowY === 'hidden' && el.tagName === 'BUTTON' && el.scrollHeight > el.clientHeight + 4) found.push(`clipped button text ${el.className}: ${el.scrollHeight} > ${el.clientHeight}`);
              }
              if (!clipped && (rect.left < -2 || rect.right > innerWidth + 2)) found.push(`${el.tagName}.${el.className}: ${Math.round(rect.left)}..${Math.round(rect.right)} viewport ${innerWidth}`);
              if (css.overflowX === 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 3 && !el.matches('.table-wrap, .message .content, .code-block, pre')) found.push(`content ${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
            }
            return [...new Set(found)];
          });
          layoutChecks.push({width, direction, issues});
        }
      }
      await page.locator('html').evaluate(el => el.setAttribute('dir', 'rtl'));
      await page.setViewportSize(originalViewport);
    }
    await page.screenshot({ path: path.join(folder, file), animations: 'disabled' });
    const strings = await page.evaluate(() => {
      const text: string[] = [], attributes: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || !parent.checkVisibility() || !parent.getClientRects().length || parent.closest('script,style,pre,code,.message .content,[data-no-auto-translate]')) continue;
        const value = node.textContent?.trim() || '';
        if (/[a-zA-Z]{2}/.test(value)) text.push(value);
      }
      for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
        if (!(el as HTMLElement).checkVisibility() || el.closest('[data-no-auto-translate],pre,code')) continue;
        for (const key of ['title','placeholder','aria-label']) {
          const value = el.getAttribute(key) || '';
          if (/[a-zA-Z]{2}/.test(value)) attributes.push(value);
        }
      }
      return { text: [...new Set(text)], attributes: [...new Set(attributes)] };
    });
    audit.push({ name, file, ...strings, layoutChecks });
    await fs.writeFile(path.join(folder,'audit.json'),JSON.stringify(audit,null,2));
    console.log('CAPTURE', name);
  };
  await page.addInitScript(() => { localStorage.setItem('zdis.locale','fa'); localStorage.setItem('ZDIS.theme','dark'); });
  if (process.env.GALLERY_LAYOUT_AUDIT === '1') await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await shot('login');
  const login = await context.request.post('/api/auth/login', { data: { identifier:'admin', password:'cNL2*8o$1F;"' } });
  const auth = await login.json(), headers = { 'x-csrf-token': auth.csrfToken };
  const created = await context.request.post('/api/groups', { headers, data: { name:'گروه دوستان زی‌دیس', description:'گفتگو، همکاری و اشتراک تجربه‌ها' } });
  expect(created.status()).toBe(201);
  const groupData = await created.json();
  const textChannel = groupData.channels.find((channel: {type:string})=>channel.type==='text');
  await context.request.patch(`/api/groups/${groupData.group.id}/channels/${textChannel.id}`, { headers, data: { name:'گفتگوی-عمومی' } });
  await context.request.post(`/api/channels/${textChannel.id}/messages`, { headers, data: { content:'سلام! به گروه خوش آمدید 👋' } });
  await page.reload();
  await expect(page.locator('.mobile-server-rail')).toBeVisible();
  await shot('home');
  await page.locator('.home-friends-link').click(); await shot('friends');
  if(phase==='before') await page.goto('/'); else await page.getByRole('button',{name:'پیام‌ها',exact:true}).click();
  await page.locator('.sidebar .nav-item').filter({hasText:'فهرست اعضا'}).click(); await shot('directory');
  if(phase==='before') await page.goto('/'); else await page.getByRole('button',{name:'پیام‌ها',exact:true}).click();
  await page.locator('.sidebar .nav-item').filter({hasText:'شبکه ارتباطی'}).click(); await shot('network');
  if(phase==='before') await page.goto('/'); else await page.getByRole('button',{name:'پیام‌ها',exact:true}).click();
  await page.getByRole('button',{name:'اعلان‌ها',exact:true}).click(); await shot('notifications');
  await page.locator('.modal-head .close').last().click();
  await page.getByRole('button',{name:'حساب کاربری',exact:true}).click(); await shot('account-menu');
  for (let i=0;i<5;i++) { await page.locator('.account-tabs > button').nth(i).click(); await shot(['profile','security','audio','notification-preferences','sessions'][i]); await page.locator('.account-detail .mobile-settings-back').click(); }
  await page.getByTitle('شخصی‌سازی ظاهر',{exact:true}).click(); await shot('appearance');
  await page.locator('.modal-head .close').last().click();
  await page.locator('.modal-head .close').last().click();
  await page.locator('.mobile-server-rail').getByTitle('گروه دوستان زی‌دیس',{exact:true}).click(); await shot('channels');
  await page.locator('.channel-nav-row').filter({hasText:'Voice Lounge'}).locator('button').first().click(); await shot('voice-lobby');
  await page.getByTitle('صدا و میکروفن',{exact:true}).click(); await shot('voice-audio'); await page.locator('.modal-head .close').last().click();
  await page.getByTitle('گزینه‌های تماس',{exact:true}).click(); await shot('voice-options'); await page.locator('.modal-head .close').last().click();
  await page.evaluate(() => window.dispatchEvent(new Event('native:back', {cancelable:true})));

  await page.locator('.group-menu-trigger').click();
  await page.locator('#group-quick-menu').getByRole('button',{name:'ساخت کانال',exact:true}).click(); await shot('create-channel'); await page.locator('.modal-head .close').last().click();
  await page.locator('.channel-nav-row').filter({hasText:'گفتگوی-عمومی'}).locator('.channel-manage-btn').click(); await shot('channel-settings'); await page.locator('.modal-head .close').last().click();
  await page.locator('.channel-nav-row').filter({hasText:'گفتگوی-عمومی'}).locator('button').first().click();
  await page.locator('.composer textarea').fill('سلام! این نسخهٔ جدید زی‌دیس است.'); await expect(page.locator('.composer-btn.send')).toHaveCSS('background-color','rgb(37, 99, 235)'); await shot('chat');
  expect(await page.locator('.composer-btn.send').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(37, 99, 235)');
  await page.locator('.main-head').getByTitle('بازگشت',{exact:true}).click();
  await page.getByRole('button',{name:'حساب کاربری',exact:true}).click();
  await page.getByRole('group',{name:'پوسته',exact:true}).getByRole('button',{name:'روشن',exact:true}).click();
  await page.locator('.modal-head .close').last().click();
  await page.locator('.channel-nav-row').filter({hasText:'گفتگوی-عمومی'}).locator('button').first().click(); await shot('chat-light');
  await page.locator('.main-head').getByTitle('بازگشت',{exact:true}).click();
  await page.getByRole('button',{name:'حساب کاربری',exact:true}).click();
  await page.getByRole('group',{name:'پوسته',exact:true}).getByRole('button',{name:'تیره',exact:true}).click();
  await page.locator('.modal-head .close').last().click();
  await page.locator('.channel-nav-row').filter({hasText:'گفتگوی-عمومی'}).locator('button').first().click();
  await page.locator('.composer-emoji').click(); await shot('emoji'); await page.locator('.mobile-popover-modal .modal-head .close').click();
  await page.locator('.composer-more').click(); await shot('message-tools');
  await page.locator('.message-tools-modal').getByRole('button',{name:'ارسال قطعه‌کد',exact:true}).click(); await shot('code-tool');
  await page.locator('.mobile-popover-modal .modal-head .close').click();
  await page.locator('.composer-more').click();
  await page.locator('.message-tools-modal').getByRole('button',{name:'ساخت نظرسنجی',exact:true}).click(); await shot('poll-tool');
  await page.locator('.mobile-popover-modal .modal-head .close').click();
  await page.locator('.composer-more').click();
  await page.locator('.message-tools-modal').getByRole('button',{name:'استیکرها',exact:true}).click(); await shot('sticker-tool');
  await page.locator('.mobile-popover-modal .modal-head .close').click();
  await page.getByTitle('اعضا',{exact:true}).click(); await shot('members'); await page.locator('.mobile-members-close').click();
  await page.locator('.main-head').getByTitle('بازگشت',{exact:true}).click();
  await page.locator('.group-menu-trigger').click(); await shot('server-menu');
  await page.locator('#group-quick-menu').getByRole('button',{name:'تنظیمات گروه',exact:true}).click();
  await shot('server-settings-menu');
  const sectionNames=['overview','roles','onboarding','members','invites','channels','expressions','apps','bots','community','safety','insights','danger'];
  for(let i=0;i<await page.locator('.server-settings-nav > button').count();i++) {
    await page.locator('.server-settings-nav > button').nth(i).click();
    await shot('server-'+sectionNames[i]);
    if(sectionNames[i]==='bots') {
      const botNames=['welcome','moderation','actions','levels','embeds','tickets'];
      for(let j=1;j<await page.locator('.bot-tabs > button').count();j++) {
        await page.locator('.bot-tabs > button').nth(j).click(); await shot('bot-'+botNames[j]);
      }
    }
    if (i < sectionNames.length - 1) await page.locator('.server-settings-content > .mobile-settings-back').click();
  }
  await page.locator('.modal-head .close').last().click();
  await page.locator('.mobile-server-rail').getByTitle('مدیریت',{exact:true}).click();
  await shot('admin-menu');
  const adminNames=['overview','users','groups','moderation','integrations','operations','platform','settings','audit'];
  for(let i=0;i<adminNames.length;i++) {
    await page.locator('.admin-nav > button:not(.back)').nth(i).click(); await shot('admin-'+adminNames[i]);
    if(adminNames[i]==='users') {
      await page.getByRole('button',{name:/ساخت حساب جدید/}).click(); await shot('admin-create-user'); await page.locator('.modal-head .close').last().click();
      await page.getByRole('button',{name:'ویرایش',exact:true}).first().click(); await shot('admin-edit-user'); await page.locator('.modal-head .close').last().click();
    }
    await page.locator('.admin-mobile-back').click();
  }
  await fs.writeFile(path.join(folder,'audit.json'),JSON.stringify(audit,null,2));
  if (process.env.GALLERY_LAYOUT_AUDIT === '1') expect(audit.flatMap((screen) => screen.layoutChecks.flatMap((check) => check.issues.map((issue: string) => `${screen.name} ${check.width}/${check.direction}: ${issue}`)))).toEqual([]);
});
