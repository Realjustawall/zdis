import { useEffect, useState } from 'react';
import { storageGet, storageRemove, storageSet } from './storage';

export type ThemePreference = 'dark' | 'light' | 'system';

export interface CustomTheme {
  accent: string;
  accentHover: string;
  background: string;
  rail: string;
  sidebar: string;
  panel: string;
  elevated: string;
  input: string;
  text: string;
  muted: string;
}

export interface UiPreferences {
  density: 'comfortable' | 'compact';
  animations: 'full' | 'reduced';
}

const STORAGE_KEY = 'youtbelimo.theme';
const CUSTOM_STORAGE_KEY = 'zdis.custom-theme';
const UI_STORAGE_KEY = 'zdis.ui-preferences';
const listeners = new Set<(theme: ThemePreference) => void>();

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  accent: '#5865f2',
  accentHover: '#4752d4',
  background: '#090b12',
  rail: '#10131d',
  sidebar: '#151925',
  panel: '#191e2b',
  elevated: '#222838',
  input: '#282f42',
  text: '#f2f4ff',
  muted: '#a3abc0',
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  density: 'comfortable',
  animations: 'full',
};

function storedTheme(): ThemePreference {
  const value = storageGet(STORAGE_KEY);
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'system';
}

function resolvedTheme(theme: ThemePreference) {
  return theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
    : theme;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(storageGet(key) ?? 'null');
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

export function getCustomTheme(): CustomTheme {
  return readJson(CUSTOM_STORAGE_KEY, DEFAULT_CUSTOM_THEME);
}

export function getUiPreferences(): UiPreferences {
  return readJson(UI_STORAGE_KEY, DEFAULT_UI_PREFERENCES);
}

function rgba(hex: string, alpha: number) {
  const value = hex.replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  const number = Number.parseInt(normalized, 16);
  if (!Number.isFinite(number)) return `rgba(88, 101, 242, ${alpha})`;
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

export function applyCustomTheme(theme = getCustomTheme()) {
  const root = document.documentElement;
  const customValues: Record<string, string> = {
    '--zdis-accent': theme.accent,
    '--zdis-accent-hover': theme.accentHover,
    '--zdis-bg-deepest': theme.background,
    '--zdis-bg-rail': theme.rail,
    '--zdis-bg-sidebar': theme.sidebar,
    '--zdis-bg-main': theme.panel,
    '--zdis-bg-raised': theme.elevated,
    '--zdis-bg-input': theme.input,
    '--zdis-text': theme.text,
    '--zdis-text-muted': theme.muted,
  };
  for (const [property, value] of Object.entries(customValues)) root.style.setProperty(property, value);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-hover', theme.accentHover);
  root.style.setProperty('--accent-soft', rgba(theme.accent, 0.15));
  root.style.setProperty('--bg-deepest', theme.background);
  root.style.setProperty('--bg-rail', theme.rail);
  root.style.setProperty('--bg-sidebar', theme.sidebar);
  root.style.setProperty('--bg-main', theme.panel);
  root.style.setProperty('--bg-raised', theme.elevated);
  root.style.setProperty('--bg-input', theme.input);
  root.style.setProperty('--bg-secondary', theme.sidebar);
  root.style.setProperty('--bg-hover', rgba(theme.text, 0.055));
  root.style.setProperty('--bg-active', rgba(theme.accent, 0.17));
  root.style.setProperty('--text', theme.text);
  root.style.setProperty('--text-muted', theme.muted);
  root.style.setProperty('--text-faint', rgba(theme.muted, 0.62));
  root.dataset.customTheme = 'true';
}

export function saveCustomTheme(theme: CustomTheme) {
  storageSet(CUSTOM_STORAGE_KEY, JSON.stringify(theme));
  applyCustomTheme(theme);
  window.dispatchEvent(new CustomEvent('zdis:theme-change'));
}

export function resetCustomTheme() {
  storageRemove(CUSTOM_STORAGE_KEY);
  const root = document.documentElement;
  for (const property of ['--accent', '--accent-hover', '--accent-soft', '--bg-deepest', '--bg-rail', '--bg-sidebar', '--bg-main', '--bg-raised', '--bg-input', '--bg-secondary', '--bg-hover', '--bg-active', '--text', '--text-muted', '--text-faint', '--zdis-accent', '--zdis-accent-hover', '--zdis-bg-deepest', '--zdis-bg-rail', '--zdis-bg-sidebar', '--zdis-bg-main', '--zdis-bg-raised', '--zdis-bg-input', '--zdis-text', '--zdis-text-muted']) root.style.removeProperty(property);
  delete root.dataset.customTheme;
  applyTheme();
  window.dispatchEvent(new CustomEvent('zdis:theme-change'));
}

export function saveUiPreferences(preferences: UiPreferences) {
  storageSet(UI_STORAGE_KEY, JSON.stringify(preferences));
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  root.dataset.animations = preferences.animations;
  window.dispatchEvent(new CustomEvent('zdis:theme-change'));
}

export function applyUiPreferences(preferences = getUiPreferences()) {
  document.documentElement.dataset.density = preferences.density;
  document.documentElement.dataset.animations = preferences.animations;
}

export function applyTheme(theme = storedTheme()) {
  document.documentElement.dataset.theme = resolvedTheme(theme);
  document.documentElement.style.colorScheme = resolvedTheme(theme);
  if (storageGet(CUSTOM_STORAGE_KEY)) applyCustomTheme(getCustomTheme());
  applyUiPreferences();
}

export function setTheme(theme: ThemePreference) {
  storageSet(STORAGE_KEY, theme);
  applyTheme(theme);
  for (const listener of listeners) listener(theme);
}

export function initializeTheme() {
  applyTheme();
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (storedTheme() === 'system') applyTheme('system');
  };
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  else if (typeof media.addListener === 'function') media.addListener(onChange);
}

export function useTheme() {
  const [theme, update] = useState<ThemePreference>(storedTheme);
  useEffect(() => {
    listeners.add(update);
    const onStorage = () => {
      const next = storedTheme();
      update(next);
      applyTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(update);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return [theme, setTheme] as const;
}
