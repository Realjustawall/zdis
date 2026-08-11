import { useEffect, useRef, useState } from 'react';
import { availableLanguages, languageName, languageShortName, useI18n } from '../lib/i18n';

function LanguageMenu({ compact }: { compact: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className={`language-menu${compact ? ' compact' : ''}`} ref={rootRef}>
      <button className={compact ? 'theme-compact language-compact' : 'language-menu-trigger'}
        type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu"
        aria-expanded={open} title={t('language.change')} aria-label={t('language.change')}>
        <span>{compact ? languageShortName(locale) : languageName(locale)}</span>
        <span className="language-menu-chevron" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="language-menu-list" role="menu">
          {availableLanguages.map((item) => (
            <button key={item} type="button" role="menuitemradio" aria-checked={locale === item}
              className={locale === item ? 'active' : ''} onClick={() => setLocale(item)}>
              <span>{languageName(item)}</span>
              <small>{item}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  if (availableLanguages.length > 2) return <LanguageMenu compact={compact} />;
  const next = availableLanguages.find((item) => item !== locale) ?? locale;
  if (compact) {
    return (
      <button className="theme-compact language-compact" onClick={() => setLocale(next)}
        title={t('language.change')} aria-label={t('language.change')}>
        {languageShortName(next)}
      </button>
    );
  }
  return (
    <div className="theme-switcher" role="group" aria-label={t('language.change')}>
      {availableLanguages.map((item) => (
        <button key={item} className={locale === item ? 'active' : ''}
          onClick={() => setLocale(item)} aria-pressed={locale === item}>
          {languageName(item)}
        </button>
      ))}
    </div>
  );
}
