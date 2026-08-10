import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initializeTheme } from './lib/theme';
import { I18nProvider } from './lib/i18n';
import { initializeNativeShell } from './lib/native';
import { AppErrorBoundary } from './components/AppErrorBoundary';

initializeTheme();
void initializeNativeShell();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
