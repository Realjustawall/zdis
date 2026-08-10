import { create } from 'zustand';
import { api } from '../lib/api';
import { useSession } from './session';
import type {
  Channel,
  ChannelCategory,
  Conversation,
  Group,
  GroupMember,
  GroupPermissions,
  Invite,
  Message,
  PublicUser,
  ServerRole,
  UnreadEntry,
} from '../types';

export type Target =
  | { kind: 'channel'; groupId: string; channelId: string }
  | { kind: 'conversation'; conversationId: string }
  | null;

/** URL prefix for the message endpoints of whatever is open. */
export function targetPath(target: NonNullable<Target>): string {
  return target.kind === 'channel'
    ? `/api/channels/${target.channelId}`
    : `/api/conversations/${target.conversationId}`;
}

export function targetKey(target: NonNullable<Target>): string {
  return target.kind === 'channel' ? `channel:${target.channelId}` : `conversation:${target.conversationId}`;
}

interface GroupDetail {
  group: Group;
  channels: Channel[];
  categories: ChannelCategory[];
  members: GroupMember[];
  invites: Invite[];
  roles: ServerRole[];
  permissions: GroupPermissions;
}

interface ChatState {
  groups: Group[];
  conversations: Conversation[];
  directory: PublicUser[];
  groupDetail: Record<string, GroupDetail>;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  loadingMessages: Record<string, boolean>;
  unreadChannels: Record<string, UnreadEntry>;
  unreadConversations: Record<string, UnreadEntry>;
  target: Target;

  loadInitial: () => Promise<void>;
  loadDirectory: (search?: string) => Promise<void>;
  loadGroup: (groupId: string) => Promise<GroupDetail | null>;
  setTarget: (target: Target) => void;
  loadMessages: (target: NonNullable<Target>, opts?: { before?: string }) => Promise<void>;
  sendMessage: (
    target: NonNullable<Target>,
    body: {
      content: string;
      replyToId?: string | null;
      attachmentIds?: string[];
      expiresInSeconds?: number | null;
      encrypted?: boolean;
      tts?: boolean;
    },
  ) => Promise<Message>;
  editMessage: (target: NonNullable<Target>, messageId: string, content: string) => Promise<void>;
  deleteMessage: (target: NonNullable<Target>, messageId: string) => Promise<void>;
  toggleReaction: (target: NonNullable<Target>, messageId: string, emoji: string) => Promise<void>;
  togglePin: (target: NonNullable<Target>, messageId: string, pinned: boolean) => Promise<void>;
  markRead: (target: NonNullable<Target>, messageId?: string) => Promise<void>;
  refreshUnread: () => Promise<void>;
  openDm: (userId: string) => Promise<Conversation>;

