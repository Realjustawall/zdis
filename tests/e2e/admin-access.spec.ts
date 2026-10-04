import {test,expect} from './test-fixtures';
test('Admin saves account media permissions and quotas and manages a custom badge',async({page,context},info)=>{
 await context.addInitScript(()=>localStorage.setItem('zdis.locale','en'));
 const login=await context.request.post('/api/auth/login',{data:{identifier:'admin',password:'cNL2*8o$1F;"'}});expect(login.ok()).toBeTruthy();const auth=await login.json(),headers={'x-csrf-token':auth.csrfToken};
 const username='uiaccess'+Date.now();const created=await context.request.post('/api/admin/users',{headers,data:{username,email:username+'@example.test',displayName:'UI Access',password:'UIAccess!7283920',role:'member',mustChangePassword:false}});expect(created.status()).toBe(201);const {user}=await created.json();let badgeId:string|undefined;
 try{
  await page.goto('/');
  if(info.project.name==='mobile-chromium'){await page.getByRole('button',{name:'Servers',exact:true}).click();await page.getByRole('button',{name:'Admin',exact:true}).click();}
  else await page.getByTitle('Administration',{exact:true}).click();
  await page.getByRole('button',{name:'تنظیمات',exact:true}).click();
  const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'دسترسی افراد، سقف‌ها و بج‌های اختصاصی',exact:true})});
  const account=panel.locator('fieldset').filter({has:page.locator('legend',{hasText:'استثنا برای هر فرد'})});
  await account.getByRole('combobox',{name:'حساب',exact:true}).selectOption(user.id);
  await account.getByRole('combobox',{name:'ارسال عکس',exact:true}).selectOption('false');
  await account.getByRole('spinbutton',{name:/سقف گروه‌های ساخته‌شده/}).fill('2');
  const saved=page.waitForResponse(r=>r.url().endsWith(`/api/admin/users/${user.id}/access`)&&r.request().method()==='PUT');await account.getByRole('button',{name:'ذخیره دسترسی فرد',exact:true}).click();expect((await saved).status()).toBe(200);
  const policy=await context.request.get(`/api/admin/users/${user.id}/access`);expect((await policy.json()).effective).toMatchObject({sendImages:false,maxOwnedGroups:2});
  const badge=panel.locator('fieldset').filter({has:page.locator('legend',{hasText:'بج اختصاصی'})});await badge.getByRole('textbox',{name:'عنوان بج',exact:true}).fill('Browser VIP');
  const added=page.waitForResponse(r=>r.url().endsWith('/api/admin/badges')&&r.request().method()==='POST');await badge.getByRole('button',{name:'افزودن بج',exact:true}).click();const response=await added;expect(response.status()).toBe(201);badgeId=(await response.json()).badge.id;
  await expect(badge.getByText('Browser VIP',{exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('admin-access.png'),fullPage:true});
  const deleted=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/'+badgeId));await badge.getByRole('button',{name:'حذف بج از همهٔ افراد',exact:true}).click();expect((await deleted).status()).toBe(200);badgeId=undefined;
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 }finally{if(badgeId)await context.request.delete('/api/admin/badges/'+badgeId,{headers});await context.request.delete('/api/admin/users/'+user.id,{headers});}
});
