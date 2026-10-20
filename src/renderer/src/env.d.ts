/// <reference types="vite/client" />

import type { HemiVoiceBridge } from '@shared/protocol';

declare global {
  interface Window {
    hemiVoice: HemiVoiceBridge;
  }
}

export {};
