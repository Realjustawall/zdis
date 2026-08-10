const CACHE_PREFIX = 'zdis-pwa-';

export async function reloadFreshClient() {
  try {
    if ('caches' in window) {
      const names = await window.caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => window.caches.delete(name)),
      );
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } finally {
    const url = new URL(window.location.href);
    url.searchParams.set('fresh', String(Date.now()));
    window.location.replace(url.toString());
  }
}
