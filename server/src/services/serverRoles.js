import { getDb } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/** One-to-one equivalents of Discord's current public permission flags. */
export const DISCORD_PERMISSION_KEYS = [
  'createInvite',
  'kickMember',
  'banMembers',
  'administrator',
  'manageChannels',
  'manageGroup',
  'addReactions',
  'viewAuditLog',
  'prioritySpeaker',
  'video',
  'viewChannel',
  'sendMessages',
  'sendTtsMessages',
  'deleteAnyMessage',
  'embedLinks',
  'attachFiles',
  'readMessageHistory',
  'mentionEveryone',
  'useExternalEmojis',
  'viewServerInsights',
  'connectVoice',
  'speak',
  'muteMembers',
  'deafenMembers',
  'moveMembers',
  'useVoiceActivity',
  'changeNickname',
  'manageNicknames',
  'manageRoles',
  'manageWebhooks',
  'manageExpressions',
  'useApplicationCommands',
  'requestToSpeak',
  'manageEvents',
  'manageThreads',
  'createPublicThreads',
  'createPrivateThreads',
  'useExternalStickers',
  'sendMessagesInThreads',
  'useEmbeddedActivities',
  'moderateMembers',
  'viewCreatorMonetizationAnalytics',
  'useSoundboard',
  'createExpressions',
  'createEvents',
  'useExternalSounds',
  'sendVoiceMessages',
  'setVoiceChannelStatus',
  'sendPolls',
  'useExternalApps',
  'pinMessage',
  'bypassSlowmode',
];

/** Product-specific abilities that are intentionally outside Discord's API. */
export const PLATFORM_PERMISSION_KEYS = ['manageMembers'];

export const SERVER_PERMISSION_KEYS = [
  ...DISCORD_PERMISSION_KEYS,
  ...PLATFORM_PERMISSION_KEYS,
];

const permissionSet = new Set(SERVER_PERMISSION_KEYS);

export const DEFAULT_EVERYONE_PERMISSIONS = [
  'viewChannel',
  'sendMessages',
  'sendTtsMessages',
  'sendMessagesInThreads',
  'createPublicThreads',
  'embedLinks',
  'attachFiles',
  'addReactions',
  'readMessageHistory',
  'useApplicationCommands',
  'sendVoiceMessages',
  'sendPolls',
  'connectVoice',
  'speak',
  'video',
  'useVoiceActivity',
  'requestToSpeak',
  'useEmbeddedActivities',
  'useSoundboard',
];

export function normalizeServerPermissions(values = []) {
  return [...new Set(Array.isArray(values) ? values : [])].filter((value) =>
    permissionSet.has(value),
  );
}

function parsePermissions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? normalizeServerPermissions(parsed) : [];
  } catch {
    return [];
  }
}

