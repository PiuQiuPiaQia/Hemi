import {
  FLOATING_CAPTION_MAX_WIDTH,
  FLOATING_CAPTION_SIZE,
} from './lib/floating-caption-layout.mjs';

export const BRAND_NAME = 'Hemi';

export const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
export const isSmokeTest = process.env.HEMI_SMOKE_TEST === '1';

/**
 * 主进程共享可变状态：三个窗口的引用、退出标志、最近的 UI 状态与字幕布局。
 * windows/ 与 ipc/ 各模块都读写这里，避免模块间互相 import 造成的环。
 */
export const state = {
  conversationEnvironment: 'local',
  mainWindow: null,
  floatingWindow: null,
  floatingCaptionWindow: null,
  taskPopoverWindow: null,
  isQuitting: false,
  lastCaptionLayout: {
    anchorX: FLOATING_CAPTION_SIZE.width / 2,
    maxWidth: FLOATING_CAPTION_MAX_WIDTH,
    placement: 'above',
  },
  lastUiState: {
    sessionState: 'idle',
    isSpeaking: false,
    interimText: '',
    recentLines: [],
    errorText: '',
    turnPhase: 'idle',
    elapsedSeconds: 0,
    callActive: false,
    ttsActive: false,
  },
};
