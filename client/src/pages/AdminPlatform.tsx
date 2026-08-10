import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatBytes, formatRelative } from '../lib/format';
import { toast } from '../store/toast';
import type { AdminSettings } from '../types';
import { Spinner } from '../components/ui';

interface Backup { id: string; provider: string; status: string; bytes: number; startedAt: number; error: string | null }
interface QueueJob { id: string; name: string; state: string; attemptsMade: number; failedReason: string | null; timestamp: number }
interface Provider { configured: boolean; ok?: boolean; error?: string; keyConfigured?: boolean; model?: string; referenceId?: string }
interface FishModel { id: string; title: string; languages: string[]; visibility: string }
interface PlatformState {
  configuration: Record<string, string | number | boolean | string[]>;
  providers: Record<string, Provider>;
  backups: Backup[];
  storage: { driver: string; ok: boolean; count: number; bytes: number; quarantined: number; quotaCapacity: number; quotaUsed: number; quotaReserved: number; cdn: boolean; bucket: string | null };
  queue: { enabled: boolean; waiting: number; active: number; delayed: number; completed: number; failed: number; jobs: QueueJob[] };
  retentionDays: number;
}
const FLAGS: Array<{ key: keyof AdminSettings; label: string; help: string }> = [
  { key: 'feature_e2ee', label: 'رمزنگاری سرتاسری', help: 'E2EE در گفتگوهای خصوصی' },
  { key: 'e2ee_required_for_dms', label: 'E2EE اجباری پیام خصوصی', help: 'همه پیام‌های خصوصی جدید فقط به‌صورت سرتاسری رمز شوند' },
  { key: 'feature_pwa', label: 'نسخه PWA', help: 'نصب‌پذیری و حالت آفلاین' },
  { key: 'feature_webhooks', label: 'Webhook', help: 'ارسال امن رویدادهای خارجی' },
  { key: 'feature_api_keys', label: 'API Key', help: 'دسترسی برنامه‌نویسی کنترل‌شده' },
  { key: 'feature_voice_calls', label: 'تماس صوتی/تصویری', help: 'WebRTC و زیرساخت SFU' },
  { key: 'feature_push_notifications', label: 'Push Notification', help: 'اعلان مرورگر و موبایل' },
];

