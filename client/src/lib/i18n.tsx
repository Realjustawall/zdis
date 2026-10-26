import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storageGet, storageSet } from './storage';
import { languagePacks, translateUiText } from './localize';

export type Locale = string;
const STORAGE_KEY = 'zdis.locale';
export const availableLanguages = Object.freeze(Object.keys(languagePacks).sort((a, b) => a.localeCompare(b)));

export function languageName(locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function languageShortName(locale: Locale): string {
  if (locale.toLowerCase() === 'fa') return 'فا';
  return locale.split('-')[0].toUpperCase();
}

export function isRtlLanguage(locale: Locale): boolean {
  return /^(?:ar|arc|ckb|dv|fa|he|ku|nqo|ps|sd|syr|ug|ur|yi)(?:-|$)/i.test(locale);
}

function translateDomTree(root: Node, locale: Locale) {
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          '.message .content, .attachment-file, .custom-status, .user-bio, pre, code, [data-no-auto-translate]',
        )
      ) return;
      const value = node.nodeValue ?? '';
      const translated = translateUiText(value, locale);
      if (translated !== value) node.nodeValue = translated;
      return;
    }
    if (!(node instanceof Element) || node.closest('[data-no-auto-translate], script, style')) return;
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      const translated = translateUiText(value, locale);
      if (translated !== value) node.setAttribute(attribute, translated);
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
}

const messages = {
  fa: {
    'language.fa': 'فارسی', 'language.en': 'English', 'language.change': 'تغییر زبان',
    'login.tagline': 'فضایی خصوصی برای سازندگان محتوا و تیم‌هایشان.',
    'login.identifier': 'ایمیل یا نام کاربری', 'login.password': 'رمز عبور',
    'login.submit': 'ورود', 'login.submitting': 'در حال ورود…',
    'login.unreachable': 'ارتباط با سرور برقرار نشد.',
    'login.directoryFailed': 'ورود از طریق سرویس سازمانی ناموفق بود.',
    'login.mfaHelp': 'کد ۶ رقمی برنامه احراز هویت یا یکی از کدهای بازیابی را وارد کنید.',
    'login.mfaCode': 'کد احراز هویت', 'login.verify': 'تأیید و ورود',
    'login.verifying': 'در حال تأیید…', 'login.back': 'بازگشت',
    'login.continueWith': 'ادامه با {provider}', 'login.signInWith': 'ورود با {provider}',
    'login.private': 'حساب‌ها فقط توسط مدیر ساخته می‌شوند و ثبت‌نام عمومی غیرفعال است.',
    'login.needAccess': 'برای دریافت دسترسی با مدیر این سرور تماس بگیرید.',
    'nav.directMessages': 'پیام‌های خصوصی', 'nav.createGroup': 'ساخت گروه',
    'nav.joinGroup': 'عضویت با دعوت‌نامه', 'nav.notifications': 'اعلان‌ها',
    'nav.admin': 'مدیریت', 'nav.account': 'تنظیمات حساب', 'nav.logout': 'خروج',
    'status.reconnecting': 'در حال اتصال مجدد…', 'status.online': 'آنلاین',
    'status.offline': 'آفلاین', 'common.cancel': 'انصراف', 'common.save': 'ذخیره',
    'common.close': 'بستن', 'common.loading': 'در حال بارگذاری…', 'common.back': 'بازگشت',
    'common.copy': 'کپی', 'common.remove': 'حذف', 'common.working': 'در حال انجام…',
    'account.title': 'حساب کاربری شما', 'account.profile': 'پروفایل',
    'account.security': 'امنیت', 'account.notifications': 'اعلان‌ها',
    'account.sessions': 'نشست‌ها', 'account.status': 'وضعیت',
    'account.displayName': 'نام نمایشی', 'account.accent': 'رنگ پروفایل',
    'account.customStatus': 'وضعیت سفارشی', 'account.about': 'درباره شما',
    'account.save': 'ذخیره پروفایل', 'account.saving': 'در حال ذخیره…',
    'account.saved': 'پروفایل با موفقیت به‌روزرسانی شد.',
    'account.saveFailed': 'ذخیره پروفایل انجام نشد.',
    'account.avatar.change': 'تغییر تصویر', 'account.avatar.remove': 'حذف تصویر',
    'account.avatar.help': 'تصویر PNG، JPEG، GIF، WebP یا BMP انتخاب کنید.',
    'account.avatar.uploading': 'در حال بارگذاری…',
    'account.avatar.saved': 'تصویر پروفایل به‌روزرسانی شد.',
    'account.avatar.failed': 'بارگذاری تصویر پروفایل انجام نشد.',
    'account.statusPlaceholder': 'مثلاً در حال ویرایش ویدیوی جدید',
    'presence.online': 'آنلاین', 'presence.idle': 'بیکار',
    'presence.dnd': 'مزاحم نشوید', 'presence.offline': 'نمایش به‌صورت آفلاین',
    'ui.close': 'بستن', 'ui.confirm': 'تأیید', 'ui.cancel': 'انصراف',
    'ui.fixFollowing': 'لطفاً موارد زیر را اصلاح کنید:',
    'theme.light': 'روشن', 'theme.dark': 'تیره', 'theme.system': 'سیستم',
    'theme.label': 'پوسته', 'theme.change': 'تغییر پوسته؛ حالت فعلی {theme}',
    'theme.customize': 'شخصی‌سازی ظاهر',
    'welcome.title': 'خوش آمدی، {name}',
    'welcome.body': 'یک گفتگو را انتخاب کنید، وارد گروه شوید یا از فهرست اعضا گفتگویی تازه آغاز کنید.',
    'pwa.install': 'نصب برنامه', 'pwa.update': 'نسخه جدید آماده است',
    'pwa.reload': 'به‌روزرسانی', 'pwa.updating': 'در حال به‌روزرسانی…', 'pwa.offline': 'اتصال اینترنت قطع است؛ پس از برقراری اتصال دوباره همگام می‌شویم.',
  },
  en: {
    'language.fa': 'فارسی', 'language.en': 'English', 'language.change': 'Change language',
    'login.tagline': 'A private space for creators and their teams.',
    'login.identifier': 'Email or username', 'login.password': 'Password',
    'login.submit': 'Sign in', 'login.submitting': 'Signing in…',
    'login.unreachable': 'Could not reach the server.', 'login.directoryFailed': 'Directory sign-in failed.',
    'login.mfaHelp': 'Enter the 6-digit code from your authenticator app or a recovery code.',
    'login.mfaCode': 'Authentication code', 'login.verify': 'Verify and sign in',
    'login.verifying': 'Verifying…', 'login.back': 'Back',
    'login.continueWith': 'Continue with {provider}', 'login.signInWith': 'Sign in with {provider}',
    'login.private': 'Accounts are created by an administrator; public sign-up is disabled.',
    'login.needAccess': 'Need access? Ask the person who runs this server.',
    'nav.directMessages': 'Direct messages', 'nav.createGroup': 'Create a group',
    'nav.joinGroup': 'Join with an invite', 'nav.notifications': 'Notifications',
    'nav.admin': 'Administration', 'nav.account': 'Account settings', 'nav.logout': 'Sign out',
    'status.reconnecting': 'Reconnecting…', 'status.online': 'Online', 'status.offline': 'Offline',
    'common.cancel': 'Cancel', 'common.save': 'Save', 'common.close': 'Close',
    'common.loading': 'Loading…', 'common.back': 'Back',
    'common.copy': 'Copy', 'common.remove': 'Remove', 'common.working': 'Working…',
    'account.title': 'Your account', 'account.profile': 'Profile',
    'account.security': 'Security', 'account.notifications': 'Notifications',
    'account.sessions': 'Sessions', 'account.status': 'Status',
    'account.displayName': 'Display name', 'account.accent': 'Accent colour',
    'account.customStatus': 'Custom status', 'account.about': 'About you',
    'account.save': 'Save profile', 'account.saving': 'Saving…',
    'account.saved': 'Profile updated.',
    'account.saveFailed': 'Could not save the profile.',
    'account.avatar.change': 'Change picture', 'account.avatar.remove': 'Remove picture',
    'account.avatar.help': 'Choose a PNG, JPEG, GIF, WebP or BMP image.',
    'account.avatar.uploading': 'Uploading…',
    'account.avatar.saved': 'Profile picture updated.',
    'account.avatar.failed': 'Could not upload the profile picture.',
    'account.statusPlaceholder': 'Editing the next upload',
    'presence.online': 'Online', 'presence.idle': 'Idle',
    'presence.dnd': 'Do not disturb', 'presence.offline': 'Appear offline',
    'ui.close': 'Close', 'ui.confirm': 'Confirm', 'ui.cancel': 'Cancel',
    'ui.fixFollowing': 'Please fix the following:',
    'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
    'theme.label': 'Theme', 'theme.change': 'Change theme; current mode {theme}',
    'theme.customize': 'Customize appearance',
    'welcome.title': 'Welcome back, {name}',
    'welcome.body': 'Pick a conversation, open a group, or browse the member directory to begin.',
    'pwa.install': 'Install app', 'pwa.update': 'A new version is ready',
    'pwa.reload': 'Update now', 'pwa.updating': 'Updating…', 'pwa.offline': 'You are offline; changes will sync when the connection returns.',
  },
} as const;

