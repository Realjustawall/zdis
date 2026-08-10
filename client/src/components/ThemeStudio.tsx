import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useI18n } from '../lib/i18n';
import {
  DEFAULT_CUSTOM_THEME,
  DEFAULT_UI_PREFERENCES,
  getCustomTheme,
  getUiPreferences,
  resetCustomTheme,
  saveCustomTheme,
  saveUiPreferences,
  type CustomTheme,
  type ThemePreference,
  type UiPreferences,
  useTheme,
} from '../lib/theme';
import { Icon } from './Icon';
import { Modal } from './ui';

const PRESETS: Array<{ id: string; name: string; description: string; theme: CustomTheme }> = [
  {
    id: 'discord',
    name: 'Discord midnight',
    description: 'The familiar blue and graphite workspace.',
    theme: DEFAULT_CUSTOM_THEME,
  },
  {
    id: 'amoled',
    name: 'AMOLED black',
    description: 'Deep black surfaces for OLED screens.',
    theme: { ...DEFAULT_CUSTOM_THEME, accent: '#7289da', accentHover: '#8799e8', background: '#030406', rail: '#07090d', sidebar: '#0b0e14', panel: '#11151e', elevated: '#171c27', input: '#1d2432' },
  },
  {
    id: 'aurora',
    name: 'Aurora violet',
    description: 'Violet accents with a soft midnight gradient.',
    theme: { ...DEFAULT_CUSTOM_THEME, accent: '#9b6cff', accentHover: '#b08aff', background: '#0d0918', rail: '#15102a', sidebar: '#1b1434', panel: '#211a3d', elevated: '#2b2250', input: '#33275d' },
  },
  {
    id: 'forest',
    name: 'Forest signal',
    description: 'A calm green interface for long sessions.',
    theme: { ...DEFAULT_CUSTOM_THEME, accent: '#35c48b', accentHover: '#54dba3', background: '#07110f', rail: '#0b1815', sidebar: '#10211c', panel: '#152a23', elevated: '#1c372d', input: '#234237' },
  },
  {
    id: 'sunset',
    name: 'Sunset studio',
    description: 'Warm coral controls over a deep plum base.',
    theme: { ...DEFAULT_CUSTOM_THEME, accent: '#ff6b8a', accentHover: '#ff87a0', background: '#160b15', rail: '#211020', sidebar: '#2b1529', panel: '#351b32', elevated: '#44223f', input: '#512849' },
  },
];

const COLOR_FIELDS: Array<{ key: keyof CustomTheme; label: string }> = [
  { key: 'accent', label: 'Accent' },
  { key: 'background', label: 'App background' },
  { key: 'rail', label: 'Server rail' },
  { key: 'sidebar', label: 'Sidebar' },
  { key: 'panel', label: 'Chat panel' },
  { key: 'elevated', label: 'Cards & popovers' },
  { key: 'input', label: 'Inputs' },
  { key: 'text', label: 'Main text' },
  { key: 'muted', label: 'Muted text' },
];

