import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initializeTheme } from './lib/theme';
import { I18nProvider } from './lib/i18n';
import { initializeNativeShell } from './lib/native';
import { AppErrorBoundary } from './components/AppErrorBoundary';

const userAgent = navigator.userAgent;
if (/AppleWebKit/i.test(userAgent) && !/Android/i.test(userAgent)
    && /Safari|CriOS|FxiOS|EdgiOS/i.test(userAgent)) {
  document.documentElement.dataset.browserEngine = 'webkit';
}

initializeTheme();
void initializeNativeShell();

// Mobile browsers disagree about whether the on-screen keyboard changes vh.
// A pixel custom property follows the actual visual viewport in either model.
const syncVisualViewport = () => {
  document.documentElement.style.setProperty(
    '--visual-viewport-height',
    `${window.visualViewport?.height ?? window.innerHeight}px`,
  );
};
syncVisualViewport();
window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </AppErrorBoundary>
  </StrictMode>,
);

requestAnimationFrame(() => {
  document.documentElement.dataset.appBooted = 'true';
  const url = new URL(window.location.href);
  if (url.searchParams.has('client-recovery')) {
    url.searchParams.delete('client-recovery');
    window.history.replaceState(null, '', url.toString());
  }
});