export type MessageKey = string;
type Translator = (key: MessageKey, values?: Record<string, string | number>) => string;
const I18nContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void; t: Translator }>({
  locale: 'en', setLocale: () => undefined, t: (key) => languagePacks.en?.[key] ?? messages.en[key as keyof (typeof messages)['en']] ?? key,
});

function initialLocale(): Locale {
  const saved = storageGet(STORAGE_KEY);
  if (saved && availableLanguages.includes(saved)) return saved;
  const normalized = new Map(availableLanguages.map((locale) => [locale.toLowerCase(), locale]));
  for (const requested of navigator.languages ?? [navigator.language]) {
    const exact = normalized.get(requested.toLowerCase());
    if (exact) return exact;
    const base = normalized.get(requested.split('-')[0].toLowerCase());
    if (base) return base;
  }
  return availableLanguages.includes('en') ? 'en' : (availableLanguages[0] ?? 'en');
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    if (!availableLanguages.includes(next) || next === locale) return;
    storageSet(STORAGE_KEY, next);
    setLocaleState(next);
    window.location.reload();
  }, [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtlLanguage(locale) ? 'rtl' : 'ltr';
  }, [locale]);
  useEffect(() => {
    if (!document.body) return;
    translateDomTree(document.body, locale);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' || mutation.type === 'characterData') {
          translateDomTree(mutation.target, locale);
        }
        for (const node of mutation.addedNodes) translateDomTree(node, locale);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label'],
    });
    return () => observer.disconnect();
  }, [locale]);
  const t = useCallback<Translator>((key, values) => {
    const builtIn = messages[locale as keyof typeof messages];
    let value: string = languagePacks[locale]?.[key] ?? builtIn?.[key as keyof typeof messages.en] ?? languagePacks.en?.[key] ?? messages.en[key as keyof (typeof messages)['en']] ?? key;
    for (const [name, replacement] of Object.entries(values ?? {})) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
