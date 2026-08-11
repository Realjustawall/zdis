import { useCallback, useEffect, useState } from 'react';
import { Avatar, Modal, Confirm, Alert, ErrorList, RoleBadge, Spinner, EmptyState } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatBytes, formatFullTimestamp, formatRelative } from '../lib/format';
import { toast } from '../store/toast';
import { useSession } from '../store/session';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { AdminPlatform } from './AdminPlatform';
import { AdminAnalytics } from './AdminAnalytics';
import { Icon, type IconName } from '../components/Icon';
import type {
  AdminSettings,
  AdminUser,
  AuditLog,
  Badge,
  Group,
  LinkedAccount,
  PlatformRole,
  SessionInfo,
} from '../types';

type Tab =
  | 'overview'
  | 'users'
  | 'groups'
  | 'moderation'
  | 'roles'
  | 'integrations'
  | 'operations'
  | 'platform'
  | 'settings'
  | 'audit';

interface Overview {
  users: number;
  groups: number;
  messages: number;
  attachments: number;
  attachmentBytes: number;
  activeSessions: number;
  openReports: number;
  openDeadLetters: number;
  roles: Record<string, number>;
  runtime: {
    database: string;
    cache: string;
    uptimeSeconds: number;
    node: string;
    appName: string;
    region: string;
    role: string;
    writes: boolean;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
    sockets: number;
  };
}

const TAB_META: Record<Tab, { label: string; description: string; icon: IconName }> = {
  overview: { label: 'داشبورد', description: 'نمای زنده و خلاصه مدیریتی', icon: 'chart' },
  users: { label: 'کاربران', description: 'حساب‌ها، نشست‌ها و دسترسی‌ها', icon: 'users' },
  groups: { label: 'فضاها', description: 'گروه‌ها و کانال‌های سامانه', icon: 'home' },
  moderation: { label: 'نظارت', description: 'گزارش‌ها، اعتراض‌ها و محدودیت‌ها', icon: 'flag' },
  roles: { label: 'نقش‌ها و دسترسی', description: 'RBAC و مجوزهای سفارشی', icon: 'tag' },
  integrations: { label: 'یکپارچه‌سازی', description: 'API، ربات و Webhook', icon: 'link' },
  operations: { label: 'عملیات و سلامت', description: 'سرویس‌ها، صف‌ها و خطاها', icon: 'system' },
  platform: { label: 'زیرساخت سازمانی', description: 'SSO، SMTP، Backup، Storage، Queue و Flag', icon: 'shield' },
  settings: { label: 'تنظیمات', description: 'پیکربندی زنده سامانه', icon: 'settings' },
  audit: { label: 'ردپای امنیتی', description: 'Audit تغییرناپذیر و خروجی', icon: 'lock' },
};

