import { useEffect, useRef, useState } from 'react';
import { Avatar, Modal, Alert, ErrorList, RoleBadge, BadgeList } from './ui';
import { useSession } from '../store/session';
import { useRealtime } from '../store/realtime';
import { api, ApiError } from '../lib/api';
import { toast } from '../store/toast';
import { formatFullTimestamp, formatRelative } from '../lib/format';
import type { NotificationPreferences, Presence, SecurityEvent, SessionInfo } from '../types';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

const PRESENCE_OPTIONS: { value: Presence; icon: string; key: 'presence.online' | 'presence.idle' | 'presence.dnd' | 'presence.offline' }[] = [
  { value: 'online', icon: '🟢', key: 'presence.online' },
  { value: 'idle', icon: '🟡', key: 'presence.idle' },
  { value: 'dnd', icon: '🔴', key: 'presence.dnd' },
  { value: 'offline', icon: '⚫', key: 'presence.offline' },
];

export function SelfPanel({ onClose }: { onClose: () => void }) {
  const user = useSession((state) => state.user)!;
  const updateProfile = useSession((state) => state.updateProfile);
  const changePassword = useSession((state) => state.changePassword);
  const setPresence = useRealtime((state) => state.setPresence);
  const { t, locale } = useI18n();
  const fa = locale === 'fa';

  const [tab, setTab] = useState<'profile' | 'security' | 'audio' | 'notifications' | 'sessions'>('profile');

  return (
    <Modal title={t('account.title')} onClose={onClose} wide>
      <div className="account-tabs" role="tablist" aria-label={t('account.title')}>
        {(['profile', 'security', 'audio', 'notifications', 'sessions'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={`account-tab${tab === item ? ' active' : ''}`}
            onClick={() => setTab(item)}
          >
            <Icon
              name={
                item === 'profile'
                  ? 'users'
                  : item === 'security'
                    ? 'shield'
                    : item === 'audio'
                      ? 'speaker'
                    : item === 'notifications'
                      ? 'bell'
                      : 'system'
              }
              size={16}
            />
            {item === 'profile'
              ? t('account.profile')
              : item === 'security'
                ? t('account.security')
                : item === 'audio'
                  ? (fa ? 'صدا' : 'Audio')
                : item === 'notifications'
                  ? t('account.notifications')
                  : t('account.sessions')}
          </button>
        ))}
      </div>

      {tab === 'profile' ? (
        <ProfileTab user={user} updateProfile={updateProfile} setPresence={setPresence} />
      ) : null}
      {tab === 'security' ? <SecurityTab changePassword={changePassword} /> : null}
      {tab === 'audio' ? <AudioPreferencesTab /> : null}
      {tab === 'notifications' ? <NotificationPreferencesTab /> : null}
      {tab === 'sessions' ? <SessionsTab /> : null}
      <div style={{ height: 16 }} />
    </Modal>
  );
}