  /** Socket-driven mutations. */
  applyIncoming: (message: Message) => void;
  applyUpdated: (message: Message) => void;
  applyPollUpdate: (message: Message) => void;
  applyDeleted: (payload: { messageId: string; channelId: string | null; conversationId: string | null }) => void;
  applyReactions: (payload: {
    messageId: string;
    channelId: string | null;
    conversationId: string | null;
    reactions: Message['reactions'];
  }) => void;
  upsertGroup: (group: Group) => void;
  removeGroup: (groupId: string) => void;
  upsertConversation: (conversation: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  patchGroupDetail: (groupId: string, patch: Partial<GroupDetail>) => void;
}

const keyOf = (payload: { channelId?: string | null; conversationId?: string | null }) =>
  payload.channelId ? `channel:${payload.channelId}` : `conversation:${payload.conversationId}`;

export const useChat = create<ChatState>((set, get) => ({
  groups: [],
  conversations: [],
  directory: [],
  groupDetail: {},
  messages: {},
  hasMore: {},
  loadingMessages: {},
  unreadChannels: {},
  unreadConversations: {},
  target: null,

  async loadInitial() {
    const [groups, conversations] = await Promise.all([
      api.get<{ groups: Group[] }>('/api/groups'),
      api.get<{ conversations: Conversation[] }>('/api/conversations'),
    ]);
    set({ groups: groups.groups, conversations: conversations.conversations });
    await get().refreshUnread();
  },

  async loadDirectory(search = '') {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const data = await api.get<{ users: PublicUser[] }>(`/api/users${query}`);
    set({ directory: data.users });
  },

  async loadGroup(groupId) {
    try {
      const detail = await api.get<GroupDetail>(`/api/groups/${groupId}`);
      set((state) => ({ groupDetail: { ...state.groupDetail, [groupId]: detail } }));
      return detail;
    } catch {
      return null;
    }
  },

  setTarget(target) {
    set({ target });
  },

  async loadMessages(target, opts = {}) {
    const key = targetKey(target);
    if (get().loadingMessages[key]) return;
    set((state) => ({ loadingMessages: { ...state.loadingMessages, [key]: true } }));

    try {
      const query = opts.before ? `?before=${opts.before}&limit=50` : '?limit=50';
      const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `${targetPath(target)}/messages${query}`,
      );

      set((state) => {
        const existing = state.messages[key] ?? [];
        const merged = opts.before ? [...data.messages, ...existing] : data.messages;
        return {
          messages: { ...state.messages, [key]: dedupe(merged) },
          hasMore: { ...state.hasMore, [key]: data.hasMore },
        };
      });
    } finally {
      set((state) => ({ loadingMessages: { ...state.loadingMessages, [key]: false } }));
    }
  },

  async sendMessage(target, body) {
    const data = await api.post<{ message: Message }>(`${targetPath(target)}/messages`, body);
    // The socket echo usually arrives first; applyIncoming de-duplicates.
    get().applyIncoming(data.message);
    return data.message;
  },

  async editMessage(target, messageId, content) {
    const data = await api.patch<{ message: Message }>(
      `${targetPath(target)}/messages/${messageId}`,
      { content },
    );
    get().applyUpdated(data.message);
  },

  async deleteMessage(target, messageId) {
    await api.del(`${targetPath(target)}/messages/${messageId}`);
    get().applyDeleted({
      messageId,
      channelId: target.kind === 'channel' ? target.channelId : null,
      conversationId: target.kind === 'conversation' ? target.conversationId : null,
    });
  },

  async toggleReaction(target, messageId, emoji) {
    const data = await api.put<{ reactions: Message['reactions'] }>(
      `${targetPath(target)}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    );
    get().applyReactions({
      messageId,
      channelId: target.kind === 'channel' ? target.channelId : null,
      conversationId: target.kind === 'conversation' ? target.conversationId : null,
      reactions: data.reactions,
    });
  },

  async togglePin(target, messageId, pinned) {
    const data = await api.put<{ message: Message }>(
      `${targetPath(target)}/messages/${messageId}/pin`,
      { pinned },
    );
    get().applyUpdated(data.message);
  },

  async markRead(target, messageId) {
    await api.post(`${targetPath(target)}/read`, messageId ? { messageId } : {});
    const id = target.kind === 'channel' ? target.channelId : target.conversationId;
    set((state) =>
      target.kind === 'channel'
        ? {
            unreadChannels: {
              ...state.unreadChannels,
              [id]: { ...(state.unreadChannels[id] ?? { id, unread: 0, mentions: 0 }), unread: 0, mentions: 0 },
            },
          }
        : {
            unreadConversations: {
              ...state.unreadConversations,
              [id]: { ...(state.unreadConversations[id] ?? { id, unread: 0, mentions: 0 }), unread: 0, mentions: 0 },
            },
          },
    );
  },

  async refreshUnread() {
    const data = await api.get<{ channels: UnreadEntry[]; conversations: UnreadEntry[] }>('/api/unread');
    set({
      unreadChannels: Object.fromEntries(data.channels.map((entry) => [entry.id, entry])),
      unreadConversations: Object.fromEntries(data.conversations.map((entry) => [entry.id, entry])),
    });
  },

  async openDm(userId) {
    const data = await api.post<{ conversation: Conversation }>('/api/conversations/dm', { userId });
    get().upsertConversation(data.conversation);
    return data.conversation;
  },

  applyIncoming(message) {
    const key = keyOf(message);
    set((state) => {
      const existing = state.messages[key] ?? [];
      if (existing.some((item) => item.id === message.id)) return state;

      const isOpen = state.target && targetKey(state.target) === key;
      const next = { ...state.messages, [key]: [...existing, message] };

      if (isOpen) return { messages: next };

      // Not looking at it — bump the unread badge.
      if (message.channelId) {
        const groupId = Object.values(state.groupDetail).find((detail) =>
          detail.channels.some((channel) => channel.id === message.channelId),
        )?.group.id;
        const userId = useSession.getState().user?.id;
        const mentioned = Boolean(userId && message.mentionedUserIds?.includes(userId));
        const current = state.unreadChannels[message.channelId] ?? {
          id: message.channelId,
          groupId,
          unread: 0,
          mentions: 0,
        };
        return {
          messages: next,
          unreadChannels: {
            ...state.unreadChannels,
            [message.channelId]: {
              ...current,
              groupId: current.groupId ?? groupId,
              unread: current.unread + 1,
              mentions: current.mentions + (mentioned ? 1 : 0),
            },
          },
        };
      }
      if (message.conversationId) {
        const current = state.unreadConversations[message.conversationId] ?? {
          id: message.conversationId,
          unread: 0,
          mentions: 0,
        };
        return {
          messages: next,
          unreadConversations: {
            ...state.unreadConversations,
            [message.conversationId]: { ...current, unread: current.unread + 1, mentions: current.mentions + 1 },
          },
        };
      }
      return { messages: next };
    });

    // Keep DM ordering fresh in the sidebar.
    if (message.conversationId) {
      set((state) => ({
        conversations: state.conversations
          .map((conversation) =>
            conversation.id === message.conversationId
              ? {
                  ...conversation,
                  updatedAt: message.createdAt,
                  lastMessage: {
                    id: message.id,
                    preview: message.type === 'encrypted' ? 'Encrypted message' : message.content.slice(0, 120),
                    encrypted: message.type === 'encrypted',
                    encryptedContent: message.type === 'encrypted' ? message.content : null,
                    authorId: message.authorId,
                    authorName: message.author?.displayName ?? 'Someone',
                    createdAt: message.createdAt,
                  },
                }
              : conversation,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt),
      }));
    }
  },

  applyUpdated(message) {
    const key = keyOf(message);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] ?? []).map((item) => (item.id === message.id ? message : item)),
      },
    }));
  },

  applyPollUpdate(message) {
    const key = keyOf(message);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] ?? []).map((item) => {
          if (item.id !== message.id) return item;
          if (!message.poll || !item.poll) return message;
          return {
            ...message,
            poll: {
              ...message.poll,
              viewerOptionIds: item.poll.viewerOptionIds ?? [],
              correctOptionIds: message.poll.correctOptionIds?.length
                ? message.poll.correctOptionIds
                : item.poll.correctOptionIds ?? [],
            },
          };
        }),
      },
    }));
  },

  applyDeleted(payload) {
    const key = keyOf(payload);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] ?? []).map((item) =>
          item.id === payload.messageId
            ? { ...item, deleted: true, content: '', attachments: [], reactions: [], pinned: false }
            : item,
        ),
      },
    }));
  },

  applyReactions(payload) {
    const key = keyOf(payload);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] ?? []).map((item) =>
          item.id === payload.messageId ? { ...item, reactions: payload.reactions } : item,
        ),
      },
    }));
  },

  upsertGroup(group) {
    set((state) => {
      const exists = state.groups.some((item) => item.id === group.id);
      return {
        groups: exists
          ? state.groups.map((item) => (item.id === group.id ? { ...item, ...group } : item))
          : [...state.groups, group],
      };
    });
  },

  removeGroup(groupId) {
    set((state) => {
      const detail = { ...state.groupDetail };
      delete detail[groupId];
      return {
        groups: state.groups.filter((group) => group.id !== groupId),
        groupDetail: detail,
        target: state.target?.kind === 'channel' && state.target.groupId === groupId ? null : state.target,
      };
    });
  },

  upsertConversation(conversation) {
    set((state) => {
      const exists = state.conversations.some((item) => item.id === conversation.id);
      const next = exists
        ? state.conversations.map((item) =>
            item.id === conversation.id ? { ...item, ...conversation } : item,
          )
        : [conversation, ...state.conversations];
      return { conversations: next.sort((a, b) => b.updatedAt - a.updatedAt) };
    });
  },

  removeConversation(conversationId) {
    set((state) => ({
      conversations: state.conversations.filter((item) => item.id !== conversationId),
      target:
        state.target?.kind === 'conversation' && state.target.conversationId === conversationId
          ? null
          : state.target,
    }));
  },

  patchGroupDetail(groupId, patch) {
    set((state) => {
      const existing = state.groupDetail[groupId];
      if (!existing) return state;
      return { groupDetail: { ...state.groupDetail, [groupId]: { ...existing, ...patch } } };
    });
  },
}));

function dedupe(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(message);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
