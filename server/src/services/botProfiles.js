import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { groupContext } from './permissions.js';

async function ensure(tx,groupId,userId) {
  await tx.run('INSERT INTO builtin_bot_profiles(group_id,user_id) VALUES (?,?) ON CONFLICT(group_id,user_id) DO NOTHING',[groupId,userId]);
}
export async function botProfile(groupId,userId) {
  const db=getDb();
  if(!await db.get('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?',[groupId,userId]))throw forbidden('Choose a server member.');
  await ensure(db,groupId,userId);
  const profile=await db.get('SELECT * FROM builtin_bot_profiles WHERE group_id=? AND user_id=?',[groupId,userId]);
  const text=await db.get('SELECT xp FROM builtin_bot_levels WHERE group_id=? AND user_id=?',[groupId,userId]);
  return {...profile,text_xp:Number(text?.xp||0)};
}
export async function profileAction(groupId,actor,body) {
  const ctx=await groupContext(groupId,actor);
  if(!ctx.can('useApplicationCommands'))throw forbidden('Application Commands permission required.');
  const {botSettings}=await import('./builtinBots.js');
  if(!(await botSettings(groupId)).settings.moderator.enabled)throw forbidden('Moderator is disabled.');
  const target=body.userId||actor.id;
  if(!await getDb().get('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?',[groupId,target]))throw forbidden('Choose a server member.');
  const amount=body.amount;
  await getDb().tx(async tx=>{
    // Serialize both balances in a consistent order on PostgreSQL as well.
    for(const id of [...new Set([actor.id,target])].sort()){
      await ensure(tx,groupId,id);
      if(getDb().dialect==='postgres')await tx.get('SELECT user_id FROM builtin_bot_profiles WHERE group_id=? AND user_id=? FOR UPDATE',[groupId,id]);
    }
    const now=Date.now();
    if(body.action==='daily'){
      const row=await tx.get('SELECT last_daily_at FROM builtin_bot_profiles WHERE group_id=? AND user_id=?',[groupId,actor.id]);
      if(now-Number(row.last_daily_at)<86400000)throw badRequest('Daily reward is available once per 24 hours.');
      await tx.run('UPDATE builtin_bot_profiles SET credits=credits+100,last_daily_at=? WHERE group_id=? AND user_id=?',[now,groupId,actor.id]);
    }else if(body.action==='transfer'){
      if(target===actor.id||!Number.isInteger(amount)||amount<1||amount>1000000)throw badRequest('Choose another member and a valid positive amount.');
      const row=await tx.get('SELECT credits FROM builtin_bot_profiles WHERE group_id=? AND user_id=?',[groupId,actor.id]);
      if(Number(row.credits)<amount)throw badRequest('Insufficient credits.');
      await tx.run('UPDATE builtin_bot_profiles SET credits=credits-? WHERE group_id=? AND user_id=?',[amount,groupId,actor.id]);
      await tx.run('UPDATE builtin_bot_profiles SET credits=credits+? WHERE group_id=? AND user_id=?',[amount,groupId,target]);
      await tx.run('INSERT INTO builtin_bot_transfers(id,group_id,sender_id,recipient_id,amount,created_at) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),groupId,actor.id,target,amount,now]);
    }else if(body.action==='rep'){
      if(target===actor.id)throw badRequest('You cannot give yourself reputation.');
      const row=await tx.get('SELECT last_rep_at FROM builtin_bot_profiles WHERE group_id=? AND user_id=?',[groupId,actor.id]);
      if(now-Number(row.last_rep_at)<86400000)throw badRequest('Reputation can be given once per 24 hours.');
      await tx.run('UPDATE builtin_bot_profiles SET last_rep_at=? WHERE group_id=? AND user_id=?',[now,groupId,actor.id]);
      await tx.run('UPDATE builtin_bot_profiles SET reputation=reputation+1 WHERE group_id=? AND user_id=?',[groupId,target]);
    }else if(body.action==='title'){
      await tx.run('UPDATE builtin_bot_profiles SET title=? WHERE group_id=? AND user_id=?',[String(body.title||'').slice(0,100),groupId,actor.id]);
    }else throw badRequest('Unknown profile action.');
  });
  return botProfile(groupId,actor.id);
}

export async function awardVoiceXp(groupId,userId,xp) {
  const db=getDb(),now=Date.now();
  return db.tx(async tx=>{
   await ensure(tx,groupId,userId);
   const result=await tx.run('UPDATE builtin_bot_profiles SET voice_xp=voice_xp+?,last_voice_at=? WHERE group_id=? AND user_id=? AND last_voice_at<=?',[xp,now,groupId,userId,now-60000]);
   if(result.changes&&xp>0)await tx.run("INSERT INTO builtin_bot_xp_events(id,group_id,user_id,kind,xp,created_at) VALUES (?,?,?,'voice',?,?)",[crypto.randomUUID(),groupId,userId,xp,now]);
   return {...await tx.get('SELECT voice_xp FROM builtin_bot_profiles WHERE group_id=? AND user_id=?',[groupId,userId]),awarded:result.changes>0};
  });
}
