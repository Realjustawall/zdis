import { getDb } from '../db/index.js';
import { forbidden, notFound } from '../lib/errors.js';
import {
  can as hasCapability,
  canCreateGroup as canCreateGroupByCapability,
  CAPABILITIES,
} from './capabilities.js';
import { roleStateForMember, SERVER_PERMISSION_KEYS } from './serverRoles.js';
import {
  channelPermission,
  listCategoryOverrides,
  listChannelOverrides,
} from './channelPermissions.js';

/**
 * Group-scoped roles, most privileged first. A member's effective rank is the
 * index of their role; lower index wins.
 */
export const GROUP_ROLE_RANK = { owner: 0, admin: 1, moderator: 2, member: 3 };

export function baseGroupRolePosition(role) {
  if (role === 'owner') return Number.MAX_SAFE_INTEGER;
  if (role === 'admin') return 2_000_000;
  if (role === 'moderator') return 1_000_000;
  return 0;
}

export const GROUP_PERMISSIONS = {
  manageGroup: ['owner', 'admin'],
  viewAuditLog: ['owner', 'admin', 'moderator'],
  deleteGroup: ['owner'],
  manageChannels: ['owner', 'admin'],
  manageMembers: ['owner', 'admin', 'moderator'],
  manageRoles: ['owner', 'admin'],
  createInvite: ['owner', 'admin', 'moderator'],
  changeNickname: ['owner', 'admin', 'moderator', 'member'],
  manageNicknames: ['owner', 'admin', 'moderator'],
  deleteAnyMessage: ['owner', 'admin', 'moderator'],
  pinMessage: ['owner', 'admin', 'moderator'],
  kickMember: ['owner', 'admin', 'moderator'],
  banMembers: ['owner', 'admin', 'moderator'],
  moderateMembers: ['owner', 'admin', 'moderator'],
  manageExpressions: ['owner', 'admin'],
  createExpressions: ['owner', 'admin'],
  manageWebhooks: ['owner', 'admin'],
  viewServerInsights: ['owner', 'admin'],
  viewCreatorMonetizationAnalytics: ['owner', 'admin'],
  createEvents: ['owner', 'admin', 'moderator'],
  manageEvents: ['owner', 'admin'],
  manageThreads: ['owner', 'admin', 'moderator'],
  muteMembers: ['owner', 'admin', 'moderator'],
  deafenMembers: ['owner', 'admin', 'moderator'],
  moveMembers: ['owner', 'admin', 'moderator'],
  setVoiceChannelStatus: ['owner', 'admin', 'moderator'],
  bypassSlowmode: ['owner', 'admin', 'moderator'],
};

const TWO_FACTOR_PROTECTED_PERMISSIONS = new Set([
  'administrator',
  'kickMember',
  'banMembers',
  'manageGroup',
  'manageChannels',
  'manageRoles',
  'manageWebhooks',
  'manageExpressions',
  'deleteAnyMessage',
  'manageEvents',
  'manageThreads',
  'moderateMembers',
  'manageMembers',
  'viewCreatorMonetizationAnalytics',
]);

export async function getMembership(groupId, userId) {
  return getDb().get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [
    groupId,
    userId,
  ]);
}

export async function getGroup(groupId) {
  return getDb().get('SELECT * FROM chat_groups WHERE id = ?', [groupId]);
}

export async function activeServerTimeout(groupId, userId) {
  return getDb().get(
    `SELECT expires_at, reason FROM server_timeouts
     WHERE group_id = ? AND user_id = ? AND expires_at > ?`,
    [groupId, userId, Date.now()],
  );
}

export async function memberHierarchyPosition(groupId, userId) {
  const membership = await getMembership(groupId, userId);
  if (!membership) return null;
  const roleState = await roleStateForMember(groupId, userId);
  return Math.max(baseGroupRolePosition(membership.role), roleState.highestPosition);
}

/**
 * Resolves what `user` may do in `groupId`. Platform admins are treated as
 * group owners everywhere so they can always moderate.
 */
