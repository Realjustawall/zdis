import { getDb } from '../db/index.js';
import { cache } from '../cache/index.js';
import { config } from '../config.js';

const CACHE_KEY = 'settings:all';

/**
 * Runtime settings the admin can flip without a restart. `uploads_enabled`
 * gates the whole file feature: when it is off the upload route 403s and the
 * client hides the attach button entirely.
 */
export const DEFAULT_SETTINGS = {
  app_name: 'sahsha',
  app_logo_url: '',
  registration_enabled: false,
  login_title: 'Welcome back',
  login_subtitle: 'Sign in to continue to your community.',
  login_footer_text: 'Use your email, phone number, or username.',
  signup_title: 'Create your account',
  signup_subtitle: 'Join the community and start chatting.',
  uploads_enabled: true,
  upload_limit_enabled: true,
  max_upload_mb: 10,
  allow_image_uploads: true,
  allow_video_uploads: true,
  allow_audio_uploads: true,
  allow_document_uploads: true,
  allow_dms: true,
  allow_group_dms: true,
  youtubers_can_create_groups: true,
  members_can_create_groups: false,
  message_edit_window_minutes: 0,
  spam_messages_per_30s: 5,
  blocked_terms: '',
  require_2fa_for_admins: false,
  feature_e2ee: true,
  e2ee_required_for_dms: true,
  feature_pwa: true,
  feature_webhooks: true,
  feature_api_keys: true,
  feature_voice_calls: true,
  feature_push_notifications: true,
  motd: '',
};

const BOOL_KEYS = new Set(
  Object.entries(DEFAULT_SETTINGS)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([key]) => key),
);
const NUMBER_KEYS = new Set(
  Object.entries(DEFAULT_SETTINGS)
    .filter(([, value]) => typeof value === 'number')
    .map(([key]) => key),
);

function decode(key, raw) {
  if (BOOL_KEYS.has(key)) return raw === '1' || raw === 'true';
  if (NUMBER_KEYS.has(key)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS[key];
  }
  return raw;
}

function encode(key, value) {
  if (BOOL_KEYS.has(key)) return value ? '1' : '0';
  return String(value);
}

export async function getSettings() {
  return cache.wrap(CACHE_KEY, 60, async () => {
    const rows = await getDb().all('SELECT key, value FROM settings');
    const merged = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key in DEFAULT_SETTINGS) merged[row.key] = decode(row.key, row.value);
    }
    return merged;
  });
}

export async function getSetting(key) {
  const settings = await getSettings();
  return settings[key];
}

export async function updateSettings(patch) {
  const db = getDb();
  const now = Date.now();
  const applied = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const encoded = encode(key, value);
    await db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, encoded, now],
    );
    applied[key] = decode(key, encoded);
  }

  await cache.del(CACHE_KEY);
  return { ...(await getSettings()), ...applied };
}

/** Settings safe to expose to every authenticated client. */
export async function getPublicSettings() {
  const settings = await getSettings();
  return {
    app_name: settings.app_name,
    app_logo_url: settings.app_logo_url,
    registration_enabled: settings.registration_enabled,
    login_title: settings.login_title,
    login_subtitle: settings.login_subtitle,
    login_footer_text: settings.login_footer_text,
    signup_title: settings.signup_title,
    signup_subtitle: settings.signup_subtitle,
    uploads_enabled: settings.uploads_enabled,
    upload_limit_enabled: settings.upload_limit_enabled,
    max_upload_mb: settings.max_upload_mb,
    allow_image_uploads: settings.allow_image_uploads,
    allow_video_uploads: settings.allow_video_uploads,
    allow_audio_uploads: settings.allow_audio_uploads,
    allow_document_uploads: settings.allow_document_uploads,
    allow_dms: settings.allow_dms,
    allow_group_dms: settings.allow_group_dms,
    youtubers_can_create_groups: settings.youtubers_can_create_groups,
    members_can_create_groups: settings.members_can_create_groups,
    message_edit_window_minutes: settings.message_edit_window_minutes,
    feature_e2ee: settings.feature_e2ee,
    e2ee_required_for_dms: settings.e2ee_required_for_dms,
    feature_pwa: settings.feature_pwa,
    feature_webhooks: settings.feature_webhooks,
    feature_api_keys: settings.feature_api_keys,
    feature_voice_calls: settings.feature_voice_calls,
    feature_push_notifications: settings.feature_push_notifications,
    fish_tts_enabled: Boolean(config.fishAudio.apiKey && config.fishAudio.referenceId),
    motd: settings.motd,
  };
}
