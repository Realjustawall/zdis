import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type { Presence, VoiceParticipant } from '../types';

type Listener = (payload: never) => void;

interface RealtimeState {
  socket: Socket | null;
  connected: boolean;
  presence: Record<string, Presence>;
  activities: Record<string, { type: string; name: string; details?: string | null; state?: string | null }>;
  /** roomKey -> set of userIds currently typing */
  typing: Record<string, string[]>;
  /** channelId -> participants */
  voice: Record<string, VoiceParticipant[]>;

  connect: () => void;
  disconnect: () => void;
  on: (event: string, handler: Listener) => () => void;
  emit: (event: string, ...args: unknown[]) => void;
  setPresence: (presence: Presence) => void;
  startTyping: (target: { channelId?: string; conversationId?: string }) => void;
  stopTyping: (target: { channelId?: string; conversationId?: string }) => void;
}

const roomKey = (payload: { channelId?: string | null; conversationId?: string | null }) =>
  payload.channelId ? `channel:${payload.channelId}` : `conversation:${payload.conversationId}`;

/** Throttles typing:start so we send at most one event every few seconds. */
let lastTypingSentAt = 0;

export const useRealtime = create<RealtimeState>((set, get) => ({
  socket: null,
  connected: false,
  presence: {},
  activities: {},
  typing: {},
  voice: {},

  connect() {
    if (get().socket) return;

    const socket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 6000,
    });

    socket.on('connect', () => set({ connected: true }));
    socket.on('disconnect', () => set({ connected: false }));

    socket.on('ready', (payload: { voice: Record<string, VoiceParticipant[]> }) => {
      set({ voice: payload.voice ?? {} });
    });

    socket.on('presence:update', ({ userId, presence }: { userId: string; presence: Presence }) => {
      set((state) => ({ presence: { ...state.presence, [userId]: presence } }));
    });
    socket.on('presence:activity', ({ userId, activity }: { userId: string; activity: RealtimeState['activities'][string] | null }) => {
      set((state) => {
        const next = { ...state.activities };
        if (activity) next[userId] = activity;
        else delete next[userId];
        return { activities: next };
      });
    });

    socket.on('typing:start', (payload: { userId: string; channelId: string | null; conversationId: string | null }) => {
      const key = roomKey(payload);
      set((state) => {
        const current = state.typing[key] ?? [];
        if (current.includes(payload.userId)) return state;
        return { typing: { ...state.typing, [key]: [...current, payload.userId] } };
      });
    });

    socket.on('typing:stop', (payload: { userId: string; channelId: string | null; conversationId: string | null }) => {
      const key = roomKey(payload);
      set((state) => ({
        typing: {
          ...state.typing,
          [key]: (state.typing[key] ?? []).filter((id) => id !== payload.userId),
        },
      }));
    });

    socket.on('voice:state', ({ channelId, participants }: { channelId: string; participants: VoiceParticipant[] }) => {
      set((state) => ({ voice: { ...state.voice, [channelId]: participants } }));
    });

    socket.on('voice:closed', ({ channelId }: { channelId: string }) => {
      set((state) => {
        const next = { ...state.voice };
        delete next[channelId];
        return { voice: next };
      });
    });

    set({ socket });
  },

  disconnect() {
    const { socket } = get();
    socket?.close();
    set({ socket: null, connected: false, presence: {}, activities: {}, typing: {}, voice: {} });
  },

  on(event, handler) {
    const { socket } = get();
    if (!socket) return () => {};
    socket.on(event, handler as never);
    return () => {
      socket.off(event, handler as never);
    };
  },

  emit(event, ...args) {
    get().socket?.emit(event, ...args);
  },

  setPresence(presence) {
    get().socket?.emit('presence:set', { presence });
  },

  startTyping(target) {
    const now = Date.now();
    if (now - lastTypingSentAt < 3000) return;
    lastTypingSentAt = now;
    get().socket?.emit('typing:start', target);
  },

  stopTyping(target) {
    lastTypingSentAt = 0;
    get().socket?.emit('typing:stop', target);
  },
}));
