import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pulscord.app',
  appName: 'Pulscord',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    cleartext: true
  },
  android: {
    allowMixedContent: true
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      showSpinner: false,
      backgroundColor: '#030711'
    }
  }
};

export default config;