export function AdminPlatform() {
  const [state, setState] = useState<PlatformState | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [form, setForm] = useState<PlatformState['configuration']>({});
  const [busy, setBusy] = useState(false);
  const [fishModels, setFishModels] = useState<FishModel[]>([]);
  const [fishBusy, setFishBusy] = useState(false);
  const load = useCallback(async () => {
    const [platform, current] = await Promise.all([
      api.get<PlatformState>('/api/admin/platform'), api.get<{ settings: AdminSettings }>('/api/admin/settings'),
    ]);
    setState(platform); setForm(platform.configuration); setSettings(current.settings);
  }, []);
  useEffect(() => { void load().catch(() => toast.error('دریافت پیکربندی زیرساخت ناموفق بود.')); }, [load]);
  if (!state || !settings) return <Spinner label="در حال دریافت پیکربندی زیرساخت…" />;
  const set = (key: string, value: string | number | boolean) => setForm((current) => ({ ...current, [key]: value }));
  async function save() {
    setBusy(true);
    try {
      const result = await api.patch<{ configuration: PlatformState['configuration'] }>('/api/admin/platform/configuration', form);
      setForm(result.configuration); toast.success('پیکربندی رمز‌شده ذخیره و زنده اعمال شد.'); await load();
    } catch (error) { toast.error(error instanceof ApiError ? error.message : 'ذخیره پیکربندی ناموفق بود.'); }
    finally { setBusy(false); }
  }
  async function loadFishModels() {
    setFishBusy(true);
    try {
      const result = await api.get<{ models: FishModel[] }>('/api/admin/platform/fish-audio/models');
      setFishModels(result.models);
      toast.success(`${result.models.length.toLocaleString('fa-IR')} صدای Fish Audio دریافت شد.`);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : 'دریافت صداهای Fish Audio ناموفق بود.'); }
    finally { setFishBusy(false); }
  }
  return <>
    <section className="admin-hero compact-hero"><div><span className="eyebrow">Platform Control Plane</span><h2>زیرساخت را از یک نقطه مدیریت کنید.</h2>
      <p>اسرار SMTP و OIDC با AES-256-GCM ذخیره می‌شوند و هرگز به مرورگر بازگردانده نمی‌شوند.</p></div>
      <div className="hero-status"><strong>{state.storage.driver.toUpperCase()}</strong><small>{state.queue.enabled ? 'صف توزیع‌شده فعال' : 'پردازش درون‌برنامه‌ای'}</small></div></section>

    <div className="admin-split">
      <section className="settings-group admin-card"><h3>ورود یکپارچه OIDC</h3><p className="desc">پیکربندی زنده SSO؛ SAML و LDAP محیطی نیز پایش می‌شوند.</p>
        <Field label="Issuer URL" value={String(form['oidc.issuer'] ?? '')} onChange={(v) => set('oidc.issuer', v)} />
        <Field label="Client ID" value={String(form['oidc.clientId'] ?? '')} onChange={(v) => set('oidc.clientId', v)} />
        <Field label={`Client Secret ${form['oidc.clientSecretConfigured'] ? '(ثبت شده)' : ''}`} secret value="" onChange={(v) => set('oidc.clientSecret', v)} />
        <div className="row"><Field label="عنوان سرویس" value={String(form['oidc.label'] ?? '')} onChange={(v) => set('oidc.label', v)} />
          <Field label="Scopeها" value={String(form['oidc.scopes'] ?? '')} onChange={(v) => set('oidc.scopes', v)} /></div>
        <label className="checkbox"><input type="checkbox" checked={Boolean(form['oidc.autoProvision'])} onChange={(e) => set('oidc.autoProvision', e.target.checked)} /><span>ساخت خودکار حساب پس از ورود معتبر</span></label>
        <div className="provider-chips">{Object.entries(state.providers).filter(([key]) => key !== 'smtp' && key !== 'fishAudio').map(([key, value]) => <span className={value.configured ? 'ready' : ''} key={key}>{key.toUpperCase()} · {value.configured ? 'آماده' : 'تنظیم نشده'}</span>)}</div>
      </section>
      <section className="settings-group admin-card"><h3>SMTP و تحویل ایمیل</h3><p className="desc">اتصال Pool شده و تست سلامت بدون افشای رمز.</p>
        <div className="row"><Field label="Host" value={String(form['smtp.host'] ?? '')} onChange={(v) => set('smtp.host', v)} /><Field label="Port" type="number" value={String(form['smtp.port'] ?? 587)} onChange={(v) => set('smtp.port', Number(v))} /></div>
        <Field label="نام کاربری" value={String(form['smtp.user'] ?? '')} onChange={(v) => set('smtp.user', v)} />
        <Field label={`رمز عبور ${form['smtp.passConfigured'] ? '(ثبت شده)' : ''}`} secret value="" onChange={(v) => set('smtp.pass', v)} />
        <Field label="فرستنده" value={String(form['smtp.from'] ?? '')} onChange={(v) => set('smtp.from', v)} />
        <label className="checkbox"><input type="checkbox" checked={Boolean(form['smtp.secure'])} onChange={(e) => set('smtp.secure', e.target.checked)} /><span>TLS مستقیم (معمولاً پورت ۴۶۵)</span></label>
        <button className="btn" onClick={() => void api.post('/api/admin/platform/smtp/test').then(() => toast.success('ارتباط SMTP سالم است.')).catch(() => toast.error('تست SMTP ناموفق بود.'))}>تست اتصال SMTP</button>
      </section>
    </div>
    <section className="settings-group admin-card fish-audio-card">
      <div className="row between"><div><h3>تبدیل متن به گفتار Fish Audio</h3><p className="desc">کلید API رمز‌شده ذخیره می‌شود. خالی گذاشتن کلید، مقدار فعلی را تغییر نمی‌دهد.</p></div>
        <span className={`provider-pill ${state.providers.fishAudio?.configured ? 'ready' : ''}`}>{state.providers.fishAudio?.configured ? 'فعال' : state.providers.fishAudio?.keyConfigured ? 'انتخاب صدا لازم است' : 'تنظیم نشده'}</span>
      </div>
      <div className="row">
        <Field label={`Fish Audio API Key ${form['fishAudio.apiKeyConfigured'] ? '(ثبت شده)' : ''}`} secret value="" onChange={(v) => set('fishAudio.apiKey', v)} />
        <div className="field platform-field"><label>مدل تولید صدا</label><select className="input" dir="ltr" value={String(form['fishAudio.model'] ?? 's2-pro')} onChange={(e) => set('fishAudio.model', e.target.value)}><option value="s2-pro">s2-pro (پیشنهادی)</option><option value="s1">s1</option></select></div>
      </div>
      <div className="row fish-reference-row">
        <Field label="Voice Reference ID" value={String(form['fishAudio.referenceId'] ?? '')} onChange={(v) => set('fishAudio.referenceId', v)} />
        <button className="btn" disabled={fishBusy || !form['fishAudio.apiKeyConfigured']} onClick={() => void loadFishModels()}>{fishBusy ? 'در حال دریافت…' : 'دریافت صداهای حساب'}</button>
      </div>
      {fishModels.length ? <div className="field"><label>انتخاب صدای Fish Audio</label><select className="input" dir="ltr" value={String(form['fishAudio.referenceId'] ?? '')} onChange={(e) => set('fishAudio.referenceId', e.target.value)}><option value="">انتخاب کنید…</option>{fishModels.map((model) => <option key={model.id} value={model.id}>{model.title} · {model.languages.join(', ') || '—'}</option>)}</select></div> : null}
      <p className="security-note">متن پیام‌های معمولی برای ساخت صدا به Fish Audio ارسال می‌شود. متن پیام‌های E2EE هرگز به سرور یا Fish Audio فرستاده نمی‌شود و فقط روی دستگاه خوانده می‌شود.</p>
    </section>
    <button className="btn primary mb-16" disabled={busy} onClick={() => void save()}>{busy ? 'در حال ذخیره…' : 'ذخیره امن پیکربندی'}</button>

    <div className="stat-grid"><PlatformStat label="فضای مصرف‌شده" value={formatBytes(state.storage.bytes)} /><PlatformStat label="فایل‌ها" value={state.storage.count.toLocaleString('fa-IR')} />
      <PlatformStat label="قرنطینه" value={state.storage.quarantined.toLocaleString('fa-IR')} /><PlatformStat label="صف فعال" value={state.queue.active.toLocaleString('fa-IR')} />
      <PlatformStat label="صف در انتظار" value={state.queue.waiting.toLocaleString('fa-IR')} /><PlatformStat label="Job ناموفق" value={state.queue.failed.toLocaleString('fa-IR')} danger={state.queue.failed > 0} /></div>

    <div className="admin-split">
      <section className="settings-group admin-card"><div className="row between"><div><h3>پشتیبان‌گیری</h3><p className="desc">نگهداری {state.retentionDays.toLocaleString('fa-IR')} روزه و آزمون یکپارچگی</p></div>
        <button className="btn primary" onClick={() => void api.post('/api/admin/backups').then(() => { toast.success('Backup در صف قرار گرفت.'); return load(); })}>Backup فوری</button></div>
        <div className="compact-list">{state.backups.slice(0, 12).map((backup) => <div key={backup.id}><span><strong>{backup.status} · {formatBytes(backup.bytes)}</strong><small>{backup.provider} · {formatRelative(backup.startedAt)} {backup.error || ''}</small></span>
          {backup.status === 'completed' ? <button className="btn small" onClick={() => void api.post(`/api/admin/backups/${backup.id}/verify`).then(() => toast.success('Backup سالم و قابل بازیابی است.')).catch(() => toast.error('اعتبارسنجی Backup ناموفق بود.'))}>اعتبارسنجی</button> : null}</div>)}
          {!state.backups.length ? <p className="muted">هنوز Backup ثبت نشده است.</p> : null}</div>
      </section>
      <section className="settings-group admin-card"><h3>صف پردازش پس‌زمینه</h3><p className="desc">وضعیت Jobها، Retry و خطای نهایی BullMQ</p>
        <div className="compact-list">{state.queue.jobs.slice(0, 16).map((job) => <div key={job.id}><span><strong>{job.name}</strong><small>{job.state} · {formatRelative(job.timestamp)} {job.failedReason || ''}</small></span>
          <span className={job.state === 'failed' ? 'danger-text' : 'status-dot-text ok'}>{job.state}</span>{job.state === 'failed' ? <button className="btn small" onClick={() => void api.post(`/api/admin/queue/${encodeURIComponent(job.id)}/retry`).then(load)}>Retry</button> : null}</div>)}
          {!state.queue.enabled ? <p className="muted">Redis/BullMQ فعال نیست؛ در Production صف توزیع‌شده را الزامی کنید.</p> : null}</div>
      </section>
    </div>
    <section className="settings-group admin-card"><h3>Feature Flagهای محصول</h3><p className="desc">فعال‌سازی تدریجی قابلیت‌ها بدون Deploy مجدد</p>
      <div className="feature-flag-grid">{FLAGS.map((flag) => <label className="feature-flag" key={flag.key}><span><strong>{flag.label}</strong><small>{flag.help}</small></span>
        <input type="checkbox" checked={Boolean(settings[flag.key])} onChange={async (event) => { const next = event.target.checked; setSettings((current) => current ? { ...current, [flag.key]: next } : current);
          try { await api.patch('/api/admin/settings', { [flag.key]: next }); } catch { setSettings((current) => current ? { ...current, [flag.key]: !next } : current); toast.error('تغییر Feature Flag ناموفق بود.'); } }} /></label>)}</div>
    </section>
  </>;
}

function Field({ label, value, onChange, secret, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; secret?: boolean; type?: string }) {
  return <div className="field platform-field"><label>{label}</label><input className="input" dir="ltr" type={secret ? 'password' : type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" /></div>;
}
function PlatformStat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return <div className={`stat-card ${danger ? 'tone-red' : 'tone-blue'}`}><div className="value">{value}</div><div className="label">{label}</div></div>;
}
