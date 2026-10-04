import { forbidden } from '../lib/errors.js';
import {getDb} from '../db/index.js';
import {groupContext} from './permissions.js';

// Run inside the membership transaction so concurrent joins share one limit.
export async function checkBotJoin(tx, groupId, userId) {
  const row = await tx.get('SELECT settings FROM builtin_bot_settings WHERE group_id=?', [groupId]);
  const m = row ? JSON.parse(row.settings).moderator : null;
  if (!m?.enabled || !m.antiRaidEnabled) return;
  const now = Date.now();
  const user = await tx.get('SELECT created_at FROM users WHERE id=?', [userId]);
  if (now - Number(user.created_at) < (m.minAccountAgeHours ?? 0) * 3600000) throw forbidden('This server requires an older account.');
  const joins = await tx.get("SELECT COUNT(*) AS n FROM group_members m WHERE group_id=? AND joined_at>? AND role<>'owner' AND NOT EXISTS (SELECT 1 FROM builtin_bot_accounts b WHERE b.user_id=m.user_id)", [groupId, now - (m.joinWindowSeconds ?? 60) * 1000]);
  if (Number(joins.n) >= (m.maxJoinsPerWindow ?? 10)) throw forbidden('Anti-raid protection temporarily limits new joins.');
}

export async function guardBotAction(groupId,actor,targetIds=[]){
 const db=getDb(),row=await db.get('SELECT settings FROM builtin_bot_settings WHERE group_id=?',[groupId]);
 const m=row?JSON.parse(row.settings).moderator:null;
 if(!m?.enabled||!m.protectionEnabled)return;
 const ctx=await groupContext(groupId,actor);
 if(ctx.role==='owner'||ctx.isPlatformAdmin||(m.protectionWhitelistIds||[]).includes(actor.id))return;
 for(const userId of targetIds){
  if((m.protectedUserIds||[]).includes(userId))throw forbidden('This member is protected by server protection.');
  const roles=await db.all('SELECT role_id FROM server_member_roles WHERE group_id=? AND user_id=?',[groupId,userId]);
  if(roles.some(r=>(m.protectedRoleIds||[]).includes(r.role_id)))throw forbidden('This member has a protected role.');
 }
 await db.tx(async tx=>{
  await tx.run('INSERT INTO builtin_bot_action_windows(group_id,actor_id,window_start,action_count) VALUES (?,?,?,0) ON CONFLICT(group_id,actor_id) DO NOTHING',[groupId,actor.id,Date.now()]);
  if(db.dialect==='postgres')await tx.get('SELECT actor_id FROM builtin_bot_action_windows WHERE group_id=? AND actor_id=? FOR UPDATE',[groupId,actor.id]);
  const row=await tx.get('SELECT * FROM builtin_bot_action_windows WHERE group_id=? AND actor_id=?',[groupId,actor.id]);
  const now=Date.now(),reset=now-Number(row.window_start)>=(m.protectionWindowSeconds??60)*1000;
  if(!reset&&Number(row.action_count)>=(m.maxActionsPerWindow??5))throw forbidden('Server protection blocked excessive administrative actions.');
  await tx.run('UPDATE builtin_bot_action_windows SET window_start=?,action_count=? WHERE group_id=? AND actor_id=?',[reset?now:row.window_start,reset?1:Number(row.action_count)+1,groupId,actor.id]);
 });
}
