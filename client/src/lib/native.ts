import { Capacitor } from '@capacitor/core';

export async function initializeNativeShell() {
  if (!Capacitor.isNativePlatform()) return;
  const [{ App }, { StatusBar, Style }, { Keyboard }] = await Promise.all([
    import('@capacitor/app'), import('@capacitor/status-bar'), import('@capacitor/keyboard'),
  ]);
  await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
  await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
  await Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => undefined);
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back();
    else void App.minimizeApp();
  });
  App.addListener('appStateChange', ({ isActive }) => {
    window.dispatchEvent(new CustomEvent('native:app-state', { detail: { isActive } }));
  });
}