export function Admin({ onExit }: { onExit: () => void }) {
  const user = useSession((state) => state.user)!;
  const fullAdmin = user.role === 'admin' || user.badges.some((badge) => badge.id === 'admin');
  const [tab, setTab] = useState<Tab>(fullAdmin ? 'overview' : 'moderation');

  const tabs: Tab[] = fullAdmin
    ? ['overview', 'users', 'groups', 'moderation', 'roles', 'integrations', 'operations', 'platform', 'settings', 'audit']
    : ['moderation'];

  return (
    <div className="admin admin-fa" dir="rtl" lang="fa">
      <nav className="admin-nav">
        <div className="admin-brand">
          <span className="admin-brand-mark">S</span>
          <span>
            <strong>مرکز فرماندهی</strong>
            <small>مدیریت سازمانی</small>
          </span>
        </div>
        <div className="admin-nav-label">مدیریت سامانه</div>
        {tabs.map((id) => (
          <button
            key={id}
            className={`nav-item${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
            aria-label={TAB_META[id].label}
            title={TAB_META[id].label}
          >
            <span className="glyph"><Icon name={TAB_META[id].icon} size={19} /></span>
            <span className="label">
              <strong>{TAB_META[id].label}</strong>
              <small>{TAB_META[id].description}</small>
            </span>
          </button>
        ))}
        <div className="admin-nav-theme">
          <span>پوسته نمایش</span>
          <ThemeSwitcher />
        </div>
        <button className="nav-item back" onClick={onExit}>
          <span className="glyph"><Icon name="arrowLeft" size={19} /></span>
          <span className="label"><strong>بازگشت به گفتگو</strong></span>
        </button>
      </nav>

      <main className="admin-main">
        <header className="admin-topbar">
          <div>
            <h1>{TAB_META[tab].label}</h1>
            <p>{TAB_META[tab].description}</p>
          </div>
          <div className="admin-top-actions">
            <span className="live-chip"><i /> سامانه آنلاین</span>
            <ThemeSwitcher compact />
            <Avatar name={user.displayName} id={user.id} src={user.avatarUrl} size={36} />
          </div>
        </header>
        {tab === 'overview' ? <><OverviewTab /><AdminAnalytics /></> : null}
        {tab === 'users' ? <UsersTab /> : null}
        {tab === 'groups' ? <GroupsTab /> : null}
        {tab === 'moderation' ? <ModerationTab /> : null}
        {tab === 'roles' ? <RolesTab /> : null}
        {tab === 'integrations' ? <IntegrationsTab /> : null}
        {tab === 'operations' ? <OperationsTab /> : null}
        {tab === 'platform' ? <AdminPlatform /> : null}
        {tab === 'settings' ? <SettingsTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}
      </main>
    </div>
  );
}

function OverviewTab() {
  const [data, setData] = useState<Overview | null>(null);
  const [purging, setPurging] = useState(false);

  useEffect(() => {
    void api.get<Overview>('/api/admin/overview').then(setData).catch(() => {});
  }, []);

  if (!data) return <Spinner label="در حال بارگذاری داشبورد…" />;

  const uptimeHours = Math.floor(data.runtime.uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((data.runtime.uptimeSeconds % 3600) / 60);

  return (
    <>
      <section className="admin-hero">
        <div>
          <span className="eyebrow">مرکز کنترل زنده</span>
          <h2>همه‌چیز تحت کنترل است.</h2>
          <p>وضعیت کاربران، محتوا، امنیت و زیرساخت را از یک نقطه مدیریت کنید.</p>
        </div>
        <div className="hero-status">
          <span className="pulse-orb" />
          <strong>{data.runtime.region}</strong>
          <small>{data.runtime.role} · {data.runtime.writes ? 'خواندن و نوشتن' : 'فقط خواندنی'}</small>
        </div>
      </section>

      <div className="stat-grid stat-grid-premium">
        <Stat value={data.users} label="کل کاربران" icon="users" tone="violet" />
        <Stat value={data.activeSessions} label="نشست‌های فعال" icon="system" tone="blue" />
        <Stat value={data.messages} label="پیام‌های سالم" icon="message" tone="green" />
        <Stat value={data.openReports} label="گزارش باز" icon="flag" tone={data.openReports ? 'orange' : 'green'} />
        <Stat value={data.openDeadLetters} label="خطای تحویل" icon="close" tone={data.openDeadLetters ? 'red' : 'green'} />
        <Stat value={formatBytes(data.attachmentBytes)} label="فضای رسانه" icon="archive" tone="cyan" />
      </div>

      <div className="admin-dashboard-grid">
      <div className="settings-group admin-card">
        <h3>توزیع نقش‌های سازمانی</h3>
        <p className="desc">تعداد حساب‌های فعال در هر سطح دسترسی</p>
        <div className="row wrap">
          {(['admin', 'youtuber', 'member'] as PlatformRole[]).map((role) => (
            <span key={role} className="row" style={{ gap: 6 }}>
              <RoleBadge role={role} />
              <strong>{data.roles[role] ?? 0}</strong>
            </span>
          ))}
        </div>
        </div>

      <div className="settings-group admin-card">
        <h3>سلامت Runtime</h3>
        <p className="desc">مصرف حافظه و اجزای فعال این نمونه</p>
        <div className="runtime-meters">
          <RuntimeMeter
            label="Heap جاوااسکریپت"
            value={data.runtime.memory.heapUsed}
            total={Math.max(data.runtime.memory.heapTotal, data.runtime.memory.heapUsed)}
          />
          <RuntimeMeter
            label="حافظه RSS"
            value={data.runtime.memory.rss}
            total={Math.max(data.runtime.memory.rss * 1.5, 512 * 1024 * 1024)}
          />
        </div>
        <div className="row wrap runtime-facts">
          <span>
            <span className="faint small">پایگاه‌داده</span>
            <br />
            <strong>{data.runtime.database}</strong>
          </span>
          <span>
            <span className="faint small">کش</span>
            <br />
            <strong>{data.runtime.cache}</strong>
          </span>
          <span>
            <span className="faint small">نسخه Node</span>
            <br />
            <strong>{data.runtime.node}</strong>
          </span>
          <span>
            <span className="faint small">زمان فعالیت</span>
            <br />
            <strong>
              {uptimeHours} ساعت و {uptimeMinutes} دقیقه
            </strong>
          </span>
          <span>
            <span className="faint small">اتصال زنده</span>
            <br />
            <strong>{data.runtime.sockets.toLocaleString('fa-IR')}</strong>
          </span>
        </div>
        <button
          className="btn mt-16"
          disabled={purging}
          onClick={async () => {
            setPurging(true);
            try {
              const result = await api.post<{ sessions: number; attachments: number }>(
                '/api/admin/maintenance/purge',
              );
              toast.success(
                `${result.sessions} نشست منقضی و ${result.attachments} فایل بدون مرجع پاک شد.`,
              );
            } catch {
              toast.error('عملیات نگهداری ناموفق بود.');
            } finally {
              setPurging(false);
            }
          }}
        >
          {purging ? 'در حال اجرا…' : 'اجرای پاک‌سازی هوشمند'}
        </button>
      </div>
      </div>
    </>
  );
}

function Stat({
  value,
  label,
  icon,
  tone = 'violet',
}: {
  value: number | string;
  label: string;
  icon?: IconName;
  tone?: 'violet' | 'blue' | 'green' | 'orange' | 'red' | 'cyan';
}) {
  return (
    <div className={`stat-card tone-${tone}`}>
      {icon ? <span className="stat-icon"><Icon name={icon} size={20} /></span> : null}
      <div className="value">{typeof value === 'number' ? value.toLocaleString('fa-IR') : value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function RuntimeMeter({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = Math.max(1, Math.min(100, Math.round((value / total) * 100)));
  return (
    <div className="runtime-meter">
      <div className="row between">
        <span>{label}</span>
        <strong>{formatBytes(value)}</strong>
      </div>
      <div className="meter-track"><i style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

function UsersTab() {
  const me = useSession((state) => state.user)!;
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [moderating, setModerating] = useState<AdminUser | null>(null);
  const [viewingSessions, setViewingSessions] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const data = await api.get<{ users: AdminUser[] }>(
        `/api/admin/users${term ? `?search=${encodeURIComponent(term)}` : ''}`,
      );
      setUsers(data.users);
    } catch {
      toast.error('Could not load accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(search), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search, load]);

  return (
    <>
      <h2 className="section-title">مدیریت متمرکز کاربران</h2>
      <p className="sub">
        ساخت، ویرایش، تعلیق، بازیابی و کنترل نشست تمام حساب‌های سامانه.
      </p>

      <div className="toolbar">
        <input
          className="input grow"
          placeholder="جست‌وجو با نام، نام کاربری یا ایمیل…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="add" size={17} /> ساخت حساب جدید
        </button>
      </div>

      {loading ? (
        <Spinner label="در حال دریافت کاربران…" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>حساب</th>
                <th>نقش پایه</th>
                <th>وضعیت</th>
                <th>آخرین ورود</th>
                <th>آخرین IP ورود</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="identity">
                      <Avatar name={user.displayName} id={user.id} color={user.bannerColor} size={32} />
                      <div className="who">
                        <div className="name">{user.displayName}</div>
                        <div className="sub">
                          @{user.username} · {user.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <RoleBadge role={user.role} />
                  </td>
                  <td>
                    {user.bannedAt ? (
                      <span className="badge admin">مسدود</span>
                    ) : !user.isActive ? (
                      <span className="badge admin">غیرفعال</span>
                    ) : user.lockedUntil && user.lockedUntil > Date.now() ? (
                      <span className="badge owner">قفل‌شده</span>
                    ) : user.mustChangePassword ? (
                      <span className="badge">نیازمند تغییر رمز</span>
                    ) : (
                      <span className="badge moderator">فعال</span>
                    )}
                    {user.totpEnabled ? <span className="badge" style={{ marginLeft: 4 }}>2FA</span> : null}
                  </td>
                  <td className="faint small nowrap">{formatRelative(user.lastLoginAt)}</td>
                  <td className="faint small nowrap mono">{user.lastLoginIp ?? '—'}</td>
                  <td className="actions">
                    <button className="btn small" onClick={() => setEditing(user)}>
                      ویرایش
                    </button>
                    <button className="btn small" onClick={() => setViewingSessions(user)}>
                      نشست‌ها
                    </button>
                    <button className="btn small" onClick={() => setResetting(user)}>
                      تغییر رمز
                    </button>
                    {user.id !== me.id ? (
                      <>
                        <button
                          className={`btn small${user.bannedAt ? '' : ' danger'}`}
                          onClick={() => setModerating(user)}
                        >
                          {user.bannedAt ? 'رفع مسدودی' : 'مسدودکردن'}
                        </button>
                        <button className="btn small danger" onClick={() => setDeleting(user)}>
                          حذف
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load(search);
          }}
        />
      ) : null}

      {editing ? (
        <EditUserModal
          user={editing}
          isSelf={editing.id === me.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load(search);
          }}
        />
      ) : null}

      {resetting ? (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            void load(search);
          }}
        />
      ) : null}

      {moderating ? (
        <ModerateUserModal
          user={moderating}
          onClose={() => setModerating(null)}
          onDone={() => {
            setModerating(null);
            void load(search);
          }}
        />
      ) : null}

      {viewingSessions ? (
        <UserSessionsModal user={viewingSessions} onClose={() => setViewingSessions(null)} />
      ) : null}

      {deleting ? (
        <Confirm
          title={`حذف ${deleting.displayName}؟`}
          danger
          busy={busy}
          confirmLabel="حذف دائمی حساب"
          message={
            <>
              <p>
                حساب <strong>@{deleting.username}</strong>، تمام نشست‌ها و گروه‌های تحت مالکیت او
                همراه با پیام‌ها و فایل‌های آن گروه‌ها برای همیشه حذف می‌شود.
              </p>
              <p className="muted small">
                پیام‌های ارسال‌شده در فضاهای دیگر باقی می‌مانند، اما اطلاعات نویسنده حذف می‌شود.
              </p>
            </>
          }
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              const result = await api.del<{ deletedGroups: number }>(`/api/admin/users/${deleting.id}`);
              toast.success(
                result.deletedGroups > 0
                  ? `Account deleted along with ${result.deletedGroups} owned group(s).`
                  : 'Account deleted.',
              );
              setDeleting(null);
              void load(search);
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not delete the account.');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </>
  );
}

function ModerateUserModal({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = user.bannedAt ? 'unban' : 'ban';
  const [reason, setReason] = useState(
    user.bannedAt ? 'رفع مسدودی توسط مدیر سامانه' : '',
  );
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title={user.bannedAt ? `رفع مسدودی ${user.displayName}` : `مسدودکردن ${user.displayName}`}
      description={
        user.bannedAt
          ? 'کاربر دوباره امکان ورود به سامانه را خواهد داشت.'
          : 'تمام نشست‌های فعال کاربر فوراً بسته می‌شود و امکان ورود نخواهد داشت.'
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>انصراف</button>
          <button
            className={`btn ${action === 'ban' ? 'danger' : 'primary'}`}
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/moderation/users/${user.id}/actions`, {
                  action,
                  reason: reason.trim(),
                });
                toast.success(action === 'ban' ? 'حساب مسدود شد.' : 'مسدودی حساب برداشته شد.');
                onDone();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'عملیات انجام نشد.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'در حال انجام…' : action === 'ban' ? 'مسدودکردن حساب' : 'رفع مسدودی'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>دلیل اقدام</label>
        <textarea
          className="textarea"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          placeholder="دلیل را برای گزارش مدیریتی بنویسید…"
        />
      </div>
      {user.moderationReason ? (
        <Alert kind="info">دلیل فعلی: {user.moderationReason}</Alert>
      ) : null}
    </Modal>
  );
}

function UserSessionsModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api
      .get<{ sessions: SessionInfo[] }>(`/api/admin/users/${user.id}/sessions`)
      .then((result) => setSessions(result.sessions))
      .catch((error) =>
        toast.error(error instanceof ApiError ? error.message : 'دریافت نشست‌ها انجام نشد.'),
      )
      .finally(() => setLoading(false));
  }, [user.id]);

  return (
    <Modal title={`نشست‌های ${user.displayName}`} onClose={onClose} wide>
      <div className="stat-card">
        <div className="row between">
          <span>آخرین IP ورود</span>
          <code>{user.lastLoginIp ?? 'ثبت نشده'}</code>
        </div>
        <div className="row between mt-16">
          <span>آخرین ورود موفق</span>
          <strong>{user.lastLoginAt ? formatFullTimestamp(user.lastLoginAt) : 'ثبت نشده'}</strong>
        </div>
      </div>
      {loading ? (
        <Spinner label="در حال دریافت نشست‌ها…" />
      ) : sessions.length ? (
        <div className="table-wrap mt-16">
          <table>
            <thead>
              <tr>
                <th>وضعیت</th>
                <th>IP</th>
                <th>دستگاه / مرورگر</th>
                <th>آخرین فعالیت</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <span className={`badge ${session.active ? 'moderator' : ''}`}>
                      {session.active ? 'فعال' : 'پایان‌یافته'}
                    </span>
                  </td>
                  <td><code>{session.ip ?? '—'}</code></td>
                  <td className="small">{session.userAgent ?? 'ناشناخته'}</td>
                  <td className="faint small nowrap">{formatRelative(session.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={<Icon name="lock" size={34} />} title="نشستی ثبت نشده است" />
      )}
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    email: '',
    username: '',
    displayName: '',
    password: '',
    role: 'member' as PlatformRole,
    mustChangePassword: true,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function suggest() {
    const data = await api.get<{ password: string }>('/api/admin/users/suggest-password');
    set('password', data.password);
  }

  async function submit() {
    setErrors([]);
    setBusy(true);
    try {
      await api.post('/api/admin/users', form);
      setCreated({ email: form.email, password: form.password });
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : ['Could not create the account.']);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal
        title="حساب با موفقیت ساخته شد"
        onClose={onCreated}
        footer={
          <button className="btn primary" onClick={onCreated}>
            پایان
          </button>
        }
      >
        <Alert kind="success">
          این اطلاعات را فقط از یک مسیر امن برای صاحب حساب ارسال کنید. رمز دوباره نمایش داده نمی‌شود.
        </Alert>
        <div className="field">
          <label>ایمیل</label>
          <div className="copy-row">
            <code>{created.email}</code>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(created.email)}>
              کپی
            </button>
          </div>
        </div>
        <div className="field">
          <label>رمز عبور موقت</label>
          <div className="copy-row">
            <code>{created.password}</code>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(created.password)}>
              کپی
            </button>
          </div>
        </div>
        {form.mustChangePassword ? (
          <p className="muted small">کاربر پیش از ورود کامل باید رمز شخصی خود را انتخاب کند.</p>
        ) : null}
        <div style={{ height: 12 }} />
      </Modal>
    );
  }

  return (
    <Modal
      title="ساخت حساب جدید"
      description="ثبت‌نام عمومی بسته است؛ اطلاعات ورود را مدیر سامانه ایجاد می‌کند."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            انصراف
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'در حال ساخت…' : 'ساخت حساب'}
          </button>
        </>
      }
    >
      {errors.length ? <ErrorList lines={errors} /> : null}

      <div className="grid-2">
        <div className="field">
          <label htmlFor="cu-display">نام نمایشی</label>
          <input
            id="cu-display"
            className="input"
            value={form.displayName}
            onChange={(event) => set('displayName', event.target.value)}
            placeholder="Sam Rivera"
          />
        </div>
        <div className="field">
          <label htmlFor="cu-username">نام کاربری</label>
          <input
            id="cu-username"
            className="input"
            value={form.username}
            onChange={(event) => set('username', event.target.value.toLowerCase())}
            placeholder="sam"
          />
          <span className="hint">حروف لاتین کوچک، عدد، نقطه، خط تیره و زیرخط.</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="cu-email">ایمیل</label>
        <input
          id="cu-email"
          className="input"
          type="email"
          value={form.email}
          onChange={(event) => set('email', event.target.value)}
          placeholder="sam@example.com"
        />
      </div>

      <div className="field">
        <label htmlFor="cu-role">نقش پایه</label>
        <select
          id="cu-role"
          className="select"
          value={form.role}
          onChange={(event) => set('role', event.target.value as PlatformRole)}
        >
          <option value="member">عضو — حضور در گروه‌های دعوت‌شده</option>
          <option value="youtuber">سازنده — ساخت گروه و مدیریت تیم</option>
          <option value="admin">مدیر — دسترسی کامل به مرکز فرماندهی</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="cu-password">رمز عبور موقت</label>
        <div className="row">
          <input
            id="cu-password"
            className="input mono"
            value={form.password}
            onChange={(event) => set('password', event.target.value)}
          />
          <button className="btn nowrap" type="button" onClick={suggest}>
            تولید امن
          </button>
        </div>
        <span className="hint">
          حداقل ۱۰ نویسه شامل حرف بزرگ، حرف کوچک، عدد و نماد.
        </span>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.mustChangePassword}
          onChange={(event) => set('mustChangePassword', event.target.checked)}
        />
        <span>الزام تغییر رمز در اولین ورود</span>
      </label>
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function EditUserModal({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    displayName: user.displayName,
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [badgeCatalogue, setBadgeCatalogue] = useState<Badge[]>([]);
  const [primaryBadgeIds, setPrimaryBadgeIds] = useState(
    user.badges.filter((badge) => badge.kind === 'primary').map((badge) => badge.id),
  );
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);

  useEffect(() => {
    void Promise.all([
      api.get<{ badges: Badge[] }>('/api/admin/badges'),
      api.get<{ linkedAccounts: LinkedAccount[] }>(`/api/network/linked-accounts/${user.id}`),
    ]).then(([badgeData, linkData]) => {
      setBadgeCatalogue(badgeData.badges.filter((badge) => badge.kind === 'primary'));
      setLinkedAccounts(linkData.linkedAccounts);
    });
  }, [user.id]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setErrors([]);
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${user.id}`, form);
      await api.put(`/api/admin/users/${user.id}/badges`, { badgeIds: primaryBadgeIds });
      toast.success('حساب با موفقیت به‌روزرسانی شد.');
      onSaved();
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : ['Could not save.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`ویرایش ${user.displayName}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            انصراف
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'در حال ذخیره…' : 'ذخیره تغییرات'}
          </button>
        </>
      }
    >
      {errors.length ? <ErrorList lines={errors} /> : null}

      <div className="grid-2">
        <div className="field">
          <label>نام نمایشی</label>
          <input
            className="input"
            value={form.displayName}
            onChange={(event) => set('displayName', event.target.value)}
          />
        </div>
        <div className="field">
          <label>نام کاربری</label>
          <input
            className="input"
            value={form.username}
            onChange={(event) => set('username', event.target.value.toLowerCase())}
          />
        </div>
      </div>

      <div className="field">
        <label>ایمیل</label>
        <input
          className="input"
          type="email"
          value={form.email}
          onChange={(event) => set('email', event.target.value)}
        />
      </div>

      <div className="field">
        <label>نقش پایه</label>
        <select
          className="select"
          value={form.role}
          onChange={(event) => {
            const role = event.target.value as PlatformRole;
            set('role', role);
            setPrimaryBadgeIds((current) => [
              ...current.filter((id) => !['admin', 'streamer'].includes(id)),
              ...(role === 'admin' ? ['admin'] : role === 'youtuber' ? ['streamer'] : []),
            ]);
          }}
          disabled={isSelf}
        >
          <option value="member">عضو</option>
          <option value="youtuber">سازنده</option>
          <option value="admin">مدیر</option>
        </select>
        {isSelf ? <span className="hint">نمی‌توانید نقش پایه خودتان را تغییر دهید.</span> : null}
      </div>

      <div className="field">
        <label>نشان‌های هویتی و دسترسی</label>
        <div className="row wrap">
          {badgeCatalogue.map((badge) => (
            <label className="checkbox" key={badge.id}>
              <input
                type="checkbox"
                checked={primaryBadgeIds.includes(badge.id)}
                disabled={isSelf && badge.id === 'admin'}
                onChange={(event) =>
                  setPrimaryBadgeIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, badge.id])]
                      : current.filter((id) => id !== badge.id),
                  )
                }
              />
              <span style={{ color: badge.color }}>{badge.label}</span>
            </label>
          ))}
        </div>
        <span className="hint">
          نشان‌های مدیر، پشتیبان، توسعه‌دهنده و سازنده مجوزهای سطح سامانه می‌دهند.
        </span>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(event) => set('isActive', event.target.checked)}
          disabled={isSelf}
        />
        <span>
          حساب فعال باشد
          <br />
          <span className="hint">غیرفعال‌سازی فوراً تمام نشست‌های کاربر را می‌بندد.</span>
        </span>
      </label>

      {linkedAccounts.length ? (
        <div className="field">
          <label>پروفایل‌های متصل</label>
          <div className="col">
            {linkedAccounts.map((account) => (
              <div className="row between" key={account.id}>
                <span>
                  {account.platform} · {account.handle}
                </span>
                <button
                  className={`btn small${account.verified ? ' danger' : ''}`}
                  onClick={async () => {
                    const result = await api.patch<{ linkedAccount: LinkedAccount }>(
                      `/api/admin/linked-accounts/${account.id}/verification`,
                      { verified: !account.verified },
                    );
                    setLinkedAccounts((current) =>
                      current.map((item) =>
                        item.id === account.id ? result.linkedAccount : item,
                      ),
                    );
                  }}
                >
                  {account.verified ? 'لغو تأیید' : 'تأیید'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="section-label" style={{ padding: '18px 0 6px' }}>
        عملیات امنیتی
      </div>
      <div className="row wrap">
        <button
          className="btn small"
          onClick={async () => {
            await api.post(`/api/admin/users/${user.id}/logout`);
            toast.success('تمام نشست‌های کاربر باطل شد.');
          }}
        >
          خروج اجباری از همه دستگاه‌ها
        </button>
        <button
          className="btn small"
          onClick={async () => {
            await api.post(`/api/admin/users/${user.id}/unlock`);
            toast.success('قفل ورود برداشته شد.');
            onSaved();
          }}
        >
          بازکردن قفل ورود
        </button>
        {user.totpEnabled ? (
          <button
            className="btn small danger"
            onClick={async () => {
              await api.post(`/api/admin/users/${user.id}/disable-2fa`);
              toast.success('احراز هویت دومرحله‌ای بازنشانی شد.');
              onSaved();
            }}
          >
            بازنشانی 2FA
          </button>
        ) : null}
      </div>
      <p className="faint small mt-16">
        ساخته‌شده در {formatFullTimestamp(user.createdAt)} · {user.failedLogins.toLocaleString('fa-IR')} ورود ناموفق
      </p>
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function suggest() {
    const data = await api.get<{ password: string }>('/api/admin/users/suggest-password');
    setPassword(data.password);
  }

  useEffect(() => {
    void suggest();
  }, []);

  async function submit() {
    setErrors([]);
    setBusy(true);
    try {
      await api.post(`/api/admin/users/${user.id}/password`, {
        password,
        mustChange,
        revokeSessions: true,
      });
      setDone(true);
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : ['Could not reset the password.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`بازنشانی رمز ${user.displayName}`}
      description="با تأیید عملیات، تمام نشست‌های فعلی کاربر باطل می‌شوند."
      onClose={done ? onDone : onClose}
      footer={
        done ? (
          <button className="btn primary" onClick={onDone}>
            پایان
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              انصراف
            </button>
            <button className="btn primary" onClick={submit} disabled={busy || !password}>
              {busy ? 'در حال بازنشانی…' : 'بازنشانی رمز'}
            </button>
          </>
        )
      }
    >
      {errors.length ? <ErrorList lines={errors} /> : null}
      {done ? (
        <Alert kind="success">رمز بازنشانی شد؛ آن را فقط از یک مسیر امن ارسال کنید.</Alert>
      ) : null}

      <div className="field">
        <label>رمز جدید</label>
        <div className="row">
          <input
            className="input mono"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={done}
          />
          {done ? (
            <button className="btn nowrap" onClick={() => void navigator.clipboard.writeText(password)}>
              کپی
            </button>
          ) : (
            <button className="btn nowrap" onClick={suggest}>
              تولید امن
            </button>
          )}
        </div>
      </div>

      {!done ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={mustChange}
            onChange={(event) => setMustChange(event.target.checked)}
          />
          <span>الزام انتخاب رمز شخصی در ورود بعدی</span>
        </label>
      ) : null}
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Group | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ groups: Group[] }>('/api/admin/groups');
      setGroups(data.groups);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h2 className="section-title">فضاها و گروه‌ها</h2>
      <p className="sub">مدیریت تمام فضاهای عمومی و خصوصی سامانه از یک نمای واحد.</p>

      {loading ? (
        <Spinner label="در حال دریافت گروه‌ها…" />
      ) : groups.length === 0 ? (
        <EmptyState icon={<Icon name="home" size={34} />} title="هنوز گروهی ساخته نشده">
          گروه‌های ساخته‌شده در این بخش نمایش داده می‌شوند.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>گروه</th>
                <th>مالک</th>
                <th>اعضا</th>
                <th>کانال‌ها</th>
                <th>Discovery</th>
                <th>ساخته‌شده</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <div className="identity">
                      <Avatar name={group.name} id={group.id} color={group.accentColor} size={30} />
                      <div className="who">
                        <div className="name">{group.name}</div>
                        <div className="sub">/{group.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className="small">{group.ownerDisplayName ?? '—'}</td>
                  <td>{group.memberCount ?? 0}</td>
                  <td>{group.channelCount ?? 0}</td>
                  <td>
                    {group.discoverable ? <span className="badge success">Verified</span>
                      : group.discoveryRequested ? <span className="badge warning">Pending</span>
                        : <span className="faint">Private</span>}
                  </td>
                  <td className="faint small nowrap">{formatRelative(group.createdAt)}</td>
                  <td className="actions">
                    {group.discoveryRequested ? (
                      <>
                        <button className="btn small" onClick={async () => {
                          await api.patch(`/api/admin/groups/${group.id}/discovery`, { approved: true });
                          toast.success('Discovery listing approved.');
                          void load();
                        }}>Approve</button>
                        <button className="btn small" onClick={async () => {
                          await api.patch(`/api/admin/groups/${group.id}/discovery`, { approved: false });
                          void load();
                        }}>Reject</button>
                      </>
                    ) : null}
                    <button className="btn small danger" onClick={() => setDeleting(group)}>
                      حذف
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleting ? (
        <Confirm
          title={`حذف گروه ${deleting.name}؟`}
          danger
          confirmLabel="حذف دائمی گروه"
          message="تمام کانال‌ها، پیام‌ها و فایل‌های این گروه برای همیشه حذف می‌شوند."
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.del(`/api/admin/groups/${deleting.id}`);
              toast.success('گروه حذف شد.');
              setDeleting(null);
              void load();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not delete.');
            }
          }}
        />
      ) : null}
    </>
  );
}

interface ModerationReport {
  id: string;
  messageId: string;
  reporterId: string;
  reporterUsername: string;
  authorId: string;
  authorUsername: string | null;
  reason: string;
  details: string | null;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  resolution: string | null;
  messagePreview: string;
  createdAt: number;
  priority: 'normal' | 'high';
  slaDueAt: number | null;
  evidence: { hash: string; content: string; attachments: Array<{ id: string; filename: string; mime: string; size: number }> } | null;
}

function evidenceBytes(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ReportEvidence({ evidence }: { evidence: NonNullable<ModerationReport['evidence']> }) {
  let readable = evidence.content;
  let secureFiles: Array<{ id: string; name: string; mime: string; key: string; iv: string }> = [];
  try {
    const payload = JSON.parse(evidence.content);
    if (payload?.v === 1 && payload.kind === 'poll') {
      readable = `${payload.poll.question}\n${payload.poll.options.map((option: string, index: number) => `${index + 1}. ${option}`).join('\n')}`;
    } else if (payload?.v === 1 && typeof payload.text === 'string') {
      readable = payload.text;
      secureFiles = Array.isArray(payload.attachments) ? payload.attachments : [];
    }
  } catch { /* ordinary reported text */ }
  const secureIds = new Set(secureFiles.map((file) => file.id));
  return <div className="moderation-evidence-card">
    <p>{readable || '(media-only message)'}</p>
    <div className="row wrap">{secureFiles.map((file) => <button className="btn small" key={file.id} onClick={async () => {
      try {
        const response = await fetch(`/api/files/${file.id}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('download failed');
        const stored = new Uint8Array(await response.arrayBuffer());
        const key = await crypto.subtle.importKey('raw', evidenceBytes(file.key), 'AES-GCM', false, ['decrypt']);
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: evidenceBytes(file.iv) }, key, stored.subarray(8));
        const url = URL.createObjectURL(new Blob([clear], { type: file.mime }));
        const link = document.createElement('a'); link.href = url; link.download = file.name; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch { toast.error('Could not decrypt reported media.'); }
    }}>🔓 {file.name}</button>)}
    {evidence.attachments.filter((file) => !secureIds.has(file.id)).map((file) =>
      <a className="btn small" key={file.id} href={`/api/files/${file.id}`} target="_blank" rel="noreferrer">📎 {file.filename} · {formatBytes(file.size)}</a>)}</div>
  </div>;
}

interface ModerationAppeal {
  id: string;
  username: string;
  action: string;
  reason: string;
  action_reason: string;
  status: 'open' | 'approved' | 'denied';
  created_at: number;
}

interface UserReport {
  id: string;
  reportedUserId: string;
  reportedUsername: string;
  reportedDisplayName: string;
  reporterUsername: string;
  reason: string;
  details: string | null;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  createdAt: number;
}

function ModerationTab() {
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [status, setStatus] = useState('open');
  const [loading, setLoading] = useState(true);
  const [appeals, setAppeals] = useState<ModerationAppeal[]>([]);
  const [userReports, setUserReports] = useState<UserReport[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ reports: ModerationReport[] }>(
        `/api/moderation/reports?status=${encodeURIComponent(status)}`,
      );
      setReports(data.reports);
      const appealData = await api.get<{ appeals: ModerationAppeal[] }>(
        '/api/moderation/appeals?status=open',
      );
      setAppeals(appealData.appeals);
      const userReportData = await api.get<{ reports: UserReport[] }>(
        `/api/moderation/user-reports?status=${encodeURIComponent(status)}`,
      );
      setUserReports(userReportData.reports);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load reports.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function updateReport(id: string, nextStatus: ModerationReport['status']) {
    await api.patch(`/api/moderation/reports/${id}`, {
      status: nextStatus,
      assignedToMe: nextStatus === 'reviewing',
    });
    toast.success('Report updated.');
    await load();
  }

  async function updateUserReport(id: string, nextStatus: UserReport['status']) {
    await api.patch(`/api/moderation/user-reports/${id}`, {
      status: nextStatus,
      assignedToMe: nextStatus === 'reviewing',
    });
    toast.success('User report updated.');
    await load();
  }

  async function moderate(
    report: ModerationReport,
    action: 'timeout' | 'ban' | 'untimeout' | 'unban' | 'shadowban' | 'unshadow' | 'slow' | 'unslow',
  ) {
    const reason = window.prompt(`Reason for ${action}:`, report.reason);
    if (!reason) return;
    const durationMinutes =
      action === 'timeout'
        ? Number(window.prompt('Timeout duration in minutes:', '60') ?? 0)
        : action === 'slow'
          ? Number(window.prompt('Slow-mode duration in minutes:', '60') ?? 0)
        : null;
    const intervalSeconds =
      action === 'slow' ? Number(window.prompt('Seconds between messages:', '30') ?? 0) : null;
    try {
      await api.post(`/api/moderation/users/${report.authorId}/actions`, {
        action,
        reason,
        durationMinutes,
        intervalSeconds,
      });
      toast.success(`User ${action} applied.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Moderation action failed.');
    }
  }

  return (
    <>
      <div className="row between">
        <div>
          <h2 className="section-title">مرکز نظارت و رسیدگی</h2>
          <p className="sub">بررسی شواهد و اعتراض‌ها، اجرای SLA و اعمال محدودیت حساب.</p>
        </div>
        <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="open">باز</option>
          <option value="reviewing">در حال بررسی</option>
          <option value="resolved">حل‌شده</option>
          <option value="dismissed">ردشده</option>
        </select>
      </div>
      {loading ? <Spinner label="در حال دریافت پرونده‌ها…" /> : null}
      {!loading && !reports.length ? (
        <EmptyState icon="✓" title="گزارشی وجود ندارد">صف رسیدگی در این وضعیت خالی است.</EmptyState>
      ) : null}
      <div className="col">
        {reports.map((report) => (
          <div className="settings-group" key={report.id}>
            <div className="row between">
              <strong>{report.reason}</strong>
              <span className="row">
                <span className={`badge${report.priority === 'high' ? ' danger' : ''}`}>
                  {report.priority}
                </span>
                <span className="badge">{report.status}</span>
              </span>
            </div>
            <p>{report.messagePreview || '(deleted message)'}</p>
            <p className="faint small">
              @{report.reporterUsername} reported @{report.authorUsername ?? 'deleted'} ·{' '}
              {formatFullTimestamp(report.createdAt)}
            </p>
            {report.details ? <p className="muted small">{report.details}</p> : null}
            {report.evidence ? (
              <><ReportEvidence evidence={report.evidence} /><p className="faint small mono">
                Evidence SHA-256: {report.evidence.hash}{report.slaDueAt ? ` · SLA ${formatFullTimestamp(report.slaDueAt)}` : ''}
              </p></>
            ) : null}
            <div className="row wrap">
              <button className="btn small" onClick={() => void updateReport(report.id, 'reviewing')}>
                Assign to me
              </button>
              <button className="btn small primary" onClick={() => void updateReport(report.id, 'resolved')}>
                Resolve
              </button>
              <button className="btn small" onClick={() => void updateReport(report.id, 'dismissed')}>
                Dismiss
              </button>
              <button className="btn small danger" onClick={() => void moderate(report, 'timeout')}>
                Timeout
              </button>
              <button className="btn small danger" onClick={() => void moderate(report, 'ban')}>
                Ban
              </button>
              <button className="btn small" onClick={() => void moderate(report, 'untimeout')}>
                Remove timeout
              </button>
              <button className="btn small" onClick={() => void moderate(report, 'unban')}>
                Unban
              </button>
              <button className="btn small danger" onClick={() => void moderate(report, 'shadowban')}>
                Shadow ban
              </button>
              <button className="btn small" onClick={() => void moderate(report, 'unshadow')}>
                Remove shadow
              </button>
              <button className="btn small danger" onClick={() => void moderate(report, 'slow')}>
                User slow mode
              </button>
              <button className="btn small" onClick={() => void moderate(report, 'unslow')}>
                Remove user slow mode
              </button>
            </div>
          </div>
        ))}
      </div>
      <h3 className="mt-16">Reported users</h3>
      <div className="col">
        {!loading && !userReports.length ? <p className="faint small">No user reports in this status.</p> : null}
        {userReports.map((report) => (
          <div className="settings-group" key={report.id}>
            <div className="row between">
              <strong>@{report.reportedUsername} · {report.reportedDisplayName}</strong>
              <span className="badge">{report.status}</span>
            </div>
            <p>{report.reason}</p>
            <p className="faint small">@{report.reporterUsername} reported this user · {formatFullTimestamp(report.createdAt)}</p>
            {report.details ? <p className="muted small">{report.details}</p> : null}
            <div className="row wrap">
              <button className="btn small" onClick={() => void updateUserReport(report.id, 'reviewing')}>Assign to me</button>
              <button className="btn small primary" onClick={() => void updateUserReport(report.id, 'resolved')}>Resolve</button>
              <button className="btn small" onClick={() => void updateUserReport(report.id, 'dismissed')}>Dismiss</button>
              <button className="btn small danger" onClick={() => void moderate({ ...report, authorId: report.reportedUserId, reason: report.reason } as unknown as ModerationReport, 'timeout')}>Timeout</button>
              <button className="btn small danger" onClick={() => void moderate({ ...report, authorId: report.reportedUserId, reason: report.reason } as unknown as ModerationReport, 'ban')}>Ban</button>
            </div>
          </div>
        ))}
      </div>
      <h3 className="mt-16">Open appeals</h3>
      <div className="col">
        {appeals.length === 0 ? <p className="faint small">No appeals are waiting.</p> : null}
        {appeals.map((appeal) => (
          <div className="settings-group" key={appeal.id}>
            <strong>@{appeal.username} · {appeal.action}</strong>
            <p>{appeal.reason}</p>
            <p className="faint small">Original reason: {appeal.action_reason}</p>
            <div className="row">
              {(['approved', 'denied'] as const).map((decision) => (
                <button
                  className={`btn small${decision === 'approved' ? ' primary' : ' danger'}`}
                  key={decision}
                  onClick={async () => {
                    const note = window.prompt(`Decision note for ${decision}:`);
                    if (!note) return;
                    await api.patch(`/api/moderation/appeals/${appeal.id}`, {
                      status: decision,
                      decision: note,
                    });
                    toast.success(`Appeal ${decision}.`);
                    await load();
                  }}
                >
                  {decision === 'approved' ? 'Approve' : 'Deny'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  capabilities: Array<'admin' | 'moderate' | 'debug' | 'stream'>;
  userCount: number;
}

const CAPABILITY_LABELS = {
  admin: 'مدیریت کامل',
  moderate: 'نظارت محتوا',
  debug: 'مشاهده فنی',
  stream: 'ساخت فضای پخش',
} as const;

function RolesTab() {
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [userRoles, setUserRoles] = useState<Array<{ id: string; name: string; granted: boolean }>>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<CustomRole['capabilities']>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [roleData, userData] = await Promise.all([
      api.get<{ roles: CustomRole[] }>('/api/admin/roles'),
      api.get<{ users: AdminUser[] }>('/api/admin/users?limit=500'),
    ]);
    setRoles(roleData.roles);
    setUsers(userData.users);
  }, []);

  useEffect(() => {
    void load().catch(() => toast.error('دریافت نقش‌ها ناموفق بود.'));
  }, [load]);

  useEffect(() => {
    if (!selectedUser) {
      setUserRoles([]);
      return;
    }
    void api
      .get<{ roles: Array<{ id: string; name: string; granted: boolean }> }>(
        `/api/admin/users/${selectedUser}/roles`,
      )
      .then((data) => setUserRoles(data.roles))
      .catch(() => toast.error('دریافت نقش‌های کاربر ناموفق بود.'));
  }, [selectedUser]);

  function toggleCapability(capability: CustomRole['capabilities'][number]) {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability],
    );
  }

  return (
    <>
      <h2 className="section-title">کنترل دسترسی مبتنی بر نقش</h2>
      <p className="sub">نقش‌های دقیق بسازید و فقط مجوز لازم را به هر تیم یا کاربر واگذار کنید.</p>

      <div className="admin-split">
        <section className="settings-group admin-card">
          <div className="row between">
            <div>
              <h3>نقش‌های سفارشی</h3>
              <p className="desc">{roles.length.toLocaleString('fa-IR')} نقش تعریف شده</p>
            </div>
          </div>
          <div className="role-grid">
            {roles.map((role) => (
              <article className="role-card" key={role.id}>
                <div className="row between">
                  <strong>{role.name}</strong>
                  <span className="count-chip">{role.userCount.toLocaleString('fa-IR')} کاربر</span>
                </div>
                <p>{role.description || 'بدون توضیح'}</p>
                <div className="permission-chips">
                  {role.capabilities.map((capability) => (
                    <span key={capability}>{CAPABILITY_LABELS[capability]}</span>
                  ))}
                </div>
                <div className="row">
                  <button
                    className="btn small"
                    onClick={() => {
                      const nextName = window.prompt('نام نقش:', role.name);
                      if (!nextName) return;
                      const nextDescription = window.prompt('توضیح نقش:', role.description ?? '') ?? role.description;
                      const rawCapabilities = window.prompt(
                        'مجوزها با ویرگول (admin, moderate, debug, stream):',
                        role.capabilities.join(', '),
                      );
                      if (rawCapabilities === null) return;
                      const nextCapabilities = rawCapabilities
                        .split(',')
                        .map((item) => item.trim())
                        .filter((item): item is CustomRole['capabilities'][number] =>
                          item in CAPABILITY_LABELS,
                        );
                      void api
                        .patch(`/api/admin/roles/${role.id}`, {
                          name: nextName.trim(),
                          description: nextDescription?.trim() || null,
                          capabilities: nextCapabilities,
                        })
                        .then(load)
                        .catch((error) =>
                          toast.error(error instanceof ApiError ? error.message : 'ویرایش ناموفق بود.'),
                        );
                    }}
                  >
                    ویرایش
                  </button>
                  <button
                    className="btn danger small"
                    onClick={() => {
                      if (!window.confirm(`نقش «${role.name}» حذف شود؟`)) return;
                      void api
                        .del(`/api/admin/roles/${role.id}`)
                        .then(load)
                        .catch((error) => toast.error(error instanceof ApiError ? error.message : 'حذف ناموفق بود.'));
                    }}
                  >
                    حذف نقش
                  </button>
                </div>
              </article>
            ))}
            {!roles.length ? <p className="muted">هنوز نقش سفارشی ساخته نشده است.</p> : null}
          </div>
        </section>

        <section className="settings-group admin-card">
          <h3>ساخت نقش جدید</h3>
          <p className="desc">اصل حداقل دسترسی را رعایت کنید.</p>
          <div className="field">
            <label>نام نقش</label>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً تیم امنیت" />
          </div>
          <div className="field">
            <label>توضیح</label>
            <textarea className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="کاربرد و مسئولیت این نقش" />
          </div>
          <div className="permission-picker">
            {(Object.keys(CAPABILITY_LABELS) as CustomRole['capabilities']).map((capability) => (
              <label key={capability} className={capabilities.includes(capability) ? 'selected' : ''}>
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={() => toggleCapability(capability)}
                />
                <span><strong>{CAPABILITY_LABELS[capability]}</strong><small>{capability}</small></span>
              </label>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/admin/roles', {
                  name: name.trim(),
                  description: description.trim() || null,
                  capabilities,
                });
                setName('');
                setDescription('');
                setCapabilities([]);
                await load();
                toast.success('نقش جدید ساخته شد.');
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'ساخت نقش ناموفق بود.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'در حال ساخت…' : 'ساخت نقش امن'}
          </button>
        </section>
      </div>

      <section className="settings-group admin-card">
        <h3>اختصاص نقش به کاربر</h3>
        <p className="desc">تغییر مجوز بلافاصله ثبت و در Audit ذخیره می‌شود.</p>
        <select className="select" value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}>
          <option value="">یک کاربر را انتخاب کنید…</option>
          {users.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.displayName} (@{entry.username})</option>
          ))}
        </select>
        {selectedUser ? (
          <div className="permission-picker mt-16">
            {userRoles.map((role) => (
              <label key={role.id} className={role.granted ? 'selected' : ''}>
                <input
                  type="checkbox"
                  checked={role.granted}
                  onChange={async (event) => {
                    const granted = event.target.checked;
                    try {
                      await api.put(`/api/admin/users/${selectedUser}/roles/${role.id}`, { granted });
                      setUserRoles((current) =>
                        current.map((item) => item.id === role.id ? { ...item, granted } : item),
                      );
                      await load();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'تغییر نقش ناموفق بود.');
                    }
                  }}
                />
                <span><strong>{role.name}</strong><small>{role.granted ? 'فعال' : 'غیرفعال'}</small></span>
              </label>
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

interface BotItem {
  id: string;
  name: string;
  username: string;
  active: boolean;
  description: string | null;
}

interface WebhookItem {
  id: string;
  name: string;
  endpoint: string;
  targetType: string;
  targetId: string;
  events: string[];
  permissionLevel?: 'manageWebhooks' | 'manageGroup' | 'owner';
  active: boolean;
  failureCount: number;
}

interface OAuthAppItem {
  id: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  active: boolean;
}

interface IncomingWebhookItem {
  id: string;
  name: string;
  channelId: string;
  botId: string;
  botName: string;
  active: boolean;
  lastUsedAt: number | null;
}

function IntegrationsTab() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [bots, setBots] = useState<BotItem[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [apps, setApps] = useState<OAuthAppItem[]>([]);
  const [incoming, setIncoming] = useState<IncomingWebhookItem[]>([]);
  const [secret, setSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [keyData, botData, webhookData, appData, incomingData] = await Promise.all([
      api.get<{ apiKeys: ApiKeyItem[] }>('/api/integrations/api-keys'),
      api.get<{ bots: BotItem[] }>('/api/integrations/bots'),
      api.get<{ webhooks: WebhookItem[] }>('/api/integrations/webhooks'),
      api.get<{ apps: OAuthAppItem[] }>('/api/integrations/apps'),
      api.get<{ webhooks: IncomingWebhookItem[] }>('/api/integrations/incoming'),
    ]);
    setKeys(keyData.apiKeys);
    setBots(botData.bots);
    setWebhooks(webhookData.webhooks);
    setApps(appData.apps);
    setIncoming(incomingData.webhooks);
  }, []);

  useEffect(() => {
    void load().catch(() => toast.error('دریافت یکپارچه‌سازی‌ها ناموفق بود.'));
  }, [load]);

  async function reveal(result: Promise<{ token?: string; secret?: string }>) {
    try {
      const data = await result;
      setSecret(data.token ?? data.secret ?? null);
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'عملیات ناموفق بود.');
    }
  }

  return (
    <>
      <h2 className="section-title">درگاه توسعه و اتوماسیون</h2>
      <p className="sub">کلیدهای محدودشده، ربات‌های سرویس و Webhookهای امضاشده را مدیریت کنید.</p>
      {secret ? (
        <Alert kind="info">
          <strong>این مقدار فقط همین یک‌بار نمایش داده می‌شود.</strong>
          <div className="secret-reveal">
            <code>{secret}</code>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(secret)}>کپی</button>
            <button className="btn small" onClick={() => setSecret(null)}>بستن</button>
          </div>
        </Alert>
      ) : null}

      <div className="admin-dashboard-grid">
        <section className="settings-group admin-card">
          <div className="row between">
            <div><h3>کلیدهای API</h3><p className="desc">توکن‌های Hash‌شده با Scope محدود</p></div>
            <button
              className="btn primary small"
              onClick={() => {
                const name = window.prompt('نام کلید:', 'اتوماسیون مدیریت');
                if (!name) return;
                void reveal(api.post('/api/integrations/api-keys', {
                  name,
                  scopes: ['read', 'write', 'admin'],
                  expiresAt: Date.now() + 90 * 86400_000,
                }));
              }}
            >
              کلید جدید
            </button>
          </div>
          <div className="compact-list">
            {keys.map((key) => (
              <div key={key.id}>
                <span><strong>{key.name}</strong><small>ytbl_{key.prefix}_… · {key.scopes.join(', ')}</small></span>
                <button className="icon-danger" title="لغو کلید" onClick={() => void api.del(`/api/integrations/api-keys/${key.id}`).then(load)}>×</button>
              </div>
            ))}
            {!keys.length ? <p className="muted">کلید فعالی وجود ندارد.</p> : null}
          </div>
        </section>

        <section className="settings-group admin-card">
          <div className="row between">
            <div><h3>ربات‌های سرویس</h3><p className="desc">هویت مستقل برای اتصال‌های خودکار</p></div>
            <button
              className="btn primary small"
              onClick={() => {
                const name = window.prompt('نام ربات:', 'ربات عملیات');
                if (!name) return;
                void reveal(api.post('/api/integrations/bots', { name, description: 'ساخته‌شده از پنل مدیریت' }));
              }}
            >
              ربات جدید
            </button>
          </div>
          <div className="compact-list">
            {bots.map((bot) => (
              <div key={bot.id}>
                <span><strong>{bot.name}</strong><small>@{bot.username}</small></span>
                <span className={`status-dot-text ${bot.active ? 'ok' : 'down'}`}>{bot.active ? 'فعال' : 'غیرفعال'}</span>
                {bot.active ? (
                  <>
                    <button
                      className="btn small"
                      onClick={async () => {
                        const groupId = window.prompt('شناسه سرور برای نصب ربات:');
                        if (!groupId) return;
                        try {
                          await api.post(`/api/integrations/groups/${groupId}/bots/${bot.id}/install`, {
                            permissions: ['viewChannel', 'sendMessages'],
                          });
                          const name = window.prompt('نام دستور Slash (بدون /):', 'hello');
                          const responseTemplate = name
                            ? window.prompt('پاسخ دستور؛ {user} و {args} قابل استفاده‌اند:', 'Hello {user}! {args}')
                            : null;
                          if (name && responseTemplate) {
                            await api.post(`/api/integrations/groups/${groupId}/commands`, {
                              botId: bot.id,
                              name,
                              description: `${bot.name} command`,
                              responseTemplate,
                            });
                          }
                          toast.success('ربات نصب و دستور ثبت شد.');
                        } catch (error) {
                          toast.error(error instanceof ApiError ? error.message : 'نصب ربات ناموفق بود.');
                        }
                      }}
                    >
                      نصب / دستور
                    </button>
                    <button
                      className="icon-danger"
                      title="غیرفعال‌سازی ربات"
                      onClick={() =>
                        void api.del(`/api/integrations/bots/${bot.id}`)
                          .then(load)
                          .catch(() => toast.error('غیرفعال‌سازی ربات ناموفق بود.'))
                      }
                    >
                      ×
                    </button>
                  </>
                ) : null}
              </div>
            ))}
            {!bots.length ? <p className="muted">رباتی ساخته نشده است.</p> : null}
          </div>
        </section>
      </div>

      <section className="settings-group admin-card">
        <div className="row between">
          <div>
            <h3>برنامه‌های OAuth2</h3>
            <p className="desc">Authorization code پنج‌دقیقه‌ای و Access token محدود به Scope</p>
          </div>
          <button
            className="btn primary small"
            onClick={() => {
              const name = window.prompt('نام برنامه:', 'sahsha');
              const redirect = name ? window.prompt('Redirect URI:', 'https://example.com/oauth/callback') : null;
              if (!name || !redirect) return;
              void reveal(
                api
                  .post<{ clientSecret: string }>('/api/integrations/apps', {
                    name,
                    description: 'OAuth2 application',
                    redirectUris: [redirect],
                    scopes: ['read', 'write'],
                  })
                  .then((result) => ({ secret: result.clientSecret })),
              );
            }}
          >
            برنامه جدید
          </button>
        </div>
        <div className="compact-list">
          {apps.map((app) => (
            <div key={app.id}>
              <span>
                <strong>{app.name}</strong>
                <small dir="ltr">{app.clientId} · {app.redirectUris.join(', ')}</small>
              </span>
              <span className={`status-dot-text ${app.active ? 'ok' : 'down'}`}>
                {app.active ? 'فعال' : 'غیرفعال'}
              </span>
            </div>
          ))}
          {!apps.length ? <p className="muted">برنامه OAuth ساخته نشده است.</p> : null}
        </div>
      </section>

      <section className="settings-group admin-card">
        <div className="row between">
          <div><h3>Webhookهای ورودی</h3><p className="desc">ارسال پیام به کانال از سرویس‌های خارجی با URL محرمانه</p></div>
          <button
            className="btn primary small"
            onClick={async () => {
              const channelId = window.prompt('شناسه کانال:');
              const botId = channelId ? window.prompt('شناسه ربات نصب‌شده:') : null;
              if (!channelId || !botId) return;
              try {
                const result = await api.post<{ url: string }>('/api/integrations/incoming', {
                  name: 'Incoming webhook',
                  channelId,
                  botId,
                });
                setSecret(result.url);
                await load();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'ساخت Webhook ورودی ناموفق بود.');
              }
            }}
          >
            Webhook ورودی جدید
          </button>
        </div>
        <div className="compact-list">
          {incoming.map((webhook) => (
            <div key={webhook.id}>
              <span><strong>{webhook.name}</strong><small>{webhook.botName} · channel {webhook.channelId}</small></span>
              <button className="icon-danger" onClick={() => void api.del(`/api/integrations/incoming/${webhook.id}`).then(load)}>×</button>
            </div>
          ))}
          {!incoming.length ? <p className="muted">Webhook ورودی ساخته نشده است.</p> : null}
        </div>
      </section>

      <section className="settings-group admin-card">
        <div className="row between">
          <div><h3>Webhookهای خروجی</h3><p className="desc">تحویل HMAC، Retry نمایی و Circuit breaker</p></div>
          <button
            className="btn primary small"
            onClick={() => {
              const endpoint = window.prompt('نشانی HTTPS مقصد:');
              const targetId = endpoint ? window.prompt('شناسه کانال یا گفتگو:') : null;
              if (!endpoint || !targetId) return;
              const targetType = window.confirm('مقصد یک کانال است؟') ? 'channel' : 'conversation';
              const permissionLevel = window.prompt('سطح مدیریت: manageWebhooks, manageGroup یا owner', 'manageWebhooks');
              if (!permissionLevel || !['manageWebhooks', 'manageGroup', 'owner'].includes(permissionLevel)) return;
              void reveal(api.post('/api/integrations/webhooks', {
                name: 'Webhook مدیریت',
                endpoint,
                targetType,
                targetId,
                permissionLevel,
                events: ['message.created', 'message.updated', 'message.deleted', 'poll.created', 'poll.updated', 'poll.voted', 'test'],
              }));
            }}
          >
            افزودن Webhook
          </button>
        </div>
        <div className="compact-list">
          {webhooks.map((webhook) => (
            <div key={webhook.id}>
              <span><strong>{webhook.name}</strong><small dir="ltr">{webhook.endpoint}</small></span>
              <span className={webhook.failureCount ? 'danger-text' : 'muted'}>{webhook.failureCount.toLocaleString('fa-IR')} خطا</span>
              <small>{webhook.permissionLevel ?? 'manageWebhooks'}</small>
              <button className="btn small" onClick={() => void api.post(`/api/integrations/webhooks/${webhook.id}/test`).then(() => toast.success('رویداد آزمایشی در صف قرار گرفت.'))}>تست</button>
              <button className="btn small" onClick={async () => {
                const endpoint = window.prompt('نشانی HTTPS مقصد جدید:', webhook.endpoint);
                if (!endpoint) return;
                await api.patch(`/api/integrations/webhooks/${webhook.id}`, { endpoint });
                await load();
              }}>ویرایش</button>
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    const result = await api.get<{ deliveries: { id: string; status: string; attempts: number; error: string | null }[] }>(
                      `/api/integrations/webhooks/${webhook.id}/deliveries`,
                    );
                    const failed = result.deliveries.find((delivery) => delivery.status === 'failed');
                    window.alert(
                      result.deliveries.slice(0, 10).map((delivery) =>
                        `${delivery.status} · ${delivery.attempts} attempt(s)${delivery.error ? ` · ${delivery.error}` : ''}`,
                      ).join('\n') || 'No deliveries yet.',
                    );
                    if (failed && window.confirm('Retry the newest failed delivery?')) {
                      await api.post(`/api/integrations/webhooks/${webhook.id}/deliveries/${failed.id}/retry`);
                      toast.success('تحویل مجدد در صف قرار گرفت.');
                    }
                  } catch (error) {
                    toast.error(error instanceof ApiError ? error.message : 'دریافت تاریخچه ناموفق بود.');
                  }
                }}
              >
                تاریخچه / Retry
              </button>
              <button className="icon-danger" onClick={() => void api.del(`/api/integrations/webhooks/${webhook.id}`).then(load)}>×</button>
            </div>
          ))}
          {!webhooks.length ? <p className="muted">Webhook فعالی وجود ندارد.</p> : null}
        </div>
      </section>
    </>
  );
}

interface OperationsState {
  ok: boolean;
  checkedAt: number;
  latencyMs: number;
  deployment: { region: string; role: string; writes: boolean };
  services: Record<string, {
    ok?: boolean;
    configured?: boolean;
    enabled?: boolean;
    driver?: string;
    mode?: string;
    dialect?: string;
    latencyMs?: number;
    waiting?: number;
    active?: number;
    delayed?: number;
    failed?: number;
    error?: string;
  }>;
  records: Record<string, number>;
  features: Record<string, boolean | string>;
}

interface DeadLetter {
  id: string;
  jobType: string;
  jobId: string | null;
  error: string;
  attempts: number;
  status: string;
  lastFailedAt: number;
}

function OperationsTab() {
  const [state, setState] = useState<OperationsState | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [operations, dlq] = await Promise.all([
        api.get<OperationsState>('/api/admin/operations'),
        api.get<{ deadLetters: DeadLetter[] }>('/api/admin/notification-dlq'),
      ]);
      setState(operations);
      setDeadLetters(dlq.deadLetters);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        toast.error('حداقل یکی از سرویس‌های الزامی آماده نیست.');
      } else {
        toast.error('دریافت وضعیت عملیات ناموفق بود.');
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <>
      <div className="row between">
        <div>
          <h2 className="section-title">مرکز عملیات و قابلیت اطمینان</h2>
          <p className="sub">پایش زندهٔ وابستگی‌ها، صف پردازش و تحویل اعلان‌ها.</p>
        </div>
        <button className="btn" disabled={refreshing} onClick={() => void load()}>
          {refreshing ? 'در حال بررسی…' : 'بازبینی فوری'}
        </button>
      </div>

      {!state ? <Spinner label="در حال سنجش سرویس‌ها…" /> : (
        <>
          <div className="service-grid">
            {Object.entries(state.services).map(([name, service]) => {
              const healthy = service.ok ?? service.enabled ?? true;
              return (
                <article className={`service-card ${healthy ? 'healthy' : 'unhealthy'}`} key={name}>
                  <span className="service-icon">{healthy ? '✓' : '!'}</span>
                  <div><strong>{serviceName(name)}</strong><small>{service.error || service.driver || service.mode || service.dialect || 'آماده'}</small></div>
                  <span>{service.latencyMs !== undefined ? `${service.latencyMs}ms` : healthy ? 'سالم' : 'خطا'}</span>
                </article>
              );
            })}
          </div>

          <div className="admin-dashboard-grid">
            <section className="settings-group admin-card">
              <h3>ویژگی‌های فعال</h3>
              <div className="feature-matrix">
                {Object.entries(state.features).map(([name, enabled]) => (
                  <div key={name}>
                    <span>{featureName(name)}</span>
                    <strong className={enabled && enabled !== 'off' ? 'enabled' : ''}>
                      {typeof enabled === 'string' ? enabled : enabled ? 'فعال' : 'تنظیم نشده'}
                    </strong>
                  </div>
                ))}
              </div>
            </section>
            <section className="settings-group admin-card">
              <h3>عملیات نگهداری</h3>
              <p className="desc">پاک‌سازی نشست منقضی و فایل‌های بدون مرجع بدون توقف سرویس</p>
              <button
                className="btn primary"
                onClick={() =>
                  void api.post<{ sessions: number; attachments: number }>('/api/admin/maintenance/purge')
                    .then((result) => toast.success(`${result.sessions} نشست و ${result.attachments} فایل پاک شد.`))
                    .catch(() => toast.error('پاک‌سازی ناموفق بود.'))
                }
              >
                اجرای نگهداری امن
              </button>
            </section>
          </div>
        </>
      )}

      <section className="settings-group admin-card">
        <div className="row between">
          <div><h3>صف خطاهای تحویل</h3><p className="desc">Jobهای شکست‌خورده پس از پایان Retry</p></div>
          <span className={`count-chip ${deadLetters.filter((item) => item.status === 'open').length ? 'danger' : ''}`}>
            {deadLetters.filter((item) => item.status === 'open').length.toLocaleString('fa-IR')} باز
          </span>
        </div>
        <div className="compact-list">
          {deadLetters.map((item) => (
            <div key={item.id}>
              <span><strong>{item.jobType}</strong><small>{item.error} · {formatRelative(item.lastFailedAt)}</small></span>
              <span>{item.attempts.toLocaleString('fa-IR')} تلاش</span>
              {item.status === 'open' ? (
                <button
                  className="btn small"
                  onClick={() =>
                    void api.post(`/api/admin/notification-dlq/${item.id}/retry`)
                      .then(() => load())
                      .catch(() => toast.error('ارسال مجدد ناموفق بود.'))
                  }
                >
                  تلاش مجدد
                </button>
              ) : <span className="status-dot-text ok">رسیدگی شد</span>}
            </div>
          ))}
          {!deadLetters.length ? <p className="muted">صف خطا خالی است؛ همه تحویل‌ها سالم هستند.</p> : null}
        </div>
      </section>
    </>
  );
}

function serviceName(name: string) {
  return ({ database: 'پایگاه‌داده', cache: 'کش Redis', storage: 'ذخیره‌سازی', antivirus: 'ضدبدافزار', search: 'جست‌وجو', queue: 'صف پردازش' } as Record<string, string>)[name] ?? name;
}

function featureName(name: string) {
  return ({ sso: 'ورود سازمانی', smtp: 'ایمیل', push: 'Push', livekit: 'LiveKit SFU', egress: 'ضبط تماس', turn: 'TURN', tracing: 'ردیابی توزیع‌شده', metrics: 'متریک امن', dlp: 'جلوگیری نشت داده' } as Record<string, string>)[name] ?? name;
}

function SettingsTab() {
  const patchSettings = useSession((state) => state.patchSettings);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    void api
      .get<{ settings: AdminSettings }>('/api/admin/settings')
      .then((data) => setSettings(data.settings))
      .catch(() => toast.error('Could not load settings.'));
  }, []);

  if (!settings) return <Spinner label="Loading settings…" />;

  const set = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current));

  async function save() {
    if (!settings) return;
    setErrors([]);
    setBusy(true);
    try {
      const data = await api.patch<{ settings: AdminSettings }>('/api/admin/settings', settings);
      setSettings(data.settings);
      patchSettings(data.settings);
      toast.success('Settings saved.');
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : ['Could not save the settings.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="section-title">تنظیمات زنده سامانه</h2>
      <p className="sub">تغییرات فوراً برای همه اعمال می‌شوند و به راه‌اندازی مجدد نیاز ندارند.</p>

      {errors.length ? <ErrorList lines={errors} /> : null}

      <div className="settings-group">
        <h3>Identity</h3>
        <p className="desc">The name people see in the interface.</p>
        <div className="field mb-0">
          <label>Server name</label>
          <input
            className="input"
            value={settings.app_name}
            onChange={(event) => set('app_name', event.target.value)}
            maxLength={48}
          />
        </div>
        <div className="field mt-16 mb-0">
          <label>Platform logo URL</label>
          <input
            className="input"
            value={settings.app_logo_url}
            onChange={(event) => set('app_logo_url', event.target.value)}
            maxLength={500}
            placeholder="https://…/logo.png (leave blank for text logo)"
          />
        </div>
        <div className="field mt-16 mb-0">
          <label>Message of the day</label>
          <input
            className="input"
            value={settings.motd}
            onChange={(event) => set('motd', event.target.value)}
            maxLength={280}
            placeholder="Shown as a banner to everyone. Leave blank to hide it."
          />
        </div>
      </div>

      <div className="settings-group">
        <h3>Login and registration</h3>
        <p className="desc">Control public signup and every prominent text on the authentication page.</p>
        <label className="checkbox">
          <input type="checkbox" checked={settings.registration_enabled}
            onChange={(event) => set('registration_enabled', event.target.checked)} />
          <span>Enable public registration</span>
        </label>
        {settings.registration_enabled ? (
          <button className="btn small mt-16" onClick={() => {
            const url = new URL(window.location.origin);
            url.searchParams.set('register', '1');
            void navigator.clipboard.writeText(url.toString());
            toast.success('Platform registration link copied.');
          }}>Copy main platform invite link</button>
        ) : null}
        {([
          ['login_title', 'Login title'],
          ['login_subtitle', 'Login subtitle'],
          ['login_footer_text', 'Login footer text'],
          ['signup_title', 'Registration title'],
          ['signup_subtitle', 'Registration subtitle'],
        ] as Array<[keyof AdminSettings, string]>).map(([key, label]) => (
          <div className="field mt-16 mb-0" key={key}>
            <label>{label}</label>
            <input className="input" value={String(settings[key])}
              onChange={(event) => set(key, event.target.value as never)} maxLength={280} />
          </div>
        ))}
        <span className="hint">Registration collects phone, email, first name, last name, username, nickname, and password.</span>
      </div>

      <div className="settings-group">
        <h3>File uploads</h3>
        <p className="desc">
          Turn this off and the attach button disappears for everyone; the upload endpoint refuses
          new files as well.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.uploads_enabled}
            onChange={(event) => set('uploads_enabled', event.target.checked)}
          />
          <span>Allow file uploads</span>
        </label>

        {settings.uploads_enabled ? (
          <>
            <div className="admin-upload-limit mt-16">
              <div className="row between">
                <div><strong>Per-file size limit</strong><p className="hint">Control the maximum size of each uploaded file.</p></div>
                <label className="admin-switch"><input type="checkbox" checked={settings.upload_limit_enabled} onChange={(event) => set('upload_limit_enabled', event.target.checked)} /><span /></label>
              </div>
              {settings.upload_limit_enabled ? (
                <div className="admin-limit-control">
                  <div className="row wrap admin-limit-presets">
                    {[5, 10, 25, 50, 100].map((size) => <button key={size} className={`btn small${settings.max_upload_mb === size ? ' primary' : ' ghost'}`} onClick={() => set('max_upload_mb', size)}>{size} MB</button>)}
                  </div>
                  <label className="field mb-0"><span>Custom limit (1–100 MB)</span><input className="input" type="number" min={1} max={100} value={settings.max_upload_mb} onChange={(event) => set('max_upload_mb', Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></label>
                </div>
              ) : (
                <div className="admin-unlimited-note"><Icon name="archive" size={18} /><div><strong>No custom file limit</strong><span>Uploads use the server’s 100 MB infrastructure safety ceiling.</span></div></div>
              )}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.allow_image_uploads}
                onChange={(event) => set('allow_image_uploads', event.target.checked)}
              />
              <span>Images</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.allow_video_uploads}
                onChange={(event) => set('allow_video_uploads', event.target.checked)}
              />
              <span>Video</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.allow_audio_uploads}
                onChange={(event) => set('allow_audio_uploads', event.target.checked)}
              />
              <span>Audio</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.allow_document_uploads}
                onChange={(event) => set('allow_document_uploads', event.target.checked)}
              />
              <span>Documents (PDF, ZIP, text)</span>
            </label>
          </>
        ) : null}
      </div>

      <div className="settings-group">
        <h3>Messaging</h3>
        <p className="desc">Who may talk to whom, and who may start a group.</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.allow_dms}
            onChange={(event) => set('allow_dms', event.target.checked)}
          />
          <span>Allow direct messages</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.allow_group_dms}
            onChange={(event) => set('allow_group_dms', event.target.checked)}
          />
          <span>Allow group direct messages</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.youtubers_can_create_groups}
            onChange={(event) => set('youtubers_can_create_groups', event.target.checked)}
          />
          <span>YouTuber accounts can create groups</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.members_can_create_groups}
            onChange={(event) => set('members_can_create_groups', event.target.checked)}
          />
          <span>Member accounts can create groups</span>
        </label>
        <div className="field mt-16 mb-0">
          <label>Edit window (minutes)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={1440}
            value={settings.message_edit_window_minutes}
            onChange={(event) => set('message_edit_window_minutes', Number(event.target.value))}
          />
          <span className="hint">0 means messages can be edited at any time.</span>
        </div>
        <div className="field mt-16 mb-0">
          <label>Duplicate-message limit per 30 seconds</label>
          <input
            className="input"
            type="number"
            min={2}
            max={50}
            value={settings.spam_messages_per_30s}
            onChange={(event) => set('spam_messages_per_30s', Number(event.target.value))}
          />
        </div>
        <div className="field mt-16 mb-0">
          <label>Blocked terms</label>
          <textarea
            className="textarea"
            value={settings.blocked_terms}
            onChange={(event) => set('blocked_terms', event.target.value)}
            maxLength={2000}
            placeholder="One term per line or comma-separated. Leave empty to disable."
          />
          <span className="hint">
            Matching is case-insensitive and runs before a message is stored.
          </span>
        </div>
      </div>

      <div className="settings-group">
        <h3>Security</h3>
        <p className="desc">Applies to everyone with the administrator role.</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.require_2fa_for_admins}
            onChange={(event) => set('require_2fa_for_admins', event.target.checked)}
          />
          <span>
            Require two-factor authentication for administrators
            <br />
            <span className="hint">
              Turn this on only after you have enrolled — you will be prompted at next sign-in.
            </span>
          </span>
        </label>
      </div>

      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </>
  );
}

