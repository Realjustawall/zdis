import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import type { PublicSettings, SelfUser } from '../types';

interface MeResponse {
  user: SelfUser | null;
  csrfToken?: string;
  settings: PublicSettings;
  ice?: RTCIceServer[];
  voice?: { mode: 'mesh' | 'sfu'; livekitUrl: string | null };
}

interface LoginResponse {
  user?: SelfUser;
  csrfToken?: string;
  settings?: PublicSettings;
  mfaRequired?: boolean;
  needsTotpEnrolment?: boolean;
}

interface SessionState {
  user: SelfUser | null;
  settings: PublicSettings | null;
  iceServers: RTCIceServer[];
  voiceMode: 'mesh' | 'sfu';
  livekitUrl: string | null;
  loading: boolean;
  mfaRequired: boolean;

  bootstrap: () => Promise<void>;
  login: (identifier: string, password: string, totp?: string) => Promise<'ok' | 'mfa'>;
  ldapLogin: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: SelfUser) => void;
  patchSettings: (settings: Partial<PublicSettings>) => void;
  updateProfile: (patch: Record<string, unknown>) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  settings: null,
  iceServers: DEFAULT_ICE,
  voiceMode: 'mesh',
  livekitUrl: null,
  loading: true,
  mfaRequired: false,

  async bootstrap() {
    try {
      const data = await api.get<MeResponse>('/api/auth/me');
      set({
        user: data.user,
        settings: data.settings,
        iceServers: data.ice?.length ? data.ice : DEFAULT_ICE,
        voiceMode: data.voice?.mode ?? 'mesh',
        livekitUrl: data.voice?.livekitUrl ?? null,
        loading: false,
      });
    } catch {
      set({ user: null, loading: false });
    }
  },

  async login(identifier, password, totp) {
    const data = await api.post<LoginResponse>('/api/auth/login', {
      identifier,
      password,
      ...(totp ? { totp } : {}),
    });

    if (data.mfaRequired) {
      set({ mfaRequired: true });
      return 'mfa';
    }

    set({
      user: data.user ?? null,
      settings: data.settings ?? get().settings,
      mfaRequired: false,
    });
    // Pick up the ICE configuration that only /me returns.
    await get().bootstrap();
    return 'ok';
  },

  async ldapLogin(identifier, password) {
    const data = await api.post<LoginResponse>('/api/auth/sso/ldap/login', {
      identifier,
      password,
    });
    set({
      user: data.user ?? null,
      settings: data.settings ?? get().settings,
      mfaRequired: false,
    });
    await get().bootstrap();
  },

  async logout() {
    try {
      await api.post('/api/auth/logout');
    } catch (error) {
      // A revoked session already achieves the goal; anything else is noise.
      if (!(error instanceof ApiError)) throw error;
    }
    set({ user: null, mfaRequired: false });
  },

  setUser(user) {
    set({ user });
  },

  patchSettings(settings) {
    const current = get().settings;
    if (current) set({ settings: { ...current, ...settings } });
  },

  async updateProfile(patch) {
    const data = await api.patch<{ user: SelfUser }>('/api/auth/profile', patch);
    set({ user: data.user });
  },

  async changePassword(currentPassword, newPassword) {
    const data = await api.post<{ user: SelfUser }>('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    set({ user: data.user });
  },
}));
