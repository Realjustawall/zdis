import { getDb } from '../db/index.js';
import { groupContext } from './permissions.js';
import { channelPermission } from './channelPermissions.js';
import { forbidden } from '../lib/errors.js';
import { createMessage } from './messages.js';
import { botSettings, ensureBuiltinBots } from './builtinBots.js';
import { emitToChannel } from '../realtime/index.js';

export async function sendBotEmbed(groupId,actor,channelId,embed) {
 const ctx=await groupContext(groupId,actor),channel=await getDb().get('SELECT * FROM channels WHERE id=? AND group_id=?',[channelId,groupId]);
 if(!ctx.can('manageGroup')||!channel||!['text','announcement'].includes(channel.type)||!await channelPermission(channel,ctx,'sendMessages')||!await channelPermission(channel,ctx,'embedLinks'))throw forbidden('Manage Server and channel message/embed permissions required.');
 if(!(await botSettings(groupId)).settings.moderator.enabled)throw forbidden('Moderator is disabled.');
 const message=await createMessage({channelId,authorId:(await ensureBuiltinBots()).moderator,content:embed.title||embed.description||'Embed',botEmbed:embed});
 emitToChannel(channelId,'message:created',{message});return message;
}
