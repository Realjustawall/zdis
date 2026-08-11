import { getDb } from '../db/index.js';
import { SERVER_PERMISSION_KEYS, normalizeServerPermissions } from './serverRoles.js';

export const CHANNEL_PERMISSION_KEYS = SERVER_PERMISSION_KEYS;
const DEFAULT_CHANNEL_PERMISSIONS = new Set([
  'viewChannel',
  'sendMessages',
  'sendTtsMessages',
  'sendMessagesInThreads',
  'embedLinks',
  'attachFiles',
  'addReactions',
  'readMessageHistory',
  'useApplicationCommands',
  'sendVoiceMessages',
  'sendPolls',
  'connectVoice',
  'speak',
  'useVoiceActivity',
  'requestToSpeak',
  'useEmbeddedActivities',
  'useSoundboard',
]);

function parse(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? normalizeServerPermissions(parsed) : [];
  } catch {
    return [];
  }
}

export function toChannelOverride(row) {
  return {
    channelId: row.channel_id,
    groupId: row.group_id,
    targetType: row.target_type,
    targetId: row.target_id,
    allow: parse(row.allow_permissions),
    deny: parse(row.deny_permissions),
    updatedBy: row.updated_by,
    updatedAt: Number(row.updated_at),
  };
}

export async function listChannelOverrides(groupId, channelId) {
  const rows = await getDb().all(
    `SELECT * FROM channel_permission_overrides
     WHERE group_id = ? AND channel_id = ? ORDER BY target_type, target_id`,
    [groupId, channelId],
  );
  return rows.map(toChannelOverride);
}

export async function listCategoryOverrides(groupId, categoryId) {
  const rows = await getDb().all(
    `SELECT category_id AS channel_id, group_id, target_type, target_id,
       allow_permissions, deny_permissions, updated_by, updated_at
     FROM category_permission_overrides
     WHERE group_id = ? AND category_id = ? ORDER BY target_type, target_id`,
    [groupId, categoryId],
  );
  return rows.map(toChannelOverride);
}

export async function setCategoryOverride({
  groupId,
  categoryId,
  targetType,
  targetId,
  allow,
  deny,
  updatedBy,
}) {
  const normalizedAllow = normalizeServerPermissions(allow);
  const normalizedDeny = normalizeServerPermissions(deny).filter(
    (permission) => !normalizedAllow.includes(permission),
  );
  await getDb().run(
    `INSERT INTO category_permission_overrides
      (category_id, group_id, target_type, target_id, allow_permissions,
       deny_permissions, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (category_id, target_type, target_id)
     DO UPDATE SET allow_permissions = excluded.allow_permissions,
       deny_permissions = excluded.deny_permissions, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [
      categoryId,
      groupId,
      targetType,
      targetId,
      JSON.stringify(normalizedAllow),
      JSON.stringify(normalizedDeny),
      updatedBy,
      Date.now(),
    ],
  );
}

export async function deleteCategoryOverride(categoryId, targetType, targetId) {
  await getDb().run(
    `DELETE FROM category_permission_overrides
     WHERE category_id = ? AND target_type = ? AND target_id = ?`,
    [categoryId, targetType, targetId],
  );
}

export async function setChannelOverride({
  groupId,
  channelId,
  targetType,
  targetId,
  allow,
  deny,
  updatedBy,
}) {
  const normalizedAllow = normalizeServerPermissions(allow);
  const normalizedDeny = normalizeServerPermissions(deny).filter(
    (permission) => !normalizedAllow.includes(permission),
  );
  await getDb().run(
    `INSERT INTO channel_permission_overrides
      (channel_id, group_id, target_type, target_id, allow_permissions, deny_permissions, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, target_type, target_id)
     DO UPDATE SET allow_permissions = excluded.allow_permissions,
       deny_permissions = excluded.deny_permissions, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [
      channelId,
      groupId,
      targetType,
      targetId,
      JSON.stringify(normalizedAllow),
      JSON.stringify(normalizedDeny),
      updatedBy,
      Date.now(),
    ],
  );
  await getDb().run(
    'UPDATE channels SET permissions_synced = 0, updated_at = ? WHERE id = ?',
    [Date.now(), channelId],
  );
}

export async function deleteChannelOverride(channelId, targetType, targetId) {
  await getDb().run(
    'DELETE FROM channel_permission_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?',
    [channelId, targetType, targetId],
  );
  await getDb().run(
    'UPDATE channels SET permissions_synced = 0, updated_at = ? WHERE id = ?',
    [Date.now(), channelId],
  );
}

export async function channelPermission(channel, context, permission) {
  if (context.permissionBypass) return true;
  if (
    permission !== 'viewChannel' &&
    !(await channelPermission(channel, context, 'viewChannel'))
  ) {
    return false;
  }
  if (
    [
      'mentionEveryone',
      'sendTtsMessages',
      'attachFiles',
      'embedLinks',
      'sendVoiceMessages',
      'sendPolls',
      'useApplicationCommands',
      'useExternalApps',
      'useExternalEmojis',
      'useExternalStickers',
    ].includes(permission) &&
    !(
      await channelPermission(
        channel,
        context,
        channel.type === 'forum' ? 'sendMessagesInThreads' : 'sendMessages',
      )
    )
  ) {
    return false;
  }
  if (
    [
      'speak',
      'video',
      'useVoiceActivity',
      'prioritySpeaker',
      'muteMembers',
      'deafenMembers',
      'moveMembers',
      'requestToSpeak',
      'useEmbeddedActivities',
      'useSoundboard',
      'useExternalSounds',
      'setVoiceChannelStatus',
      ...(channel.type === 'voice' || channel.type === 'stage'
        ? ['manageChannels']
        : []),
    ].includes(permission) &&
    !(await channelPermission(channel, context, 'connectVoice'))
  ) {
    return false;
  }
  const hasEveryoneRole = context.serverRoles.some((role) => role.isDefault);
  let allowed =
    context.can(permission) ||
    (!hasEveryoneRole && DEFAULT_CHANNEL_PERMISSIONS.has(permission));
  const overrides =
    channel.category_id && Boolean(channel.permissions_synced)
      ? await listCategoryOverrides(channel.group_id, channel.category_id)
      : await listChannelOverrides(channel.group_id, channel.id);
  const apply = (override) => {
    if (override.deny.includes(permission)) allowed = false;
    if (override.allow.includes(permission)) allowed = true;
  };

  apply(overrides.find((entry) => entry.targetType === 'everyone') ?? { allow: [], deny: [] });

  const roleIds = new Set(
    context.serverRoles.filter((role) => !role.isDefault).map((role) => role.id),
  );
  const roleOverrides = overrides.filter(
    (entry) => entry.targetType === 'role' && roleIds.has(entry.targetId),
  );
  if (roleOverrides.some((entry) => entry.deny.includes(permission))) allowed = false;
  if (roleOverrides.some((entry) => entry.allow.includes(permission))) allowed = true;

  apply(
    overrides.find(
      (entry) => entry.targetType === 'member' && entry.targetId === context.userId,
    ) ?? { allow: [], deny: [] },
  );
  return allowed;
}
