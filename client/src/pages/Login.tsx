import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../store/session';
import { api, ApiError } from '../lib/api';
import { ErrorList } from '../components/ui';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { useI18n } from '../lib/i18n';
import type { PublicSettings } from '../types';

type AuthMode = 'login' | 'register';

const PASSWORD_RULES = [
  { key: 'length', test: (value: string) => value.length >= 10 },
  { key: 'case', test: (value: string) => /[a-z]/.test(value) && /[A-Z]/.test(value) },
  { key: 'number', test: (value: string) => /[0-9]/.test(value) },
  { key: 'symbol', test: (value: string) => /[^A-Za-z0-9]/.test(value) },
] as const;

export function Login() {
  const { t, locale } = useI18n();
  const fa = locale === 'fa';
  const login = useSession((state) => state.login);
  const ldapLogin = useSession((state) => state.ldapLogin);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [registered, setRegistered] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [registration, setRegistration] = useState({
    phone: '',
    email: '',
    firstName: '',
    lastName: '',
    username: '',
    nickname: '',
    password: '',
  });
  const [providers, setProviders] = useState<
    Array<{ id: 'oidc' | 'saml' | 'ldap'; label: string; mode: 'redirect' | 'credentials' }>
  >([]);

  useEffect(() => {
    api
      .get<{ settings: PublicSettings }>('/api/auth/public-settings')
      .then((result) => {
        setSettings(result.settings);
        if (
          result.settings.registration_enabled &&
          new URLSearchParams(window.location.search).get('register') === '1'
        ) {
          setMode('register');
        }
      })
      .catch(() => undefined);
    api
      .get<{ providers: typeof providers }>('/api/auth/sso/providers')
      .then((result) => setProviders(result.providers))
      .catch(() => undefined);
  }, []);

  const copy = fa
    ? {
        welcome: 'دوباره خوش آمدید!',
        loginLead: 'از دیدنتان خوشحالیم. برای ادامه وارد حساب شوید.',
        registerTitle: 'حساب کاربری بسازید',
        registerLead: 'به جامعه بپیوندید و گفتگو را شروع کنید.',
        loginTab: 'ورود',
        registerTab: 'ثبت‌نام',
        firstName: 'نام',
        lastName: 'نام خانوادگی',
        nickname: 'نام نمایشی',
        username: 'نام کاربری',
        email: 'ایمیل',
        phone: 'شماره تلفن',
        password: 'رمز عبور',
        confirm: 'تکرار رمز عبور',
        show: 'نمایش',
        hide: 'پنهان',
        create: 'ساخت حساب',
        creating: 'در حال ساخت…',
        noAccount: 'هنوز حساب ندارید؟',
        haveAccount: 'حساب دارید؟',
        createLink: 'ثبت‌نام',
        loginLink: 'وارد شوید',
        or: 'یا با سرویس سازمانی ادامه دهید',
        secure: 'ارتباط امن و رمزگذاری‌شده',
        communities: 'سرورها، نقش‌ها و دسترسی‌های دقیق',
        voice: 'گفتگوی متنی، صوتی و انجمن‌ها در یک جا',
        showcaseTitle: 'جایی برای تیم‌ها، دوستان و جامعه شما',
        showcaseBody:
          'گفتگوها را مرتب نگه دارید، نقش‌ها را مدیریت کنید و همیشه در ارتباط بمانید.',
        length: 'حداقل ۱۰ کاراکتر',
        case: 'حروف کوچک و بزرگ',
        number: 'حداقل یک عدد',
        symbol: 'حداقل یک نماد',
        mismatch: 'تکرار رمز عبور با رمز عبور یکسان نیست.',
        created: 'حساب شما ساخته شد. حالا وارد شوید.',
        verifyTitle: 'تأیید دومرحله‌ای',
        verifyLead: 'یک مرحله دیگر برای حفاظت از حساب شما باقی مانده است.',
        back: 'بازگشت به ورود',
        legal: 'با ادامه، قوانین و سیاست‌های این فضای خصوصی را می‌پذیرید.',
      }
    : {
        welcome: 'Welcome back!',
        loginLead: "We're glad to see you again. Sign in to continue.",
        registerTitle: 'Create your account',
        registerLead: 'Join the community and start the conversation.',
        loginTab: 'Sign in',
        registerTab: 'Register',
        firstName: 'First name',
        lastName: 'Last name',
        nickname: 'Display name',
        username: 'Username',
        email: 'Email',
        phone: 'Phone number',
        password: 'Password',
        confirm: 'Confirm password',
        show: 'Show',
        hide: 'Hide',
        create: 'Create account',
        creating: 'Creating…',
        noAccount: 'Need an account?',
        haveAccount: 'Already have an account?',
        createLink: 'Register',
        loginLink: 'Sign in',
        or: 'Or continue with your organization',
        secure: 'Secure, encrypted communication',
        communities: 'Servers, roles, and precise access controls',
        voice: 'Text, voice, stages, and forums together',
        showcaseTitle: 'A place for your teams, friends, and communities',
        showcaseBody:
          'Keep conversations organized, manage roles, and stay close wherever you are.',
        length: 'At least 10 characters',
        case: 'Uppercase and lowercase letters',
        number: 'At least one number',
        symbol: 'At least one symbol',
        mismatch: 'The password confirmation does not match.',
        created: 'Your account is ready. Sign in to continue.',
        verifyTitle: 'Two-factor authentication',
        verifyLead: 'One more step keeps your account protected.',
        back: 'Back to sign in',
        legal: 'By continuing, you agree to the rules and policies of this private community.',
      };

  const appName = settings?.app_name || 'sahsha';
  const passwordScore = useMemo(
    () => PASSWORD_RULES.filter((rule) => rule.test(registration.password)).length,
    [registration.password],
  );
  const passwordValid = passwordScore === PASSWORD_RULES.length;
  const updateRegistration = (key: keyof typeof registration, value: string) =>
    setRegistration((current) => ({ ...current, [key]: value }));

  function switchMode(next: AuthMode) {
    setMode(next);
    setErrors([]);
    setRegistered(false);
    setNeedsTotp(false);
    setTotp('');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const result = await login(identifier, password, needsTotp ? totp : undefined);
      if (result === 'mfa') {
        setNeedsTotp(true);
        setErrors([]);
      }
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : [t('login.unreachable')]);
    } finally {
      setBusy(false);
    }
  }

  async function loginWithLdap() {
    setErrors([]);
    setBusy(true);
    try {
      await ldapLogin(identifier, password);
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : [t('login.directoryFailed')]);
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(event: FormEvent) {
    event.preventDefault();
    setErrors([]);
    if (registration.password !== confirmPassword) {
      setErrors([copy.mismatch]);
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/register', registration);
      setIdentifier(registration.username);
      setPassword('');
      setConfirmPassword('');
      setRegistered(true);
      setMode('login');
    } catch (error) {
      setErrors(error instanceof ApiError ? error.lines : [t('login.unreachable')]);
    } finally {
      setBusy(false);
    }
  }

  const pageTitle = needsTotp
    ? copy.verifyTitle
    : mode === 'login'
      ? settings?.login_title || copy.welcome
      : settings?.signup_title || copy.registerTitle;
  const pageLead = needsTotp
    ? copy.verifyLead
    : mode === 'login'
      ? settings?.login_subtitle || copy.loginLead
      : settings?.signup_subtitle || copy.registerLead;

  return (
    <main className={`auth-screen auth-${mode}`}>
      <div className="auth-ambient auth-ambient-one" />
      <div className="auth-ambient auth-ambient-two" />
      <div className="auth-particles" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => <i key={index} />)}
      </div>
      <header className="auth-topbar">
        <div className="auth-wordmark">
          {settings?.app_logo_url ? (
            <img src={settings.app_logo_url} alt="" />
          ) : (
            <span className="auth-wordmark-mark">S</span>
          )}
          <strong>{appName}</strong>
        </div>
        <div className="auth-preferences">
          <span className={`auth-access-mode${settings?.registration_enabled ? ' open' : ''}`}>
            <i />
            {settings?.registration_enabled
              ? (fa ? 'ثبت‌نام باز است' : 'Registration open')
              : (fa ? 'فقط با دعوت' : 'Invite only')}
          </span>
          <LanguageSwitcher />
          <ThemeSwitcher />
        </div>
      </header>

      <div className={`auth-shell${mode === 'register' ? ' register' : ''}`}>
        <aside className="auth-showcase" aria-hidden="true">
          <div className="auth-showcase-copy">
            <span className="auth-eyebrow">SAHSHA COMMUNITY</span>
            <h1>{copy.showcaseTitle}</h1>
            <p>{copy.showcaseBody}</p>
          </div>
          <AuthCommunityPreview appName={appName} fa={fa} />
          <div className="auth-live-pills">
            <span><i className="online" /> {fa ? '۴۲ نفر آنلاین' : '42 online now'}</span>
            <span><i className="voice" /> {fa ? '۵ اتاق فعال' : '5 active rooms'}</span>
            <span><i className="secure" /> {fa ? 'ارتباط امن' : 'Secure by default'}</span>
          </div>
          <div className="auth-benefits">
            <span>✓ {copy.secure}</span>
            <span>✓ {copy.communities}</span>
            <span>✓ {copy.voice}</span>
          </div>
        </aside>

        <section className="auth-card">
          <form
            className="auth-form"
            onSubmit={mode === 'login' ? onSubmit : onRegister}
            noValidate={false}
          >
            <div className="auth-mobile-brand">
              {settings?.app_logo_url ? (
                <img src={settings.app_logo_url} alt="" />
              ) : (
                <span>S</span>
              )}
              <strong>{appName}</strong>
            </div>

            {!needsTotp && settings?.registration_enabled ? (
              <div className="auth-tabs" role="tablist" aria-label="Authentication">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'login'}
                  className={mode === 'login' ? 'active' : ''}
                  onClick={() => switchMode('login')}
                >
                  {copy.loginTab}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'register'}
                  className={mode === 'register' ? 'active' : ''}
                  onClick={() => switchMode('register')}
                >
                  {copy.registerTab}
                </button>
              </div>
            ) : null}

            <div className="auth-heading">
              {needsTotp ? <div className="auth-mfa-icon">✦</div> : null}
              <h2>{pageTitle}</h2>
              <p>{pageLead}</p>
            </div>

            {errors.length > 0 ? <ErrorList lines={errors} /> : null}
            {registered ? <div className="alert success">{copy.created}</div> : null}

            {mode === 'register' ? (
              <div className="auth-fields">
                <div className="auth-field-grid">
                  <AuthField
                    label={copy.firstName}
                    value={registration.firstName}
                    onChange={(value) => updateRegistration('firstName', value)}
                    autoComplete="given-name"
                    icon="A"
                  />
                  <AuthField
                    label={copy.lastName}
                    value={registration.lastName}
                    onChange={(value) => updateRegistration('lastName', value)}
                    autoComplete="family-name"
                    icon="B"
                  />
                </div>
                <div className="auth-field-grid">
                  <AuthField
                    label={copy.nickname}
                    value={registration.nickname}
                    onChange={(value) => updateRegistration('nickname', value)}
                    autoComplete="nickname"
                    maxLength={48}
                    icon="✦"
                  />
                  <AuthField
                    label={copy.username}
                    value={registration.username}
                    onChange={(value) =>
                      updateRegistration(
                        'username',
                        value.toLowerCase().replace(/[^a-z0-9._-]/g, ''),
                      )
                    }
                    autoComplete="username"
                    maxLength={32}
                    icon="@"
                    hint="a-z · 0-9 · . _ -"
                    dir="ltr"
                  />
                </div>
                <div className="auth-field-grid">
                  <AuthField
                    label={copy.email}
                    value={registration.email}
                    onChange={(value) => updateRegistration('email', value)}
                    autoComplete="email"
                    type="email"
                    icon="✉"
                    dir="ltr"
                  />
                  <AuthField
                    label={copy.phone}
                    value={registration.phone}
                    onChange={(value) =>
                      updateRegistration('phone', value.replace(/[^\d+]/g, ''))
                    }
                    autoComplete="tel"
                    type="tel"
                    placeholder="+989121234567"
                    icon="☎"
                    dir="ltr"
                  />
                </div>
                <div className="auth-field-grid">
                  <AuthPasswordField
                    label={copy.password}
                    value={registration.password}
                    onChange={(value) => updateRegistration('password', value)}
                    visible={showPassword}
                    onToggle={() => setShowPassword((current) => !current)}
                    showLabel={copy.show}
                    hideLabel={copy.hide}
                    autoComplete="new-password"
                  />
                  <AuthPasswordField
                    label={copy.confirm}
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    visible={showPassword}
                    onToggle={() => setShowPassword((current) => !current)}
                    showLabel={copy.show}
                    hideLabel={copy.hide}
                    autoComplete="new-password"
                    invalid={Boolean(confirmPassword && confirmPassword !== registration.password)}
                  />
                </div>
                <div className="auth-password-policy">
                  <div className="auth-strength" aria-label={`${passwordScore} / 4`}>
                    {PASSWORD_RULES.map((rule, index) => (
                      <i
                        key={rule.key}
                        className={index < passwordScore ? `active score-${passwordScore}` : ''}
                      />
                    ))}
                  </div>
                  <div className="auth-rule-list">
                    {PASSWORD_RULES.map((rule) => (
                      <span
                        className={rule.test(registration.password) ? 'met' : ''}
                        key={rule.key}
                      >
                        {rule.test(registration.password) ? '✓' : '○'} {copy[rule.key]}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  className="btn primary auth-submit"
                  type="submit"
                  disabled={
                    busy ||
                    !passwordValid ||
                    registration.password !== confirmPassword ||
                    !registration.email ||
                    !registration.username ||
                    !registration.phone ||
                    !registration.firstName ||
                    !registration.lastName ||
                    !registration.nickname
                  }
                >
                  {busy ? copy.creating : copy.create}
                </button>
                <p className="auth-switch-copy">
                  {copy.haveAccount}{' '}
                  <button type="button" onClick={() => switchMode('login')}>
                    {copy.loginLink}
                  </button>
                </p>
              </div>
            ) : needsTotp ? (
              <div className="auth-fields">
                <div className="auth-mfa-note">{t('login.mfaHelp')}</div>
                <label className="auth-field">
                  <span>{t('login.mfaCode')}</span>
                  <div className="auth-input-wrap auth-code-input">
                    <i>⌁</i>
                    <input
                      value={totp}
                      onChange={(event) =>
                        setTotp(event.target.value.toUpperCase().slice(0, 32))
                      }
                      autoComplete="one-time-code"
                      placeholder="000 000"
                      inputMode="numeric"
                      dir="ltr"
                      autoFocus
                      required
                    />
                  </div>
                </label>
                <button
                  className="btn primary auth-submit"
                  type="submit"
                  disabled={busy || totp.length < 6}
                >
                  {busy ? t('login.verifying') : t('login.verify')}
                </button>
                <button
                  type="button"
                  className="auth-text-button"
                  onClick={() => {
                    setNeedsTotp(false);
                    setTotp('');
                  }}
                >
                  ← {copy.back}
                </button>
              </div>
            ) : (
              <div className="auth-fields">
                <AuthField
                  label={t('login.identifier')}
                  value={identifier}
                  onChange={setIdentifier}
                  autoComplete="username"
                  icon="@"
                  autoFocus
                />
                <AuthPasswordField
                  label={t('login.password')}
                  value={password}
                  onChange={setPassword}
                  visible={showPassword}
                  onToggle={() => setShowPassword((current) => !current)}
                  showLabel={copy.show}
                  hideLabel={copy.hide}
                  autoComplete="current-password"
                />
                <button
                  className="btn primary auth-submit"
                  type="submit"
                  disabled={busy || !identifier || !password}
                >
                  {busy ? t('login.submitting') : t('login.submit')}
                </button>

                {providers.length ? (
                  <>
                    <div className="auth-divider"><span>{copy.or}</span></div>
                    <div className="auth-provider-list">
                      {providers.map((provider) =>
                        provider.mode === 'redirect' ? (
                          <a
                            key={provider.id}
                            className="auth-provider"
                            href={`/api/auth/sso/${provider.id}/start`}
                          >
                            <span>{provider.id === 'saml' ? 'S' : '◈'}</span>
                            {t('login.continueWith', { provider: provider.label })}
                          </a>
                        ) : (
                          <button
                            key={provider.id}
                            className="auth-provider"
                            type="button"
                            disabled={busy || !identifier || !password}
                            onClick={() => void loginWithLdap()}
                          >
                            <span>⌘</span>
                            {t('login.signInWith', { provider: provider.label })}
                          </button>
                        ),
                      )}
                    </div>
                  </>
                ) : null}

                {settings?.registration_enabled ? (
                  <p className="auth-switch-copy">
                    {copy.noAccount}{' '}
                    <button type="button" onClick={() => switchMode('register')}>
                      {copy.createLink}
                    </button>
                  </p>
                ) : null}
              </div>
            )}

            <footer className="auth-footer">
              <p>
                {settings?.login_footer_text ||
                  (settings?.registration_enabled
                    ? copy.legal
                    : `${t('login.private')} ${t('login.needAccess')}`)}
              </p>
              <span><i /> {copy.secure}</span>
            </footer>
          </form>
        </section>
      </div>
    </main>
  );
}

function AuthField({
  label,
  value,
  onChange,
  icon,
  hint,
  type = 'text',
  dir,
  ...inputProps
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  icon: string;
  hint?: string;
  type?: string;
  dir?: 'ltr' | 'rtl';
  autoComplete?: string;
  autoFocus?: boolean;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <label className="auth-field">
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <div className="auth-input-wrap">
        <i>{icon}</i>
        <input
          {...inputProps}
          type={type}
          value={value}
          dir={dir}
          onChange={(event) => onChange(event.target.value)}
          required
        />
      </div>
    </label>
  );
}

function AuthPasswordField({
  label,
  value,
  onChange,
  visible,
  onToggle,
  showLabel,
  hideLabel,
  autoComplete,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  autoComplete: string;
  invalid?: boolean;
}) {
  return (
    <label className={`auth-field${invalid ? ' invalid' : ''}`}>
      <span>{label}</span>
      <div className="auth-input-wrap">
        <i>●</i>
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          dir="ltr"
          required
        />
        <button type="button" onClick={onToggle}>
          {visible ? hideLabel : showLabel}
        </button>
      </div>
    </label>
  );
}

function AuthCommunityPreview({ appName, fa }: { appName: string; fa: boolean }) {
  return (
    <div className="auth-community-preview">
      <div className="auth-preview-rail">
        <b>{appName.slice(0, 1).toUpperCase()}</b>
        <i />
        <span>CR</span>
        <span>ST</span>
        <button>＋</button>
      </div>
      <div className="auth-preview-channels">
        <strong>{fa ? 'جامعه سازندگان' : 'CREATOR COMMUNITY'}⌄</strong>
        <small>{fa ? 'کانال‌های متنی' : 'TEXT CHANNELS'}</small>
        <span className="active"># {fa ? 'عمومی' : 'general'}</span>
        <span># {fa ? 'ایده‌های محتوا' : 'content-ideas'}</span>
        <span># {fa ? 'همکاری' : 'collaborations'}</span>
        <small>{fa ? 'کانال‌های صوتی' : 'VOICE CHANNELS'}</small>
        <span>◉ {fa ? 'اتاق استودیو' : 'Studio room'}</span>
        <span>♬ {fa ? 'پشت صحنه' : 'Behind the scenes'}</span>
      </div>
      <div className="auth-preview-chat">
        <header>
          <span>#</span>
          <strong>{fa ? 'عمومی' : 'general'}</strong>
          <i />
          <b>⌕</b>
        </header>
        <div className="auth-preview-messages">
          <div>
            <span className="preview-avatar purple">N</span>
            <p>
              <strong>{fa ? 'نیلوفر' : 'Nila'} <small>10:24</small></strong>
              {fa ? 'ویدیوی جدید آماده بررسیه 🎬' : 'The new video is ready for review 🎬'}
            </p>
          </div>
          <div>
            <span className="preview-avatar green">A</span>
            <p>
              <strong>{fa ? 'امیر' : 'Amir'} <small>10:26</small></strong>
              {fa ? 'عالیه! الان بازخورد می‌فرستم.' : 'Looks great! Sending feedback now.'}
              <em>🔥 4</em>
            </p>
          </div>
          <div>
            <span className="preview-avatar orange">S</span>
            <p>
              <strong>{fa ? 'سارا' : 'Sara'} <small>10:31</small></strong>
              {fa ? 'برای ساعت ۸ رویداد ساختم.' : 'I scheduled the event for 8 PM.'}
            </p>
          </div>
        </div>
        <div className="auth-preview-composer">
          <span>＋</span>
          <p>{fa ? 'پیام به #عمومی' : 'Message #general'}</p>
          <b>☺</b>
        </div>
      </div>
    </div>
  );
}
