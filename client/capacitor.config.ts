import type { CapacitorConfig } from '@capacitor/cli';

const hostedUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: 'com.youtbelimo.chat',
  appName: 'sahsha',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: hostedUrl ? {
    url: hostedUrl,
    cleartext: hostedUrl.startsWith('http://'),
  } : {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    backgroundColor: '#0d0f14',
  },
  ios: {
    backgroundColor: '#0d0f14',
    contentInset: 'automatic',
    scrollEnabled: true,
  },
  plugins: {
    StatusBar: { style: 'DARK', backgroundColor: '#0d0f14', overlaysWebView: true },
    Keyboard: { resize: 'native', style: 'dark', resizeOnFullScreen: true },
  },
};

export default config;