function AuditTab() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [integrity, setIntegrity] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, total: 0, pages: 1 });
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (filter.trim()) params.set('search', filter.trim());
      const data = await api.get<{ logs: AuditLog[]; pagination: typeof pagination }>(`/api/admin/audit?${params}`);
      setLogs(data.logs);
      setPagination(data.pagination);
    } catch {
      toast.error('Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [filter, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLogs(), filter ? 280 : 0);
    return () => window.clearTimeout(timer);
  }, [loadLogs, filter]);

  async function removeLog(log: AuditLog) {
    const reason = window.prompt('Why should this entry be removed from the admin view? (optional)', 'Administrative cleanup');
    if (reason === null) return;
    try {
      await api.del(`/api/admin/audit/${log.id}`, { reason: reason.trim() || null });
      toast.success('Entry removed from the security log view. The signed integrity chain was preserved.');
      await loadLogs();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the entry.');
    }
  }

  const pageNumbers = Array.from({ length: Math.min(5, pagination.pages) }, (_, index) => {
    const start = Math.max(1, Math.min(page - 2, pagination.pages - 4));
    return start + index;
  });

  return (
    <>
      <h2 className="section-title">ردپای امنیتی تغییرناپذیر</h2>
      <p className="sub">
        ورودها، تغییر حساب، حذف‌ها و تنظیمات همراه با زمان و عامل در این زنجیره ثبت می‌شوند.
      </p>

      <div className="audit-command-bar">
        <input
          className="input grow"
          placeholder="فیلتر با عملیات، کاربر یا جزئیات…"
          value={filter}
          onChange={(event) => { setFilter(event.target.value); setPage(1); }}
        />
        <button
          className="btn"
          onClick={async () => {
            try {
              const result = await api.get<{
                integrity: { valid: boolean; checked: number; unsigned: number };
              }>('/api/admin/audit/verify');
              setIntegrity(
                result.integrity.valid
                  ? `Verified ${result.integrity.checked} protected entries`
                  : 'Integrity verification failed',
              );
              toast.success('Audit-chain integrity verified.');
            } catch {
              setIntegrity('Integrity verification failed');
              toast.error('Audit-chain verification failed.');
            }
          }}
        >
          Verify integrity
        </button>
        <a className="btn" href="/api/admin/audit/export">
          Export CSV
        </a>
      </div>
      {integrity ? <p className="small muted">{integrity}</p> : null}

      <div className="audit-summary-grid">
        <div><span>Total visible events</span><strong>{pagination.total.toLocaleString()}</strong></div>
        <div><span>This page</span><strong>{logs.length}</strong></div>
        <div><span>Signed entries</span><strong>{logs.filter((log) => log.integrityProtected).length}/{logs.length}</strong></div>
        <div><span>Page</span><strong>{pagination.page}/{pagination.pages}</strong></div>
      </div>

      {loading ? (
        <Spinner label="Loading…" />
      ) : (
        <div className="audit-log-shell">
          {logs.map((log) => (
            <article className={`audit-log-row${expanded === log.id ? ' expanded' : ''}`} key={log.id}>
              <button className="audit-log-main" onClick={() => setExpanded((current) => current === log.id ? null : log.id)}>
                <span className="audit-event-icon"><Icon name={log.action.includes('security') || log.action.includes('login') ? 'shield' : log.action.includes('delete') ? 'trash' : 'system'} size={16} /></span>
                <span className="audit-log-copy"><strong>{log.action}</strong><small>{log.actorDisplayName ?? log.actorUsername ?? 'System'}{log.targetType ? ` → ${log.targetType}` : ''}</small></span>
                <span className="audit-log-time">{formatFullTimestamp(log.createdAt)}</span>
                {log.integrityProtected ? <span className="audit-signed"><Icon name="lock" size={12} /> signed</span> : null}
                <Icon name={expanded === log.id ? 'close' : 'add'} size={14} />
              </button>
              {expanded === log.id ? (
                <div className="audit-log-detail">
                  <dl><div><dt>Entry ID</dt><dd className="mono">{log.id}</dd></div><div><dt>Actor</dt><dd>{log.actorDisplayName ?? 'System'} {log.actorUsername ? `(@${log.actorUsername})` : ''}</dd></div><div><dt>Target</dt><dd>{log.targetType ? `${log.targetType} · ${log.targetId ?? '—'}` : '—'}</dd></div><div><dt>IP address</dt><dd className="mono">{log.ip ?? '—'}</dd></div></dl>
                  {log.meta ? <pre>{JSON.stringify(log.meta, null, 2)}</pre> : <p className="muted small">No additional metadata.</p>}
                  <div className="row end"><button className="btn danger small" onClick={() => void removeLog(log)}><Icon name="trash" size={14} /> Remove from view</button></div>
                </div>
              ) : null}
            </article>
          ))}
          {logs.length === 0 ? (
            <div style={{ padding: 20 }} className="muted">
              Nothing matches that filter.
            </div>
          ) : null}
        </div>
      )}
      <div className="audit-pagination">
        <div className="row"><span>Rows per page</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div>
        <div className="row audit-page-buttons"><button className="btn ghost small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>{pageNumbers.map((number) => <button key={number} className={`btn small${number === page ? ' primary' : ' ghost'}`} onClick={() => setPage(number)}>{number}</button>)}<button className="btn ghost small" disabled={page >= pagination.pages} onClick={() => setPage((current) => current + 1)}>Next</button></div>
      </div>
    </>
  );
}