function ProfileTab({
  user,
  updateProfile,
  setPresence,
}: {
  user: ReturnType<typeof useSession.getState>['user'];
  updateProfile: (patch: Record<string, unknown>) => Promise<void>;
  setPresence: (presence: Presence) => void;
}) {
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [customStatus, setCustomStatus] = useState(user?.customStatus ?? '');
  const [bannerColor, setBannerColor] = useState(user?.bannerColor ?? '#5865f2');
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const setUser = useSession((state) => state.setUser);
  const { t } = useI18n();

  if (!user) return null;

  async function save() {
    setBusy(true);
    try {
      await updateProfile({
        displayName: displayName.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        nickname: nickname.trim() || null,
        username: username.trim(),
        bio: bio.trim() || null,
        customStatus: customStatus.trim() || null,
        bannerColor,
      });
      toast.success(t('account.saved'));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t('account.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(file: File) {
    setAvatarBusy(true);
    try {
      const form = new FormData();
      form.append('avatar', file);
      const result = await api.post<{ user: NonNullable<typeof user> }>('/api/auth/avatar', form);
      setUser(result.user);
      toast.success(t('account.avatar.saved'));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t('account.avatar.failed'));
    } finally {
      setAvatarBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <>
      <div className="profile-identity">
        <button
          type="button"
          className="avatar-picker"
          onClick={() => fileInput.current?.click()}
          disabled={avatarBusy}
          aria-label={t('account.avatar.change')}
        >
          <Avatar
            name={displayName || user.username}
            id={user.id}
            src={user.avatarUrl}
            color={bannerColor}
            size={76}
          />
          <span className="avatar-picker-badge" aria-hidden="true"><Icon name="camera" size={13} /></span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadAvatar(file);
          }}
        />
        <div>
          <strong style={{ fontSize: 17 }}>{displayName || user.username}</strong>
          <div className="faint small">
            @{user.username} · {user.email}
          </div>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            <RoleBadge role={user.role} />
            <BadgeList badges={user.badges} />
          </div>
          <div className="row wrap avatar-actions">
            <button
              type="button"
              className="btn small"
              onClick={() => fileInput.current?.click()}
              disabled={avatarBusy}
            >
              {avatarBusy ? t('account.avatar.uploading') : t('account.avatar.change')}
            </button>
            <span className="faint small">{t('account.avatar.help')}</span>
          </div>
        </div>
      </div>

      <div className="field">
        <label>{t('account.status')}</label>
        <select
          className="select"
          value={user.presence}
          onChange={(event) => {
            const next = event.target.value as Presence;
            setPresence(next);
            void updateProfile({ presence: next });
          }}
        >
          {PRESENCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.icon} {t(option.key)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Activity status</label>
        <div className="row">
          <button
            className="btn small"
            onClick={async () => {
              const name = window.prompt('What are you doing?', 'Working on sahsha');
              if (!name) return;
              await api.put('/api/users/me/activity', {
                type: 'custom',
                name,
                details: window.prompt('Activity details:', '') || null,
              });
            }}
          >
            Set activity
          </button>
          <button className="btn ghost small" onClick={() => void api.del('/api/users/me/activity')}>
            Clear
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="field"><label>First name</label><input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={48} /></div>
        <div className="field"><label>Last name</label><input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={48} /></div>
        <div className="field"><label>Nickname</label><input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={48} /></div>
        <div className="field"><label>Username</label><input className="input" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} maxLength={32} /></div>
        <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} /></div>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[ -]/g, ''))} maxLength={21} /></div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label>{t('account.displayName')}</label>
          <input
            className="input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={48}
          />
        </div>
        <div className="field">
          <label>{t('account.accent')}</label>
          <input
            className="input"
            type="color"
            value={bannerColor}
            onChange={(event) => setBannerColor(event.target.value)}
            style={{ height: 42, padding: 4 }}
          />
        </div>
      </div>

      <div className="field">
        <label>{t('account.customStatus')}</label>
        <input
          className="input"
          value={customStatus}
          onChange={(event) => setCustomStatus(event.target.value)}
          maxLength={80}
          placeholder={t('account.statusPlaceholder')}
        />
      </div>

      <div className="field">
        <label>{t('account.about')}</label>
        <textarea
          className="textarea"
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          maxLength={300}
        />
      </div>

      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? t('account.saving') : t('account.save')}
      </button>
    </>
  );
}

