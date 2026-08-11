import { useTheme, type ThemePreference } from '../lib/theme';
import { useI18n } from '../lib/i18n';
import { Icon, type IconName } from './Icon';

const themes: Array<{ id: ThemePreference; icon: IconName }> = [
  { id: 'light', icon: 'sun' },
  { id: 'dark', icon: 'moon' },
  { id: 'system', icon: 'system' },
];

export function ThemeSwitcher({ compact = false, onOpenStudio }: { compact?: boolean; onOpenStudio?: () => void }) {
  const [theme, changeTheme] = useTheme();
  const { t } = useI18n();
  if (compact) {
    const current = themes.find((item) => item.id === theme) ?? themes[2];
    const next = themes[(themes.indexOf(current) + 1) % themes.length];
    const label = t(`theme.${current.id}`);
    return (
      <span className="theme-compact-wrap">
        <button className="theme-compact" onClick={() => changeTheme(next.id)}
          title={`${t('theme.label')}: ${label}`} aria-label={t('theme.change', { theme: label })}>
          <Icon name={current.icon} size={17} />
        </button>
        {onOpenStudio ? (
          <button className="theme-compact theme-studio-trigger" onClick={onOpenStudio}
            title={t('theme.customize')} aria-label={t('theme.customize')}>
            <Icon name="palette" size={16} />
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <div className="theme-switcher" role="group" aria-label={t('theme.label')}>
      {themes.map((item) => (
        <button key={item.id} className={theme === item.id ? 'active' : ''}
          onClick={() => changeTheme(item.id)} aria-pressed={theme === item.id}>
          <span><Icon name={item.icon} size={15} /></span>
          {t(`theme.${item.id}`)}
        </button>
      ))}
    </div>
  );
}
