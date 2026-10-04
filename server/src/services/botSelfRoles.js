import { getDb } from '../db/index.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { groupContext } from './permissions.js';
import { botSettings, grantAutomationRole } from './builtinBots.js';
import { safeSelfRole } from './botRules.js';
import { invalidateGroup } from './groups.js';
import { emitToGroup, refreshUserRooms } from '../realtime/index.js';
import { audit } from './audit.js';

export async function listBotSelfRoles(groupId,user){
 const ctx=await groupContext(groupId,user),{settings}=await botSettings(groupId);
 if(!settings.moderator.enabled||!ctx.can('useApplicationCommands'))return [];
 const roles=await getDb().all('SELECT r.*,m.user_id AS assigned_user FROM server_roles r LEFT JOIN server_member_roles m ON m.role_id=r.id AND m.group_id=r.group_id AND m.user_id=? WHERE r.group_id=? ORDER BY r.position DESC',[user.id,groupId]);
 return roles.filter(role=>settings.moderator.selfRoleIds.includes(role.id)&&safeSelfRole(role))
  .map(role=>({id:role.id,name:role.name,color:role.color,assigned:Boolean(role.assigned_user)}));
}
export async function selectBotSelfRole(groupId,user,roleId,remove=false){
 const ctx=await groupContext(groupId,user),{settings}=await botSettings(groupId),db=getDb();
 if(!ctx.can('useApplicationCommands'))throw forbidden('Application Commands permission is required.');
 if(!settings.moderator.enabled||!settings.moderator.selfRoleIds.includes(roleId))throw badRequest('This role is not available for self-selection.');
 const role=await db.get('SELECT * FROM server_roles WHERE id=? AND group_id=?',[roleId,groupId]);
 if(!role||!safeSelfRole(role))throw forbidden('Privileged roles cannot be self-selected.');
 if(remove)await db.run('DELETE FROM server_member_roles WHERE group_id=? AND user_id=? AND role_id=?',[groupId,user.id,roleId]);
 else if(!await grantAutomationRole(groupId,user.id,roleId,'moderator',true))throw forbidden('The configured automation no longer has permission to assign this role.');
 await invalidateGroup(groupId);await refreshUserRooms(user.id);
 emitToGroup(groupId,'group:member-updated',{groupId,userId:user.id});
 await audit({actorId:user.id,action:remove?'bot.self_role_removed':'bot.self_role_selected',targetType:'server_role',targetId:roleId,meta:{groupId}});
 return listBotSelfRoles(groupId,user);
}