function SecurityTab({
  changePassword,
}: {
  changePassword: (current: string, next: string) => Promise<void>;
}) {
  const user = useSession((state) => state.user)!;
  const setUser = useSession((state) => state.setUser);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryRemaining, setRecoveryRemaining] = useState<number | null>(null);
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([]);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  const loadSecurity = () => {
    api
      .get<{ events: SecurityEvent[] }>('/api/auth/security-events?limit=20')
      .then((result) => setSecurityEvents(result.events))
      .catch(() => {});
    if (user.totpEnabled) {
      api
        .get<{ remaining: number }>('/api/auth/totp/recovery-codes')
        .then((result) => setRecoveryRemaining(result.remaining))
        .catch(() => setRecoveryRemaining(null));
    }
  };

  useEffect(() => {
    loadSecurity();
    // Reload when MFA is turned on or off.
  }, [user.totpEnabled]);

  async function submit() {
    setErrors([]);
    if (next !== confirm) {
      setErrors([fa ? 'دو رمز عبور جدید یکسان نیستند.' : 'The two new passwords do not match.']);
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(fa ? 'رمز عبور تغییر کرد و دستگاه‌های دیگر خارج شدند.' : 'Password changed. Your other devices were signed out.');
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : [fa ? 'تغییر رمز عبور انجام نشد.' : 'Could not change the password.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {user.mustChangePassword ? (
        <Alert kind="info">
          {fa
            ? 'مدیر از شما خواسته است رمز عبور شخصی خود را انتخاب کنید. تا آن زمان بخش‌های دیگر برنامه قفل می‌مانند.'
            : 'An administrator asked you to choose your own password. Until you do, the rest of the app stays locked.'}
        </Alert>
      ) : null}

      {errors.length ? <ErrorList lines={errors} /> : null}

      <div className="settings-group">
        <h3>{fa ? 'رمز عبور' : 'Password'}</h3>
        <p className="desc">
          {fa ? 'آخرین تغییر: ' : 'Last changed '}{formatRelative(user.passwordChangedAt)}.
          {' '}{fa ? 'با تغییر رمز، دستگاه‌های دیگر خارج می‌شوند.' : 'Changing it signs out every other device.'}
        </p>
        <div className="field">
          <label>{fa ? 'رمز عبور فعلی' : 'Current password'}</label>
          <input
            className="input"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>{fa ? 'رمز عبور جدید' : 'New password'}</label>
            <input
              className="input"
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label>{fa ? 'تکرار رمز عبور جدید' : 'Repeat new password'}</label>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <span className="hint">
          {fa ? 'حداقل ۱۰ نویسه شامل حرف بزرگ، حرف کوچک، عدد و نماد.' : 'At least 10 characters with upper case, lower case, a digit and a symbol.'}
        </span>
        <div className="mt-16">
          <button className="btn primary" onClick={submit} disabled={busy || !current || !next}>
            {busy ? (fa ? 'در حال تغییر…' : 'Changing…') : (fa ? 'تغییر رمز عبور' : 'Change password')}
          </button>
        </div>
      </div>

      <div className="settings-group">
        <h3>{fa ? 'احراز هویت دومرحله‌ای' : 'Two-factor authentication'}</h3>
        <p className="desc">
          {user.totpEnabled
            ? (fa ? 'فعال است. هنگام هر ورود، کد برنامه احراز هویت لازم است.' : 'Enabled. A code from your authenticator app is required at every sign-in.')
            : (fa ? 'با استفاده از یک برنامه احراز هویت، مرحله دوم را به ورود اضافه کنید.' : 'Add a second step to sign-in using any authenticator app.')}
        </p>

        {user.totpEnabled ? (
          <button
            className="btn danger"
            onClick={async () => {
              const password = window.prompt(fa ? 'برای غیرفعال‌سازی، رمز عبور را تأیید کنید:' : 'Confirm your password to turn 2FA off:');
              if (!password) return;
              const code = window.prompt(fa ? 'کد ۶ رقمی فعلی را وارد کنید:' : 'Enter a current 6-digit code:');
              if (!code) return;
              try {
                const data = await api.post<{ user: typeof user }>('/api/auth/totp/disable', {
                  password,
                  token: code,
                });
                setUser(data.user);
                setRecoveryCodes([]);
                setRecoveryRemaining(null);
                toast.success(fa ? 'احراز هویت دومرحله‌ای غیرفعال شد.' : 'Two-factor authentication disabled.');
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : (fa ? 'غیرفعال‌سازی انجام نشد.' : 'Could not disable 2FA.'));
              }
            }}
          >
            {fa ? 'غیرفعال‌کردن احراز هویت دومرحله‌ای' : 'Turn off two-factor authentication'}
          </button>
        ) : totpSetup ? (
          <>
            <p className="small">
              {fa ? 'این کلید را به برنامه احراز هویت اضافه کنید و سپس کد نمایش‌داده‌شده را وارد کنید.' : 'Add this secret to your authenticator app, then enter the code it shows.'}
            </p>
            <div className="copy-row" style={{ marginBottom: 12 }}>
              <code>{totpSetup.secret}</code>
              <button
                className="btn small"
                onClick={() => void navigator.clipboard.writeText(totpSetup.secret)}
              >
                {fa ? 'کپی' : 'Copy'}
              </button>
            </div>
            <div className="copy-row" style={{ marginBottom: 12 }}>
              <code>{totpSetup.uri}</code>
              <button
                className="btn small"
                onClick={() => void navigator.clipboard.writeText(totpSetup.uri)}
              >
                {fa ? 'کپی نشانی' : 'Copy URI'}
              </button>
            </div>
            <div className="row">
              <input
                className="input mono"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                style={{ maxWidth: 140 }}
              />
              <button
                className="btn primary"
                disabled={totpCode.length !== 6}
                onClick={async () => {
                  try {
                    const data = await api.post<{
                      user: typeof user;
                      recoveryCodes: string[];
                    }>('/api/auth/totp/enable', { token: totpCode });
                    setUser(data.user);
                    setRecoveryCodes(data.recoveryCodes);
                    setRecoveryRemaining(data.recoveryCodes.length);
                    setTotpSetup(null);
                    setTotpCode('');
                    toast.success(fa ? 'احراز هویت دومرحله‌ای فعال شد.' : 'Two-factor authentication is on.');
                  } catch (error) {
                    toast.error(error instanceof ApiError ? error.message : (fa ? 'کد پذیرفته نشد.' : 'That code was not accepted.'));
                  }
                }}
              >
                {fa ? 'تأیید و فعال‌سازی' : 'Verify and enable'}
              </button>
              <button className="btn ghost" onClick={() => setTotpSetup(null)}>
                {fa ? 'انصراف' : 'Cancel'}
              </button>
            </div>
          </>
        ) : (
          <button
            className="btn primary"
            onClick={async () => {
              try {
                setTotpSetup(await api.post<{ secret: string; uri: string }>('/api/auth/totp/setup'));
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : (fa ? 'شروع راه‌اندازی انجام نشد.' : 'Could not start setup.'));
              }
            }}
          >
            {fa ? 'راه‌اندازی احراز هویت دومرحله‌ای' : 'Set up two-factor authentication'}
          </button>
        )}

        {user.totpEnabled ? (
          <div className="mt-16">
            {recoveryCodes.length ? (
              <Alert kind="info">
                <strong>{fa ? 'همین حالا کدهای بازیابی را ذخیره کنید.' : 'Save these recovery codes now.'}</strong>{' '}
                {fa ? 'هر کد فقط یک بار قابل استفاده است و دوباره نمایش داده نمی‌شود.' : 'Each code works once and will not be shown again.'}
                <div className="mono" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                  {recoveryCodes.join('\n')}
                </div>
                <button
                  className="btn small mt-16"
                  onClick={() => void navigator.clipboard.writeText(recoveryCodes.join('\n'))}
                >
                  {fa ? 'کپی کدهای بازیابی' : 'Copy recovery codes'}
                </button>
              </Alert>
            ) : (
              <p className="faint small">
                {recoveryRemaining === null
                  ? (fa ? 'وضعیت کدهای بازیابی در دسترس نیست.' : 'Recovery-code status unavailable.')
                  : (fa ? `${recoveryRemaining} کد بازیابی استفاده‌نشده باقی مانده است.` : `${recoveryRemaining} unused recovery code(s) remain.`)}
              </p>
            )}
            <button
              className="btn small"
              onClick={async () => {
                const password = window.prompt(fa ? 'رمز عبور را تأیید کنید:' : 'Confirm your password:');
                if (!password) return;
                const token = window.prompt(fa ? 'کد ۶ رقمی فعلی را وارد کنید:' : 'Enter a current 6-digit authenticator code:');
                if (!token) return;
                try {
                  const data = await api.post<{ recoveryCodes: string[] }>(
                    '/api/auth/totp/recovery-codes/regenerate',
                    { password, token },
                  );
                  setRecoveryCodes(data.recoveryCodes);
                  setRecoveryRemaining(data.recoveryCodes.length);
                  toast.success(fa ? 'کدهای بازیابی جدید ساخته شدند و کدهای قبلی دیگر معتبر نیستند.' : 'New recovery codes generated. Previous codes no longer work.');
                } catch (error) {
                  toast.error(error instanceof ApiError ? error.message : (fa ? 'ساخت دوباره کدها انجام نشد.' : 'Could not regenerate codes.'));
                }
              }}
            >
              {fa ? 'ساخت دوباره کدهای بازیابی' : 'Regenerate recovery codes'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <h3>{fa ? 'فعالیت‌های امنیتی اخیر' : 'Recent security activity'}</h3>
        <p className="desc">{fa ? 'ورودهای جدید و تغییرات حساس حساب را بررسی کنید.' : 'Review new sign-ins and sensitive account changes.'}</p>
        <div className="col">
          {securityEvents.length === 0 ? <span className="faint small">{fa ? 'رویداد امنیتی وجود ندارد.' : 'No security events.'}</span> : null}
          {securityEvents.map((event) => (
            <div
              className="row between"
              key={event.id}
              style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}
            >
              <div>
                <strong className="small">{event.event.replaceAll('.', ' / ')}</strong>
                <div className="faint small">
                  {formatFullTimestamp(event.createdAt)} · {event.ip || (fa ? 'نشانی نامشخص' : 'unknown address')} ·{' '}
                  {shortUserAgent(event.userAgent, fa)}
                </div>
              </div>
              {!event.acknowledgedAt ? (
                <button
                  className="btn small"
                  onClick={async () => {
                    await api.post(`/api/auth/security-events/${event.id}/acknowledge`);
                    loadSecurity();
                  }}
                >
                  {fa ? 'بررسی شد' : 'Acknowledge'}
                </button>
              ) : (
                <span className="badge">{fa ? 'بررسی‌شده' : 'reviewed'}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function AudioPreferencesTab() {
  const user = useSession((state) => state.user)!;
  const fishTtsEnabled = useSession((state) => state.settings?.fish_tts_enabled ?? false);
  const updateProfile = useSession((state) => state.updateProfile);
  const [busy, setBusy] = useState(false);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await updateProfile({ ttsButtonEnabled: enabled });
      toast.success(enabled
        ? (fa ? 'دکمه خواندن پیام فعال شد.' : 'Message speaker button enabled.')
        : (fa ? 'دکمه خواندن پیام غیرفعال شد.' : 'Message speaker button disabled.'));
    } catch (error) {
      toast.error(error instanceof ApiError
        ? error.message
        : (fa ? 'ذخیره تنظیم صدا انجام نشد.' : 'Could not save the audio setting.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-group">
      <h3>{fa ? 'خواندن پیام‌ها' : 'Message text-to-speech'}</h3>
      <p className="desc">
        {fishTtsEnabled
          ? (fa ? 'نمایش دکمه بلندگو را فقط برای حساب خود کنترل کنید.' : 'Control the message speaker button for your own account.')
          : (fa ? 'Fish Audio روی این سرور تنظیم نشده است؛ دکمه بلندگو نمایش داده نمی‌شود.' : 'Fish Audio is not configured on this server, so the speaker button is hidden.')}
      </p>
      <label className="row between" style={{ padding: '10px 0' }}>
        <span>
          <strong>{fa ? 'نمایش دکمه بلندگو کنار پیام‌ها' : 'Show the speaker button on messages'}</strong>
          <span className="faint small" style={{ display: 'block' }}>
            {fa ? 'این انتخاب فقط روی حساب شما اثر دارد.' : 'This preference affects only your account.'}
          </span>
        </span>
        <input
          type="checkbox"
          checked={user.ttsButtonEnabled ?? true}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
      </label>
    </div>
  );
}

function NotificationPreferencesTab() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  useEffect(() => {
    api
      .get<{ preferences: NotificationPreferences; vapidPublicKey: string | null }>(
        '/api/notifications/preferences',
      )
      .then(async (result) => {
        setPreferences(result.preferences);
        setVapidPublicKey(result.vapidPublicKey);
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.getRegistration();
          setPushSubscribed(Boolean(await registration?.pushManager.getSubscription()));
        }
      })
      .catch(() => toast.error(fa ? 'بارگذاری تنظیمات اعلان انجام نشد.' : 'Could not load notification preferences.'));
  }, []);

  async function update(key: keyof NotificationPreferences, value: boolean) {
    if (!preferences) return;
    const previous = preferences;
    setPreferences({ ...preferences, [key]: value });
    try {
      const result = await api.patch<{ preferences: NotificationPreferences }>(
        '/api/notifications/preferences',
        { [key]: value },
      );
      setPreferences(result.preferences);
    } catch {
      setPreferences(previous);
      toast.error(fa ? 'ذخیره تنظیمات اعلان انجام نشد.' : 'Could not save notification preferences.');
    }
  }

  async function togglePushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast.error(fa ? 'این مرورگر از اعلان پوش پشتیبانی نمی‌کند.' : 'Push notifications are not supported by this browser.');
      return;
    }
    if (!vapidPublicKey) {
      toast.error(fa ? 'ارسال پوش روی این سرور پیکربندی نشده است.' : 'Push delivery is not configured on this server.');
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        updateViaCache: 'none',
      });
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await api.del('/api/notifications/push-subscriptions', { endpoint: current.endpoint });
        await current.unsubscribe();
        setPushSubscribed(false);
        toast.success(fa ? 'اعلان پوش در این مرورگر غیرفعال شد.' : 'Browser push notifications disabled.');
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(vapidPublicKey),
        });
        const json = subscription.toJSON();
        await api.post('/api/notifications/push-subscriptions', {
          endpoint: subscription.endpoint,
          keys: json.keys,
        });
        setPushSubscribed(true);
        await update('push', true);
        toast.success(fa ? 'اعلان پوش در این مرورگر فعال شد.' : 'Browser push notifications enabled.');
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'تغییر اشتراک پوش انجام نشد.' : 'Could not change push subscription.'));
    }
  }

  if (!preferences) return <span className="spinner" />;

  const labels: Array<[keyof NotificationPreferences, string, string]> = fa ? [
    ['inApp', 'صندوق اعلان داخل برنامه', 'تاریخچه قابل جست‌وجوی اعلان‌ها را در این حساب نگه دارید.'],
    ['email', 'ایمیل', 'دسته‌های فعال اعلان را به ایمیل شما ارسال می‌کند.'],
    ['push', 'ارسال پوش', 'ارسال به مرورگرها و برنامه‌های وب مشترک‌شده را فعال می‌کند.'],
    ['mentions', 'اشاره‌ها', 'وقتی عضوی به شما اشاره می‌کند، اطلاع می‌دهد.'],
    ['directMessages', 'پیام‌های خصوصی', 'هنگام دریافت پیام خصوصی اطلاع می‌دهد.'],
    ['moderation', 'نظارت', 'درباره گزارش‌ها و اقدامات حساب اطلاع می‌دهد.'],
  ] : [
    ['inApp', 'In-app inbox', 'Keep a searchable notification history in this account.'],
    ['email', 'Email', 'Send enabled notification categories to your email address.'],
    ['push', 'Push delivery', 'Allow delivery to subscribed browsers and mobile web apps.'],
    ['mentions', 'Mentions', 'Notify when another member mentions you.'],
    ['directMessages', 'Direct messages', 'Notify when a direct message arrives.'],
    ['moderation', 'Moderation', 'Notify about reports and account actions.'],
  ];

  return (
    <>
      <p className="muted small">
        {fa ? 'روش دریافت و رویدادهای مهم برای خود را انتخاب کنید.' : 'Choose delivery channels and the events that are important to you.'}
      </p>
      <div className="col mt-16">
        {labels.map(([key, label, description]) => (
          <label className="row between" key={key} style={{ padding: '8px 0' }}>
            <span>
              <strong>{label}</strong>
              <span className="faint small" style={{ display: 'block' }}>
                {description}
              </span>
            </span>
            <input
              type="checkbox"
              checked={preferences[key]}
              onChange={(event) => void update(key, event.target.checked)}
            />
          </label>
        ))}
      </div>
      <button className="btn mt-16" onClick={() => void togglePushSubscription()}>
        {pushSubscribed
          ? (fa ? 'غیرفعال‌کردن پوش در این مرورگر' : 'Disable push on this browser')
          : (fa ? 'فعال‌کردن پوش در این مرورگر' : 'Enable push on this browser')}
      </button>
    </>
  );
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function SessionsTab() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  const load = () =>
    api
      .get<{ sessions: SessionInfo[] }>('/api/auth/sessions')
      .then((data) => setSessions(data.sessions))
      .catch(() => toast.error(fa ? 'بارگذاری نشست‌ها انجام نشد.' : 'Could not load your sessions.'))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <span className="spinner" />;

  return (
    <>
      <p className="muted small">
        {fa ? 'همه دستگاه‌هایی که با حساب شما وارد شده‌اند. نشست‌های ناشناس را لغو کنید.' : 'Every device that is signed in as you. Revoke anything you do not recognise.'}
      </p>

      <div className="col mt-16">
        {sessions
          .filter((session) => session.active)
          .map((session) => (
            <div className="row between" key={session.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 0 }}>
                <div className="small">
                  {session.current ? <span className="badge moderator">{fa ? 'این دستگاه' : 'this device'}</span> : null}{' '}
                  {shortUserAgent(session.userAgent, fa)}
                </div>
                <div className="faint small">
                  {session.ip || (fa ? 'نشانی نامشخص' : 'unknown address')} ·
                  {fa ? ' آخرین استفاده ' : ' last used '}{formatRelative(session.lastUsedAt)} ·
                  {fa ? ' انقضا ' : ' expires '}{formatFullTimestamp(session.expiresAt)}
                </div>
              </div>
              {!session.current ? (
                <button
                  className="btn small danger"
                  onClick={async () => {
                    await api.del(`/api/auth/sessions/${session.id}`);
                    void load();
                  }}
                >
                  {fa ? 'لغو' : 'Revoke'}
                </button>
              ) : null}
            </div>
          ))}
      </div>

      <button
        className="btn danger mt-16"
        onClick={async () => {
          const result = await api.post<{ revoked: number }>('/api/auth/sessions/revoke-others');
          toast.success(fa ? `از ${result.revoked} دستگاه دیگر خارج شدید.` : `Signed out of ${result.revoked} other device(s).`);
          void load();
        }}
      >
        {fa ? 'خروج از همه دستگاه‌های دیگر' : 'Sign out everywhere else'}
      </button>
    </>
  );
}

function shortUserAgent(raw: string | null, fa = false): string {
  if (!raw) return fa ? 'دستگاه ناشناس' : 'Unknown device';
  const browser =
    /Edg\//.test(raw) ? 'Edge'
    : /Chrome\//.test(raw) ? 'Chrome'
    : /Firefox\//.test(raw) ? 'Firefox'
    : /Safari\//.test(raw) ? 'Safari'
    : 'Browser';
  const platform =
    /Windows/.test(raw) ? 'Windows'
    : /Android/.test(raw) ? 'Android'
    : /iPhone|iPad/.test(raw) ? 'iOS'
    : /Mac OS/.test(raw) ? 'macOS'
    : /Linux/.test(raw) ? 'Linux'
    : '';
  return platform ? (fa ? `${browser} در ${platform}` : `${browser} on ${platform}`) : browser;
}
