export type PlatformRole = 'admin' | 'youtuber' | 'member';
export type GroupRole = 'owner' | 'admin' | 'moderator' | 'member';
export type ServerPermission =
  | 'administrator'
  | 'manageGroup'
  | 'viewAuditLog'
  | 'manageChannels'
  | 'manageRoles'
  | 'createInvite'
  | 'changeNickname'
  | 'manageNicknames'
  | 'kickMember'
  | 'banMembers'
  | 'moderateMembers'
  | 'manageMembers'
  | 'manageExpressions'
  | 'createExpressions'
  | 'manageWebhooks'
  | 'viewServerInsights'
  | 'viewCreatorMonetizationAnalytics'
  | 'createEvents'
  | 'manageEvents'
  | 'viewChannel'
  | 'sendMessages'
  | 'sendTtsMessages'
  | 'sendMessagesInThreads'
  | 'createPublicThreads'
  | 'createPrivateThreads'
  | 'embedLinks'
  | 'attachFiles'
  | 'addReactions'
  | 'useExternalEmojis'
  | 'useExternalStickers'
  | 'mentionEveryone'
  | 'deleteAnyMessage'
  | 'pinMessage'
  | 'readMessageHistory'
  | 'manageThreads'
  | 'useApplicationCommands'
  | 'useExternalApps'
  | 'sendVoiceMessages'
  | 'sendPolls'
  | 'connectVoice'
  | 'speak'
  | 'video'
  | 'useVoiceActivity'
  | 'prioritySpeaker'
  | 'muteMembers'
  | 'deafenMembers'
  | 'moveMembers'
  | 'requestToSpeak'
  | 'useEmbeddedActivities'
  | 'useSoundboard'
  | 'useExternalSounds'
  | 'setVoiceChannelStatus'
  | 'bypassSlowmode';
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export interface Badge {
  id: string;
  label: string;
  kind: 'primary' | 'secondary';
  icon: string;
  color: string;
  position: number;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  avatarUrl: string | null;
  bannerColor: string | null;
  bio: string | null;
  presence: Presence;
  customStatus: string | null;
  isActive: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  badges: Badge[];
  ownerStreamerId: string | null;
}

export interface SelfUser extends PublicUser {
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  totpEnabled: boolean;
  ttsButtonEnabled: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: number | null;
  lastLoginAt: number | null;
}

export interface Notification {
  id: string;
  type: 'mention' | 'direct_message' | 'moderation' | string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: number | null;
  createdAt: number;
}

export interface NotificationPreferences {
  inApp: boolean;
  email: boolean;
  push: boolean;
  mentions: boolean;
  directMessages: boolean;
  moderation: boolean;
}

export interface AdminUser extends SelfUser {
  failedLogins: number;
  lockedUntil: number | null;
  bannedAt: number | null;
  suspendedUntil: number | null;
  moderationReason: string | null;
  lastLoginIp: string | null;
  createdBy: string | null;
  updatedAt: number;
}

export interface GroupMember extends PublicUser {
  memberRole: GroupRole;
  nickname: string | null;
  muted: boolean;
  joinedAt: number;
  invitedBy: string | null;
  serverRoles: ServerRole[];
}

