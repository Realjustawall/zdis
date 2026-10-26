import { test, expect } from './test-fixtures';

test('two browser sessions recover missed edits, deletion and presence without refreshing', async ({browser, baseURL}, info) => {
  test.setTimeout(60000);
  const contexts = await Promise.all([0,1].map(() => browser.newContext({baseURL, viewport: info.project.name === 'mobile-chromium' ? {width: 360,height: 780} : {width: 1280,height: 900}})));
  const [owner, member] = contexts;
  for (const context of contexts) await context.addInitScript(() => {
    localStorage.setItem('zdis.locale','en');
    const w=window as any, Native=WebSocket;
    w.qaSockets=[];w.qaReady=0;w.qaMarker=Math.random();
    w.WebSocket=class extends Native {constructor(url:string,protocols?:string|string[]){super(url,protocols);w.qaSockets.push(this);this.addEventListener('message',event=>{if(String(event.data).includes('["ready",'))w.qaReady++;});}};
  });
  const auth=await(await owner.request.post('/api/auth/login',{data:{identifier:'admin',password:'cNL2*8o$1F;"'}})).json(),headers={'x-csrf-token':auth.csrfToken};
  const username='recovery'+Date.now(),password='Recovery-Test#2026';
  let groupId:string|undefined,userId:string|undefined;
  try{
    const added=await owner.request.post('/api/admin/users',{headers,data:{username,email:username+'@example.test',displayName:'Realtime member',role:'member',mustChangePassword:false,password}});expect(added.status()).toBe(201);userId=(await added.json()).user.id;
    const created=await owner.request.post('/api/groups',{headers,data:{name:'Recovery '+Date.now()}});expect(created.status()).toBe(201);const {group,channels}=await created.json();groupId=group.id;const channel=channels.find((c:{type:string})=>c.type==='text');
    expect((await owner.request.post(`/api/groups/${groupId}/members`,{headers,data:{userId}})).status()).toBe(201);
    const memberAuth=await(await member.request.post('/api/auth/login',{data:{identifier:username,password}})).json(),memberHeaders={'x-csrf-token':memberAuth.csrfToken};
    const [a,b]=await Promise.all(contexts.map(c=>c.newPage()));
    for(const page of [a,b]){await page.goto('/');await page.getByTitle(group.name,{exact:true}).click();await page.locator('.channel-nav-row').filter({hasText:channel.name}).locator('button').first().click();}
    await a.getByTitle('Members',{exact:true}).click();
    await member.request.patch('/api/auth/profile',{headers:memberHeaders,data:{presence:'dnd',displayName:'Renamed live'}});
    const row=a.locator('.members .member-row').filter({hasText:'Renamed live'});
    await expect(row).toBeVisible();await expect(row.locator('.status-dot.dnd')).toBeVisible();
    const first=await owner.request.post(`/api/channels/${channel.id}/messages`,{headers,data:{content:'Message to delete during outage'}});expect(first.status()).toBe(201);const firstId=(await first.json()).message.id;
    await expect(b.locator('.message .content').getByText('Message to delete during outage',{exact:true})).toBeVisible();
    await b.locator('.composer textarea').fill('Keep my unsent draft');
    const marker=await b.evaluate(()=>(window as any).qaMarker),ready=await b.evaluate(()=>(window as any).qaReady);
    await member.setOffline(true);
    await b.evaluate(()=>{for(const socket of (window as any).qaSockets as WebSocket[])if(socket.readyState===WebSocket.OPEN)socket.close();});
    expect((await owner.request.delete(`/api/channels/${channel.id}/messages/${firstId}`,{headers})).ok()).toBe(true);
    const missed=await owner.request.post(`/api/channels/${channel.id}/messages`,{headers,data:{content:'Original missed message'}});expect(missed.status()).toBe(201);const missedId=(await missed.json()).message.id;
    expect((await owner.request.patch(`/api/channels/${channel.id}/messages/${missedId}`,{headers,data:{content:'Edited while offline'}})).ok()).toBe(true);
    await owner.request.patch('/api/auth/profile',{headers,data:{presence:'idle'}});
    await member.setOffline(false);
    await expect.poll(()=>b.evaluate(()=>(window as any).qaReady),{timeout:15000}).toBeGreaterThan(ready);
    await expect(b.locator('.message .content').filter({hasText:'Edited while offline'})).toBeVisible();
    await expect(b.locator('.message .content').getByText('Message to delete during outage',{exact:true})).toHaveCount(0);
    await expect(b.locator('.composer textarea')).toHaveValue('Keep my unsent draft');
    expect(await b.evaluate(()=>(window as any).qaMarker)).toBe(marker);
    await b.getByTitle('Members',{exact:true}).click();
    await expect(b.locator('.members .member-row').filter({hasText:'Administrator'}).locator('.status-dot.idle')).toBeVisible();
  }finally{
    await member.setOffline(false);
    for(const context of contexts)for(const page of context.pages())await page.close();
    if(groupId)await owner.request.delete('/api/groups/'+groupId,{headers});
    if(userId)await owner.request.delete('/api/admin/users/'+userId,{headers});
    for(const context of contexts)await context.close();
  }
});
