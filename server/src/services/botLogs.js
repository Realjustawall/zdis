import {getDb} from '../db/index.js';
import {botSettings,botPost} from './builtinBots.js';

export async function logBotAudit({actorId,action,targetType,targetId,meta}){
 if(action.startsWith('bot.'))return;
 let groupId=meta?.groupId||(targetType==='group'?targetId:null);
 if(!groupId&&targetType==='channel')groupId=(await getDb().get('SELECT group_id FROM channels WHERE id=?',[targetId]))?.group_id;
 if(!groupId&&targetType==='message')groupId=(await getDb().get('SELECT c.group_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=?',[targetId]))?.group_id;
 if(!groupId)return;
 const {settings}=await botSettings(groupId),m=settings.moderator;
 if(!m.enabled||!m.logsEnabled||!m.logChannelId)return;
 // Never put private message bodies, IPs or credentials in a group log.
 await botPost(groupId,m.logChannelId,`**${action}**\nActor: ${actorId||'System'}\nTarget: ${targetType||'server'} ${targetId||''}`);
}
