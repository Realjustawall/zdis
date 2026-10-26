import { Capacitor } from '@capacitor/core';

export async function initializeNativeShell() {
  if (!Capacitor.isNativePlatform()) return;
  const [{ App }, { StatusBar, Style }, { Keyboard, KeyboardResize }] = await Promise.all([
    import('@capacitor/app'), import('@capacitor/status-bar'), import('@capacitor/keyboard'),
  ]);
  await StatusBar.setStyle({ style: Style.Light }).catch(() => undefined);
  await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
  await Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => undefined);
  await Keyboard.setResizeMode({ mode: KeyboardResize.Native }).catch(() => undefined);
  App.addListener('backButton', ({ canGoBack }) => {
    const event = new Event('native:back', { cancelable: true });
    if (!window.dispatchEvent(event)) return;
    if (canGoBack) window.history.back();
    else void App.minimizeApp();
  });
  App.addListener('appStateChange', ({ isActive }) => {
    window.dispatchEvent(new CustomEvent('native:app-state', { detail: { isActive } }));
  });
}