export async function groupContext(groupId, user) {
  const group = await getGroup(groupId);
  if (!group) throw notFound('Group not found.');

  const membership = await getMembership(groupId, user.id);
  const isPlatformAdmin = await hasCapability(user, CAPABILITIES.ADMIN);
  const isPlatformModerator = await hasCapability(user, CAPABILITIES.MODERATE);

  if (!membership && !isPlatformAdmin && !isPlatformModerator) {
    // Same response as a missing group: non-members must not be able to probe
    // which group ids exist.
    throw notFound('Group not found.');
  }

  const effectiveRole = !membership
    ? isPlatformAdmin
      ? 'owner'
      : 'moderator'
    : membership.role;
  const serverRoleState = membership
    ? await roleStateForMember(groupId, user.id)
    : { roles: [], permissions: new Set(), highestPosition: 0 };
  const hasServerAdministrator = serverRoleState.permissions.has('administrator');
  const externalPlatformModerator = isPlatformModerator && !membership && !isPlatformAdmin;
  const baseHierarchy = baseGroupRolePosition(effectiveRole);
  const timeoutExempt =
    isPlatformAdmin || effectiveRole === 'owner' || hasServerAdministrator;
  const timeout = membership && !timeoutExempt
    ? await activeServerTimeout(groupId, user.id)
    : null;
  const timeoutAllows = new Set(['viewChannel', 'readMessageHistory']);
  const twoFactorRequired =
    Boolean(group.require_2fa_moderation) &&
    !Boolean(user.totp_enabled ?? user.totpEnabled) &&
    !isPlatformAdmin;

  return {
    group,
    userId: user.id,
    membership: membership ?? null,
    role: effectiveRole,
    isPlatformAdmin,
    isPlatformModerator,
    permissionBypass: timeoutExempt && !twoFactorRequired,
    twoFactorRequired,
    timedOutUntil: timeout ? Number(timeout.expires_at) : null,
    serverRoles: serverRoleState.roles,
    highestRolePosition: Math.max(baseHierarchy, serverRoleState.highestPosition),
    effectivePermissions: SERVER_PERMISSION_KEYS.filter(
      (permission) =>
        twoFactorRequired && TWO_FACTOR_PROTECTED_PERMISSIONS.has(permission)
          ? false
          : timeout
          ? timeoutAllows.has(permission)
          : isPlatformAdmin ||
            effectiveRole === 'owner' ||
            hasServerAdministrator ||
            (!externalPlatformModerator && GROUP_PERMISSIONS[permission]?.includes(effectiveRole)) ||
            (externalPlatformModerator && ['deleteAnyMessage', 'pinMessage'].includes(permission)) ||
            serverRoleState.permissions.has(permission),
    ),
    can(permission) {
      if (twoFactorRequired && TWO_FACTOR_PROTECTED_PERMISSIONS.has(permission)) {
        return false;
      }
      if (timeout) return timeoutAllows.has(permission);
      if (isPlatformAdmin || effectiveRole === 'owner' || hasServerAdministrator) return true;
      if (externalPlatformModerator) {
        return [
          'deleteAnyMessage',
          'pinMessage',
          'viewAuditLog',
          'moderateMembers',
        ].includes(permission);
      }
      const allowed = GROUP_PERMISSIONS[permission];
      return (
        (Array.isArray(allowed) && allowed.includes(effectiveRole)) ||
        serverRoleState.permissions.has(permission)
      );
    },
    outranks(otherRole) {
      if (isPlatformAdmin) return true;
      return GROUP_ROLE_RANK[effectiveRole] < GROUP_ROLE_RANK[otherRole];
    },
    async outranksMember(targetUserId) {
      if (targetUserId === user.id) return false;
      if (isPlatformAdmin || effectiveRole === 'owner') return true;
      const targetPosition = await memberHierarchyPosition(groupId, targetUserId);
      return targetPosition !== null && Math.max(baseHierarchy, serverRoleState.highestPosition) > targetPosition;
    },
  };
}

export async function requireGroupPermission(groupId, user, permission) {
  const context = await groupContext(groupId, user);
  if (!context.can(permission)) throw forbidden('You do not have permission to do that in this group.');
  return context;
}

/**
 * Who is allowed to start a new group. YouTubers are the intended creators:
 * each one runs their own space and pulls their team in.
 */
export async function canCreateGroup(user) {
  return canCreateGroupByCapability(user);
}

/** Channel visibility: private channels need an explicit member row. */
export async function canAccessChannel(channel, context) {
  if (!(await channelPermission(channel, context, 'viewChannel'))) return false;
  if (!channel.is_private) return true;
  if (context.isPlatformAdmin) return true;
  if (context.can('manageChannels')) return true;
  const row = await getDb().get(
    'SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND user_id = ?',
    [channel.id, context.membership?.user_id],
  );
  if (row) return true;

  // Private channels historically used an explicit seat table. Discord-style
  // role and member overwrites must also be able to grant View Channel.
  const overrides =
    channel.category_id && Boolean(channel.permissions_synced)
      ? await listCategoryOverrides(channel.group_id, channel.category_id)
      : await listChannelOverrides(channel.group_id, channel.id);
  const roleIds = new Set(context.serverRoles.map((role) => role.id));
  return overrides.some(
    (override) =>
      override.allow.includes('viewChannel') &&
      (override.targetType === 'everyone' ||
        (override.targetType === 'member' && override.targetId === context.userId) ||
        (override.targetType === 'role' && roleIds.has(override.targetId))),
  );
}

export async function isConversationMember(conversationId, userId) {
  const row = await getDb().get(
    'SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId],
  );
  return Boolean(row);
}

export async function isBlocked(ownerId, otherId) {
  const row = await getDb().get(
    'SELECT 1 AS ok FROM user_blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)',
    [ownerId, otherId, otherId, ownerId],
  );
  return Boolean(row);
}
