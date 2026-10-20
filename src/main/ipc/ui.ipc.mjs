import { app, BrowserWindow, ipcMain } from 'electron';

import { readStoredConfig, saveStoredConfig } from '../lib/config-store.mjs';
import {
  getGlobalPushToTalkStartError,
  isGlobalPushToTalkListening,
  isGlobalPushToTalkRunning,
  openInputMonitoringPane,
  requestAccessibilityTrust,
  setGlobalPushToTalkEnabled,
  setPushToTalkConfig,
} from '../lib/global-push-to-talk.mjs';
import { state } from '../state.mjs';
import { projectCaptionReadState } from '../services/caption-read-state.mjs';
import { setMainWindowExpanded, showMainWindow } from '../windows/main-window.mjs';
import {
  hideFloatingWindow,
  showFloatingOrbIfNeeded,
} from '../windows/floating-surface.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

function sanitizeUiState(value) {
  const allowedStates = new Set(['idle', 'requesting', 'listening', 'error']);
  const allowedTurnPhases = new Set([
    'idle',
    'listening',
    'thinking',
    'speaking',
    'replying',
    'error',
  ]);
  return {
    sessionState: allowedStates.has(value?.sessionState)
      ? value.sessionState
      : 'idle',
    isSpeaking: Boolean(value?.isSpeaking),
    interimText:
      typeof value?.interimText === 'string'
        ? value.interimText.slice(0, 500)
        : '',
    // 定稿行带作者（user / hemi），字幕条据此给 Hemi 行上色。兼容旧的纯字符串。
    recentLines: Array.isArray(value?.recentLines)
      ? value.recentLines
          .map((line) => {
            const text =
              typeof line === 'string'
                ? line
                : typeof line?.text === 'string'
                  ? line.text
                  : '';
            const author =
              typeof line === 'object' && line?.author === 'hemi'
                ? 'hemi'
                : 'user';
            const id = typeof line?.id === 'string' ? line.id.slice(0, 500) : undefined;
            return { id, text: text.trim().slice(0, 300), author };
          })
          .filter((line) => line.text)
          .slice(-2)
      : [],
    // 模型错误单独走 errorText：不混进 recentLines（不伪装成 Hemi 的话），
    // 渲染层也绝不把它编进模型上下文。
    errorText:
      typeof value?.errorText === 'string' ? value.errorText.slice(0, 500) : '',
    turnPhase: allowedTurnPhases.has(value?.turnPhase) ? value.turnPhase : 'idle',
    elapsedSeconds: Number.isFinite(value?.elapsedSeconds)
      ? Math.max(0, Math.round(value.elapsedSeconds))
      : 0,
    callActive: Boolean(value?.callActive),
    // 024：Call Dock 用户静音（硬覆盖上行；悬浮窗据此调整聆听类文案）。
    callMuted: Boolean(value?.callMuted),
    ttsActive: Boolean(value?.ttsActive),
    // 048：思考起点（毫秒时间戳）——字幕窗「思考中 · Ns」计时的依据。
    thinkingSince: Number.isFinite(value?.thinkingSince)
      ? Math.max(0, Math.round(value.thinkingSince))
      : null,
  };
}

/**
 * 收敛并广播 UI 状态：主窗口的 `ui:publish-state` 上报和冒烟测试都走这里，
 * 免得两处各写一遍「存起来 + 推给两个悬浮窗」。
 */
let uiStateObserver = null;

/** task.ipc 注册：观察净化后的 UiState（如 callActive 驱动会话白名单过期）。 */
export function setUiStateObserver(fn) {
  uiStateObserver = fn;
}

export function publishUiState(value) {
  state.lastUiState = projectCaptionReadState(sanitizeUiState(value));
  for (const window of [state.floatingWindow, state.floatingCaptionWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.ui.state, state.lastUiState);
    }
  }
  uiStateObserver?.(state.lastUiState);
  return state.lastUiState;
}

export function registerUiIpc() {
  ipcMain.handle(IPC.ui.getPreferences, async () => {
    const stored = await readStoredConfig();
    return {
      floatingOrbEnabled: stored.floatingOrbEnabled,
      primarySpeakerEnabled: stored.primarySpeakerEnabled === true,
      // 022：ready=钩子真的在跑；listening=事件流确认可达（未授权时 tap 静默）。
      globalPushToTalkEnabled: stored.globalPushToTalkEnabled === true,
      // 043：长按键规范标识（设置页显示用；Windows 上为空＝未定案）。
      globalPushToTalkKey: stored.globalPushToTalkKey ?? '',
      globalPushToTalkReady: isGlobalPushToTalkRunning(),
      globalPushToTalkListening: isGlobalPushToTalkListening(),
      // 设置页优先展示它：加载失败≠缺授权，别再让用户去系统设置白忙。
      globalPushToTalkStartError: getGlobalPushToTalkStartError(),
    };
  });

  ipcMain.handle(IPC.ui.setFloatingOrbEnabled, async (_event, enabled) => {
    const floatingOrbEnabled = Boolean(enabled);
    await saveStoredConfig({ floatingOrbEnabled });
    if (!floatingOrbEnabled) hideFloatingWindow();
    else void showFloatingOrbIfNeeded();
    return { floatingOrbEnabled };
  });

  // 013：仅响应首位说话人（下一次通话生效——ASR payload 参数在会话建立时决定）。
  ipcMain.handle(IPC.ui.setPrimarySpeakerEnabled, async (_event, enabled) => {
    const primarySpeakerEnabled = Boolean(enabled);
    await saveStoredConfig({ primarySpeakerEnabled });
    return { primarySpeakerEnabled };
  });

  // 022：全局长按 Option 对话——写配置后热启停，回执带钩子运行态。
  ipcMain.handle(IPC.ui.setGlobalPushToTalkEnabled, async (_event, enabled) => {
    return setGlobalPushToTalkEnabled(Boolean(enabled));
  });

  // 043：长按键配置统一入口（enabled/key 可只给其一；未验证的键回 INVALID_INPUT）。
  ipcMain.handle(IPC.ui.setPushToTalkConfig, async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const next = {};
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    if (typeof input.key === 'string') next.key = input.key;
    return setPushToTalkConfig(next);
  });

  // 022：弹系统辅助功能授权引导框（渲染层按钮的用户手势触发）。
  ipcMain.handle(IPC.ui.requestAccessibilityTrust, () => {
    return requestAccessibilityTrust();
  });

  // 022：直达「输入监控」授权面板。
  ipcMain.handle(IPC.ui.openInputMonitoringPane, () => {
    return openInputMonitoringPane();
  });

  ipcMain.on(IPC.ui.setMainExpanded, (_event, expanded) => {
    setMainWindowExpanded(Boolean(expanded));
  });

  ipcMain.on(IPC.ui.hideMain, () => {
    state.mainWindow?.hide();
    void showFloatingOrbIfNeeded();
  });

  ipcMain.on(IPC.ui.publishState, (_event, value) => {
    publishUiState(value);
  });

  ipcMain.handle(IPC.ui.getState, () => state.lastUiState);
  ipcMain.handle(IPC.ui.getDevWindowActivity, (event) => {
    if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed()
      ? { visible: win.isVisible() && !win.isMinimized() }
      : null;
  });
  ipcMain.handle(IPC.floating.getCaptionLayout, () => state.lastCaptionLayout);
}
