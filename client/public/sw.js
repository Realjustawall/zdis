// The production build replaces these two declarations with a content-hashed
// version and every file emitted by Vite. The defaults keep the dev server's
// service worker valid too.
const VERSION = 'zdis-pwa-dev'; // __CACHE_VERSION__
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const EXTERNAL_IMAGE_CACHE = 'zdis-pwa-external-images-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/offline.html',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
  '/fonts/vazirmatn-arabic.woff2',
  '/fonts/vazirmatn-latin.woff2',
]; // __PRECACHE_ASSETS__

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        cache.addAll(
          PRECACHE_ASSETS.map(
            (asset) => new Request(asset, { cache: 'reload', credentials: 'same-origin' }),
          ),
        ),
      ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith('zdis-pwa-') &&
                key !== SHELL_CACHE &&
                key !== ASSET_CACHE &&
                key !== EXTERNAL_IMAGE_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Branding and other explicitly configured remote images are cached after
  // their first successful load. Application code, CSS and fonts are never
  // allowed to depend on another origin and are fully precached at build time.
  if (url.origin !== self.location.origin && request.destination === 'image') {
    event.respondWith(
      caches
        .open(EXTERNAL_IMAGE_CACHE)
        .then(async (cache) => {
          const cached = await cache.match(request);
          if (cached) return cached;
          const response = await fetch(request);
          if (response.ok || response.type === 'opaque') {
            await cache.put(request, response.clone()).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match('/icons/icon.svg')),
    );
    return;
  }

  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/rtc/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put('/index.html', response.clone()).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html', { ignoreSearch: true });
          return cached || caches.match('/offline.html');
        }),
    );
    return;
  }

  if (
    PRECACHE_ASSETS.includes(url.pathname) ||
    ['script', 'style', 'font', 'image', 'manifest'].includes(request.destination)
  ) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then(async (cached) => {
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) {
            const copy = response.clone();
            await caches
              .open(ASSET_CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => undefined);
          }
          return response;
        } catch {
          if (request.destination === 'image') {
            return caches.match('/icons/icon.svg');
          }
          throw new Error(`Offline resource was not precached: ${url.pathname}`);
        }
      }),
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'اعلان جدید', body: event.data?.text() || '' };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'اعلان جدید', {
      body: payload.body || '',
      data: payload.data || {},
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      dir: 'auto',
      lang: 'fa',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const existing = windows[0];
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'notification:open', data: event.notification.data });
        return;
      }
      return clients.openWindow('/');
    }),
  );
});