export interface ServerRole {
  id: string;
  groupId: string;
  name: string;
  color: string | null;
  unicodeEmoji: string | null;
  iconAttachmentId: string | null;
  iconUrl: string | null;
  secondaryColor: string | null;
  tertiaryColor: string | null;
  position: number;
  permissions: ServerPermission[];
  isDefault: boolean;
  hoist: boolean;
  mentionable: boolean;
  inPrompt: boolean;
  managed: boolean;
  managedBy: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Group {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  iconUrl: string | null;
  accentColor: string | null;
  discoveryRequested?: boolean;
  discoverable?: boolean;
  require2faModeration?: boolean;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  memberRole?: GroupRole;
  memberCount?: number;
  channelCount?: number;
  ownerUsername?: string;
  ownerDisplayName?: string;
}

export interface Channel {
  id: string;
  groupId: string;
  categoryId: string | null;
  name: string;
  topic: string | null;
  type: 'text' | 'voice' | 'forum' | 'stage' | 'announcement';
  position: number;
  isPrivate: boolean;
  slowmode: number;
  voiceStatus: string | null;
  permissionsSynced: boolean;
  createdAt: number;
}

export interface ChannelCategory {
  id: string;
  groupId: string;
  name: string;
  position: number;
  createdAt: number;
}

export interface ForumPost {
  id: string;
  channelId: string;
  rootMessageId: string;
  authorId: string;
  title: string;
  tags: string[];
  locked: boolean;
  archived: boolean;
  private: boolean;
  memberCount: number;
  canManageMembers: boolean;
  replyCount: number;
  createdAt: number;
  updatedAt: number;
  author: {
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bannerColor: string | null;
  };
}

export interface LinkedAccount {
  id: string;
  userId: string;
  platform: string;
  handle: string;
  url: string | null;
  verified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Friendship {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  direction: 'incoming' | 'outgoing';
  user: PublicUser;
  createdAt: number;
  respondedAt: number | null;
}

export interface Collab {
  id: string;
  initiator: PublicUser | null;
  partner: PublicUser | null;
  status: 'pending' | 'accepted' | 'rejected';
  title: string | null;
  note: string | null;
  groupId: string | null;
  createdAt: number;
  respondedAt: number | null;
}

export interface AccessRequest {
  id: string;
  streamer: PublicUser | null;
  user: PublicUser | null;
  status: 'pending' | 'accepted' | 'rejected';
  message: string | null;
  createdAt: number;
  respondedAt: number | null;
}

export interface GroupPermissions {
  administrator: boolean;
  manageGroup: boolean;
  deleteGroup: boolean;
  viewAuditLog: boolean;
  manageChannels: boolean;
  manageMembers: boolean;
  manageRoles: boolean;
  createInvite: boolean;
  changeNickname: boolean;
  manageNicknames: boolean;
  deleteAnyMessage: boolean;
  pinMessage: boolean;
  kickMember: boolean;
  banMembers: boolean;
  moderateMembers: boolean;
  manageExpressions: boolean;
  manageWebhooks: boolean;
  createEvents: boolean;
  manageEvents: boolean;
  highestRolePosition: number;
  effective: ServerPermission[];
}

export interface Invite {
  id: string;
  groupId: string;
  code: string;
  createdBy: string;
  creatorDisplayName: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs?: number | null;
  kind?: 'file' | 'voice';
  url: string;
  previewUrl?: string | null;
  optimizedUrl?: string | null;
  processingStatus?: 'queued' | 'processing' | 'complete' | 'failed' | 'quarantined';
  scanStatus?: string;
  createdAt: number;
}

export interface GroupExpression {
  id: string;
  groupId: string;
  attachmentId: string;
  name: string;
  type: 'emoji' | 'sticker' | 'sound';
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  createdBy: string;
  createdAt: number;
  sourceGroupName?: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface ReplyPreview {
  id: string;
  username: string;
  displayName: string;
  preview: string;
  encrypted?: boolean;
  encryptedContent?: string | null;
  authorId?: string;
  conversationId?: string | null;
}

export interface Message {
  id: string;
  /** Idempotency/reconciliation key generated by the sending client. */
  clientId?: string | null;
  channelId: string | null;
  conversationId: string | null;
  authorId: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bannerColor: string | null;
    role: PlatformRole;
  } | null;
  content: string;
  type: 'user' | 'system' | 'poll' | 'imported' | 'encrypted' | 'tts';
  replyToId: string | null;
  replyTo?: ReplyPreview | null;
  pinned: boolean;
  createdAt: number;
  editedAt: number | null;
  expiresAt?: number | null;
  suppressEmbeds?: boolean;
  deleted: boolean;
  attachments: Attachment[];
  reactions: Reaction[];
  mentionedUserIds?: string[];
  deliveryStatus?: 'sending' | 'sent' | 'failed';
  deliveryError?: string | null;
  threadReplyCount?: number;
  poll?: {
    id: string;
    creatorId: string | null;
    question: string;
    multiple: boolean;
    anonymous: boolean;
    examMode: boolean;
    closesAt: number | null;
    closed: boolean;
    viewerOptionIds: string[];
    correctOptionIds: string[];
    options: {
      id: string;
      label: string;
      votes: number;
      userIds: string[];
    }[];
  } | null;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group_dm';
  name: string | null;
  iconUrl: string | null;
  ownerId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  members: PublicUser[];
  otherMembers?: PublicUser[];
  lastMessage: {
    id: string;
    preview: string;
    encrypted?: boolean;
    encryptedContent?: string | null;
    authorId?: string;
    authorName: string;
    createdAt: number;
  } | null;
}

export interface PublicSettings {
  app_name: string;
  app_logo_url: string;
  registration_enabled: boolean;
  login_title: string;
  login_subtitle: string;
  login_footer_text: string;
  signup_title: string;
  signup_subtitle: string;
  uploads_enabled: boolean;
  upload_limit_enabled: boolean;
  max_upload_mb: number;
  allow_image_uploads: boolean;
  allow_video_uploads: boolean;
  allow_audio_uploads: boolean;
  allow_document_uploads: boolean;
  allow_dms: boolean;
  allow_group_dms: boolean;
  youtubers_can_create_groups: boolean;
  members_can_create_groups: boolean;
  message_edit_window_minutes: number;
  feature_e2ee: boolean;
  e2ee_required_for_dms: boolean;
  fish_tts_enabled: boolean;
  feature_pwa: boolean;
  feature_webhooks: boolean;
  feature_api_keys: boolean;
  feature_voice_calls: boolean;
  feature_push_notifications: boolean;
  motd: string;
}

export interface AdminSettings extends PublicSettings {
  require_2fa_for_admins: boolean;
  spam_messages_per_30s: number;
  blocked_terms: string;
}

export interface AuditLog {
  id: string;
  action: string;
  actorId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  targetType: string | null;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  integrityProtected?: boolean;
  createdAt: number;
}

export interface SecurityEvent {
  id: string;
  event: string;
  severity: 'info' | 'warning' | 'critical';
  ip: string | null;
  userAgent: string | null;
  meta: Record<string, unknown> | null;
  acknowledgedAt: number | null;
  createdAt: number;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  active: boolean;
  current?: boolean;
}

export interface VoiceParticipantState {
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
  speaking: boolean;
  priority: boolean;
  joinedAt: number;
}

export interface VoiceParticipant extends VoiceParticipantState {
  userId: string;
}

export interface UnreadEntry {
  id: string;
  groupId?: string;
  unread: number;
  mentions: number;
}
