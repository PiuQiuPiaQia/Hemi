import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'ai.hemi.mobile',
  appName: 'Hemi',
  webDir: 'dist',
  loggingBehavior: 'none',
  zoomEnabled: false,
  // Ship local assets. Live reload URLs must never enter a release config.
  ios: { backgroundColor: '#ffffff', preferredContentMode: 'mobile', scrollEnabled: false, contentInset: 'never' },
  android: { backgroundColor: '#ffffff' },
  // One bottom inset moves the entire app's flex layout; do not also resize the native WebView.
  plugins: { Keyboard: { resize: KeyboardResize.None, style: KeyboardStyle.Light, autoBackdropColor: 'auto' } },
};

export default config;
