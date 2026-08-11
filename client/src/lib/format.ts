const activeLocale = () =>
  typeof document !== 'undefined' && document.documentElement.lang === 'fa' ? 'fa-IR' : 'en';
const dateFormat = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(activeLocale(), options);
const numberFormat = (options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(activeLocale(), options);

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatTimestamp(value: number): string {
  const date = new Date(value);
  const now = new Date();
  const time = dateFormat({ hour: '2-digit', minute: '2-digit' });
  if (isSameDay(date, now)) return time.format(date);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return activeLocale() === 'fa-IR' ? `دیروز، ${time.format(date)}` : `Yesterday ${time.format(date)}`;
  }

  return now.getFullYear() === date.getFullYear()
    ? dateFormat({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    : formatFullTimestamp(value);
}

export function formatFullTimestamp(value: number): string {
  return dateFormat({
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatDayHeading(value: number): string {
  const date = new Date(value);
  const now = new Date();
  const fa = activeLocale() === 'fa-IR';
  if (isSameDay(date, now)) return fa ? 'امروز' : 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return fa ? 'دیروز' : 'Yesterday';
  return dateFormat({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

export function isNewDay(previous: number | undefined, current: number): boolean {
  if (previous === undefined) return true;
  return !isSameDay(new Date(previous), new Date(current));
}

export function formatRelative(value: number | null): string {
  const fa = activeLocale() === 'fa-IR';
  if (!value) return fa ? 'هرگز' : 'never';
  const delta = Date.now() - value;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return fa ? 'همین حالا' : 'just now';
  if (minutes < 60) return fa ? `${numberFormat().format(minutes)} دقیقه پیش` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fa ? `${numberFormat().format(hours)} ساعت پیش` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return fa ? `${numberFormat().format(days)} روز پیش` : `${days}d ago`;
  return formatFullTimestamp(value);
}

export function formatBytes(bytes: number): string {
  const value = (amount: number, digits: number) =>
    numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  if (bytes < 1024) return `${numberFormat().format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${value(bytes / 1024, 1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${value(bytes / (1024 * 1024), 1)} MB`;
  return `${value(bytes / (1024 * 1024 * 1024), 2)} GB`;
}

export function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

const FALLBACK_COLORS = ['#f04747', '#faa61a', '#43b581', '#5865f2', '#eb459e', '#00b0f4', '#9b59b6', '#e67e22'];

export function colorFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}