export function toServerRole(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    color: row.color ?? null,
    unicodeEmoji: row.unicode_emoji ?? null,
    iconAttachmentId: row.icon_attachment_id ?? null,
    iconUrl: row.icon_attachment_id ? `/api/files/${row.icon_attachment_id}` : null,
    secondaryColor: row.secondary_color ?? null,
    tertiaryColor: row.tertiary_color ?? null,
    position: Number(row.position ?? 0),
    permissions: parsePermissions(row.permissions),
    isDefault: Boolean(row.is_default),
    hoist: Boolean(row.hoist),
    mentionable: Boolean(row.mentionable),
    inPrompt: Boolean(row.in_prompt),
    managed: Boolean(row.managed),
    managedBy: row.managed_by ?? null,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listServerRoles(groupId) {
  const rows = await getDb().all(
    'SELECT * FROM server_roles WHERE group_id = ? ORDER BY position DESC, created_at ASC',
    [groupId],
  );
  return rows.map(toServerRole);
}

export async function getServerRole(groupId, roleId) {
  const row = await getDb().get('SELECT * FROM server_roles WHERE id = ? AND group_id = ?', [
    roleId,
    groupId,
  ]);
  if (!row) throw notFound('Server role not found.');
  return toServerRole(row);
}

export async function createServerRole({
  groupId,
  name,
  color = null,
  unicodeEmoji = null,
  iconAttachmentId = null,
  secondaryColor = null,
  tertiaryColor = null,
  permissions = [],
  hoist = false,
  mentionable = false,
  inPrompt = false,
  createdBy,
  maxPosition = Number.MAX_SAFE_INTEGER,
}) {
  const db = getDb();
  const duplicate = await db.get(
    'SELECT 1 AS ok FROM server_roles WHERE group_id = ? AND LOWER(name) = LOWER(?)',
    [groupId, name],
  );
  if (duplicate) throw conflict('A role with that name already exists in this server.');
  const row = await db.get(
    'SELECT COALESCE(MAX(position), 0) AS position FROM server_roles WHERE group_id = ?',
    [groupId],
  );
  const position = Math.max(1, Math.min(Number(row?.position ?? 0) + 1, maxPosition - 1));
  if (position >= maxPosition) throw badRequest('Your highest role is not high enough to create another role.');
  const id = newId();
  const now = Date.now();
  await db.run(
    `INSERT INTO server_roles
      (id, group_id, name, color, unicode_emoji, icon_attachment_id, secondary_color,
       tertiary_color, position, permissions, is_default, hoist, mentionable, in_prompt,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      groupId,
      name,
      color,
      unicodeEmoji,
      iconAttachmentId,
      secondaryColor,
      tertiaryColor,
      position,
      JSON.stringify(normalizeServerPermissions(permissions)),
      hoist,
      mentionable,
      inPrompt,
      createdBy,
      now,
      now,
    ],
  );
  return getServerRole(groupId, id);
}

export async function updateServerRole(groupId, roleId, patch) {
  const role = await getServerRole(groupId, roleId);
  if (role.managed) throw badRequest('Integration-managed roles cannot be edited manually.');
  const name = role.isDefault ? '@everyone' : patch.name ?? role.name;
  if (name.toLowerCase() !== role.name.toLowerCase()) {
    const duplicate = await getDb().get(
      'SELECT 1 AS ok FROM server_roles WHERE group_id = ? AND id <> ? AND LOWER(name) = LOWER(?)',
      [groupId, roleId, name],
    );
    if (duplicate) throw conflict('A role with that name already exists in this server.');
  }
  await getDb().run(
    `UPDATE server_roles
     SET name = ?, color = ?, unicode_emoji = ?, icon_attachment_id = ?,
       secondary_color = ?, tertiary_color = ?, position = ?, permissions = ?,
       hoist = ?, mentionable = ?, in_prompt = ?,
       updated_at = ?
     WHERE id = ? AND group_id = ?`,
    [
      name,
      role.isDefault ? null : patch.color === undefined ? role.color : patch.color,
      role.isDefault
        ? null
        : patch.unicodeEmoji === undefined
          ? role.unicodeEmoji
          : patch.unicodeEmoji,
      role.isDefault
        ? null
        : patch.iconAttachmentId === undefined
          ? role.iconAttachmentId
          : patch.iconAttachmentId,
      role.isDefault
        ? null
        : patch.secondaryColor === undefined
          ? role.secondaryColor
          : patch.secondaryColor,
      role.isDefault
        ? null
        : patch.tertiaryColor === undefined
          ? role.tertiaryColor
          : patch.tertiaryColor,
      role.isDefault ? 0 : patch.position ?? role.position,
      JSON.stringify(patch.permissions === undefined ? role.permissions : normalizeServerPermissions(patch.permissions)),
      role.isDefault ? false : patch.hoist ?? role.hoist,
      role.isDefault ? false : patch.mentionable ?? role.mentionable,
      role.isDefault ? false : patch.inPrompt ?? role.inPrompt,
      Date.now(),
      roleId,
      groupId,
    ],
  );
  return getServerRole(groupId, roleId);
}

export async function deleteServerRole(groupId, roleId) {
  const role = await getServerRole(groupId, roleId);
  if (role.isDefault) throw badRequest('The @everyone role cannot be deleted.');
  if (role.managed) throw badRequest('Remove the integration that manages this role instead.');
  await getDb().tx(async (tx) => {
    await tx.run(
      "DELETE FROM channel_permission_overrides WHERE group_id = ? AND target_type = 'role' AND target_id = ?",
      [groupId, roleId],
    );
    await tx.run(
      "DELETE FROM category_permission_overrides WHERE group_id = ? AND target_type = 'role' AND target_id = ?",
      [groupId, roleId],
    );
    await tx.run('DELETE FROM server_member_roles WHERE group_id = ? AND role_id = ?', [groupId, roleId]);
    await tx.run('DELETE FROM server_roles WHERE group_id = ? AND id = ?', [groupId, roleId]);
  });
}

export async function setServerMemberRole({ groupId, userId, roleId, assignedBy, granted }) {
  const role = await getServerRole(groupId, roleId);
  if (role.isDefault) throw badRequest('Every member already has the @everyone role.');
  const member = await getDb().get(
    'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId],
  );
  if (!member) throw notFound('That user is not in this server.');
  if (granted) {
    await getDb().run(
      `INSERT INTO server_member_roles (group_id, user_id, role_id, assigned_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (group_id, user_id, role_id)
       DO UPDATE SET assigned_by = excluded.assigned_by, created_at = excluded.created_at`,
      [groupId, userId, roleId, assignedBy, Date.now()],
    );
  } else {
    await getDb().run(
      'DELETE FROM server_member_roles WHERE group_id = ? AND user_id = ? AND role_id = ?',
      [groupId, userId, roleId],
    );
  }
}

export async function roleStateForMember(groupId, userId) {
  const rows = await getDb().all(
    `SELECT DISTINCT r.* FROM server_roles r
     LEFT JOIN server_member_roles mr
       ON mr.role_id = r.id AND mr.group_id = r.group_id AND mr.user_id = ?
     WHERE r.group_id = ? AND (r.is_default = 1 OR mr.user_id IS NOT NULL)
     ORDER BY r.position DESC`,
    [userId, groupId],
  );
  const roles = rows.map(toServerRole);
  return {
    roles,
    permissions: new Set(roles.flatMap((role) => role.permissions)),
    highestPosition: roles
      .filter((role) => !role.isDefault)
      .reduce((highest, role) => Math.max(highest, role.position), 0),
  };
}

export async function memberRolesByUser(groupId) {
  const rows = await getDb().all(
    `SELECT mr.user_id, r.* FROM server_member_roles mr
     JOIN server_roles r ON r.id = mr.role_id AND r.group_id = mr.group_id
     WHERE mr.group_id = ? AND r.is_default = 0 ORDER BY r.position DESC`,
    [groupId],
  );
  const result = new Map();
  for (const row of rows) {
    const roles = result.get(row.user_id) ?? [];
    roles.push(toServerRole(row));
    result.set(row.user_id, roles);
  }
  return result;
}
