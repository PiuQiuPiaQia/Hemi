import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.hemi.mobile',
  appName: 'Hemi',
  webDir: 'dist',
  // Ship local assets. Live reload URLs must never enter a release config.
  ios: { backgroundColor: '#ffffff', preferredContentMode: 'mobile' },
  android: { backgroundColor: '#ffffff' },
};

export default config;