export function ThemeStudio({ onClose }: { onClose: () => void }) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const [themePreference, setThemePreference] = useTheme();
  const [customTheme, setCustomTheme] = useState<CustomTheme>(getCustomTheme);
  const [preferences, setPreferences] = useState<UiPreferences>(getUiPreferences);

  useEffect(() => {
    const sync = () => {
      setCustomTheme(getCustomTheme());
      setPreferences(getUiPreferences());
    };
    window.addEventListener('zdis:theme-change', sync);
    return () => window.removeEventListener('zdis:theme-change', sync);
  }, []);

  const activePreset = useMemo(
    () => PRESETS.find((preset) => JSON.stringify(preset.theme) === JSON.stringify(customTheme))?.id ?? 'custom',
    [customTheme],
  );

  function updateTheme(key: keyof CustomTheme, value: string) {
    const next = { ...customTheme, [key]: value };
    setCustomTheme(next);
    saveCustomTheme(next);
  }

  function updatePreferences(patch: Partial<UiPreferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    saveUiPreferences(next);
  }

  function choosePreset(preset: (typeof PRESETS)[number]) {
    setCustomTheme(preset.theme);
    saveCustomTheme(preset.theme);
    setThemePreference('dark');
  }

  function reset() {
    resetCustomTheme();
    setCustomTheme(DEFAULT_CUSTOM_THEME);
    setPreferences(DEFAULT_UI_PREFERENCES);
    saveUiPreferences(DEFAULT_UI_PREFERENCES);
    setThemePreference('system');
  }

  const modeOptions: Array<{ id: ThemePreference; label: string; icon: 'moon' | 'sun' | 'system' }> = [
    { id: 'dark', label: fa ? 'تیره' : 'Dark', icon: 'moon' },
    { id: 'light', label: fa ? 'روشن' : 'Light', icon: 'sun' },
    { id: 'system', label: fa ? 'سیستم' : 'System', icon: 'system' },
  ];

  return (
    <Modal
      title={fa ? 'ظاهر و پوسته' : 'Appearance & themes'}
      description={fa ? 'محیط خود را مثل دیسکورد شخصی‌سازی کنید؛ تغییرات همین حالا اعمال می‌شوند.' : 'Personalize your workspace like Discord. Changes apply instantly and stay on this device.'}
      onClose={onClose}
      wide
      className="theme-studio-modal"
      footer={
        <>
          <button className="btn ghost" onClick={reset}>
            {fa ? 'بازنشانی ظاهر' : 'Reset appearance'}
          </button>
          <button className="btn primary" onClick={onClose}>
            {fa ? 'انجام شد' : 'Done'}
          </button>
        </>
      }
    >
      <div className="theme-studio-grid">
        <div className="theme-studio-main">
          <section className="theme-studio-section">
            <div className="theme-studio-heading">
              <div>
                <h3>{fa ? 'حالت پایه' : 'Base mode'}</h3>
                <p>{fa ? 'حالت روشن، تیره یا هماهنگ با سیستم.' : 'Choose light, dark, or follow the operating system.'}</p>
              </div>
              <Icon name="sun" size={19} />
            </div>
            <div className="theme-mode-grid">
              {modeOptions.map((option) => (
                <button
                  key={option.id}
                  className={`theme-mode-card${themePreference === option.id ? ' active' : ''}`}
                  onClick={() => setThemePreference(option.id)}
                  aria-pressed={themePreference === option.id}
                >
                  <Icon name={option.icon} size={20} />
                  <span>{option.label}</span>
                  {themePreference === option.id ? <Icon name="check" size={15} /> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="theme-studio-section">
            <div className="theme-studio-heading">
              <div>
                <h3>{fa ? 'پوسته‌های آماده' : 'Theme presets'}</h3>
                <p>{fa ? 'با یک کلیک شروع کنید و بعد رنگ‌ها را تغییر دهید.' : 'Start with a polished palette, then tune every color.'}</p>
              </div>
              <span className="theme-studio-badge">{activePreset === 'custom' ? (fa ? 'سفارشی' : 'Custom') : activePreset}</span>
            </div>
            <div className="theme-preset-grid">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={`theme-preset-card${activePreset === preset.id ? ' active' : ''}`}
                  onClick={() => choosePreset(preset)}
                >
                  <span className="theme-preset-swatch" style={{ background: `linear-gradient(135deg, ${preset.theme.background}, ${preset.theme.panel})` }}>
                    <i style={{ background: preset.theme.accent }} />
                    <i style={{ background: preset.theme.muted }} />
                    <i style={{ background: preset.theme.elevated }} />
                  </span>
                  <strong>{preset.name}</strong>
                  <small>{preset.description}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="theme-studio-section">
            <div className="theme-studio-heading">
              <div>
                <h3>{fa ? 'رنگ‌های سفارشی' : 'Custom colors'}</h3>
                <p>{fa ? 'هر سطح رابط را دقیقاً با سلیقه خود تنظیم کنید.' : 'Fine-tune every surface to match your style.'}</p>
              </div>
              <Icon name="settings" size={19} />
            </div>
            <div className="theme-color-grid">
              {COLOR_FIELDS.map((field) => (
                <label className="theme-color-field" key={field.key}>
                  <span>{fa ? colorLabel(field.label) : field.label}</span>
                  <span className="theme-color-input">
                    <input type="color" value={customTheme[field.key]} onChange={(event) => updateTheme(field.key, event.target.value)} />
                    <code>{customTheme[field.key].toUpperCase()}</code>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="theme-studio-section">
            <div className="theme-studio-heading">
              <div>
                <h3>{fa ? 'تراکم و حرکت' : 'Density & motion'}</h3>
                <p>{fa ? 'فضای پیام‌ها و شدت انیمیشن‌ها را انتخاب کنید.' : 'Tune message spacing and animation intensity.'}</p>
              </div>
              <Icon name="screen" size={19} />
            </div>
            <div className="theme-choice-row">
              <span>{fa ? 'تراکم پیام‌ها' : 'Message density'}</span>
              <div className="theme-choice-buttons">
                {(['comfortable', 'compact'] as const).map((value) => (
                  <button key={value} className={preferences.density === value ? 'active' : ''} onClick={() => updatePreferences({ density: value })}>
                    {value === 'compact' ? (fa ? 'فشرده' : 'Compact') : (fa ? 'راحت' : 'Comfortable')}
                  </button>
                ))}
              </div>
            </div>
            <div className="theme-choice-row">
              <span>{fa ? 'انیمیشن‌ها' : 'Animations'}</span>
              <div className="theme-choice-buttons">
                {(['full', 'reduced'] as const).map((value) => (
                  <button key={value} className={preferences.animations === value ? 'active' : ''} onClick={() => updatePreferences({ animations: value })}>
                    {value === 'reduced' ? (fa ? 'کاهش‌یافته' : 'Reduced') : (fa ? 'کامل' : 'Full')}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        <aside className="theme-studio-preview" style={{ '--preview-accent': customTheme.accent } as CSSProperties}>
          <div className="theme-preview-top"><span /><span /><span /></div>
          <div className="theme-preview-body">
            <div className="theme-preview-rail"><i /><i /><i /><i /></div>
            <div className="theme-preview-sidebar">
              <b>{fa ? 'پیام‌ها' : 'Messages'}</b>
              <span className="selected"># lounge</span>
              <span># ideas</span>
              <span># launch</span>
              <div className="theme-preview-user"><i /> you</div>
            </div>
            <div className="theme-preview-chat">
              <strong><span />{fa ? 'اتاق گفتگو' : 'Lounge'}</strong>
              <div className="theme-preview-message"><i /> <span><b>Alex</b><small>Welcome to the new theme.</small></span></div>
              <div className="theme-preview-message"><i /> <span><b>Sam</b><small>Everything feels much cleaner.</small></span></div>
              <div className="theme-preview-composer">{fa ? 'پیام بنویسید…' : 'Message #lounge…'} <Icon name="send" size={13} /></div>
            </div>
          </div>
          <p>{fa ? 'پیش‌نمایش زنده پوسته شما' : 'Live preview of your workspace'}</p>
        </aside>
      </div>
    </Modal>
  );
}

function colorLabel(label: string) {
  const labels: Record<string, string> = {
    Accent: 'رنگ اصلی',
    'App background': 'پس‌زمینه برنامه',
    'Server rail': 'نوار گروه‌ها',
    Sidebar: 'نوار کناری',
    'Chat panel': 'پنل گفتگو',
    'Cards & popovers': 'کارت‌ها و پنجره‌ها',
    Inputs: 'ورودی‌ها',
    'Main text': 'متن اصلی',
    'Muted text': 'متن کم‌رنگ',
  };
  return labels[label] ?? label;
}
