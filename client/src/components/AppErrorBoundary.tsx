import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reloadFreshClient } from '../lib/recovery';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  recovering: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recovering: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, recovering: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('sahsha interface recovered from an error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const fa = document.documentElement.lang === 'fa';
    return (
      <main className="fatal-error-screen" role="alert">
        <div className="fatal-error-card">
          <span className="fatal-error-mark">S</span>
          <span className="eyebrow">{fa ? 'بازیابی امن' : 'SAFE RECOVERY'}</span>
          <h1>{fa ? 'نسخه رابط کاربری نیاز به تازه‌سازی دارد' : 'The interface needs a fresh start'}</h1>
          <p>
            {fa
              ? 'ممکن است یک نسخه قدیمی در حافظه مرورگر مانده باشد. با تازه‌سازی امن، کش برنامه پاک و آخرین نسخه بارگذاری می‌شود.'
              : 'An older bundle may still be cached. Safe refresh clears the application cache and loads the latest version.'}
          </p>
          <button
            className="btn primary"
            disabled={this.state.recovering}
            onClick={() => {
              this.setState({ recovering: true });
              void reloadFreshClient();
            }}
          >
            {this.state.recovering
              ? fa ? 'در حال بازیابی…' : 'Recovering…'
              : fa ? 'بارگذاری آخرین نسخه' : 'Load latest version'}
          </button>
          <details>
            <summary>{fa ? 'جزئیات فنی' : 'Technical details'}</summary>
            <code>{this.state.error.message}</code>
          </details>
        </div>
      </main>
    );
  }
}
