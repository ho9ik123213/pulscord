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
  }
};

export default config;
