import { create } from 'zustand';
import { api } from '../lib/api';
import type { Friendship } from '../types';

interface FriendsState {
  friendships: Friendship[];
  loading: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
  clear: () => void;
}

export const useFriends = create<FriendsState>((set) => ({
  friendships: [],
  loading: false,
  loaded: false,

  async refresh() {
    set({ loading: true });
    try {
      const result = await api.get<{ friendships: Friendship[] }>('/api/network/friends');
      set({ friendships: result.friendships, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  clear() {
    set({ friendships: [], loading: false, loaded: false });
  },
}));
