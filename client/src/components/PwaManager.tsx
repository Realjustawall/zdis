import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isAndroid = () => /Android/i.test(navigator.userAgent);
const INSTALL_PROMPT_SHOWN_KEY = 'zdis.android-install-prompt-shown';
const SERVICE_WORKER_URL = '/sw.js';
const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

export function PwaManager() {
  const { t } = useI18n();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [updateReady, setUpdateReady] = useState<ServiceWorker | null>(null);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const reloadForUpdateRef = useRef(false);

  async function applyUpdate() {
    if (!updateReady || applyingUpdate) return;
    reloadForUpdateRef.current = true;
    setApplyingUpdate(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      let worker = registration?.waiting ?? null;

      // Re-check the registration instead of trusting a worker reference kept
      // in React state; it may have become redundant since the banner appeared.
      if (!worker && registration) {
        await registration.update();
        worker = registration.waiting;
      }
      if (!worker && updateReady.state === 'installed') worker = updateReady;

      if (!worker || worker.state === 'redundant') {
        window.location.reload();
        return;
      }

      worker.postMessage({ type: 'SKIP_WAITING' });
      // controllerchange normally reloads the page. Keep a fallback for browsers
      // that activate the worker but miss or delay that event.
      window.setTimeout(() => window.location.reload(), 4_000);
    } catch {
      // A network update check can fail even when the latest shell is already
      // available. Reloading still lets the navigation use the network-first path.
      window.location.reload();
    }
  }

  useEffect(() => {
    let reloadingForUpdate = false;
    const android = isAndroid();
    // Keep the web app installable only on Android. Removing the manifest also
    // prevents desktop browsers from advertising an install/download action.
    if (!android) document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.remove();

    const online = () => setOffline(false);
    const offlineHandler = () => setOffline(true);
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      if (android && !localStorage.getItem(INSTALL_PROMPT_SHOWN_KEY)) {
        localStorage.setItem(INSTALL_PROMPT_SHOWN_KEY, '1');
        setInstallPrompt(event as InstallPromptEvent);
      }
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineHandler);
    window.addEventListener('beforeinstallprompt', beforeInstall);

    if ('serviceWorker' in navigator) {
      const controllerChanged = () => {
        // A newly installed worker claims an already-open first-visit page.
        // Reloading for that routine activation can abort login or message POSTs.
        // Only reload after the user explicitly accepts an available update.
        if (!reloadForUpdateRef.current || reloadingForUpdate) return;
        reloadingForUpdate = true;
        window.location.reload();
      };
      navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
      let updateTimer: number | undefined;
      let registrationRef: ServiceWorkerRegistration | undefined;
      const checkForUpdate = () => {
        if (navigator.onLine && registrationRef) void registrationRef.update().catch(() => undefined);
      };
      const checkWhenVisible = () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      };
      document.addEventListener('visibilitychange', checkWhenVisible);
      navigator.serviceWorker.register(SERVICE_WORKER_URL, { updateViaCache: 'none' }).then((registration) => {
        registrationRef = registration;
        checkForUpdate();
        updateTimer = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
        if (registration.waiting) setUpdateReady(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(worker);
          });
        });
      }).catch(() => undefined);
      return () => {
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offlineHandler);
        window.removeEventListener('beforeinstallprompt', beforeInstall);
        navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
        document.removeEventListener('visibilitychange', checkWhenVisible);
        if (updateTimer) window.clearInterval(updateTimer);
      };
    }
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offlineHandler);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
    };
  }, []);

  if (!offline && !installPrompt && !updateReady) return null;
  return (
    <div className="pwa-status" role="status">
      <span>{offline ? t('pwa.offline') : updateReady ? t('pwa.update') : t('pwa.install')}</span>
      {isAndroid() && installPrompt ? (
        <button className="btn primary compact" onClick={async () => {
          await installPrompt.prompt();
          await installPrompt.userChoice;
          setInstallPrompt(null);
        }}>{t('pwa.install')}</button>
      ) : null}
      {updateReady ? (
        <button className="btn primary compact" disabled={applyingUpdate} onClick={() => void applyUpdate()}>
          {applyingUpdate ? t('pwa.updating') : t('pwa.reload')}
        </button>
      ) : null}
    </div>
  );
}
