import { IPC } from '../../shared/ipc-channels.mjs';
import { state } from '../state.mjs';

/** 已读按消息身份与文字版本记录；相同文案的新消息仍然可以提示。 */
export function createCaptionReadTracker() {
  const read = new Set();
  const keyOf = (line) => JSON.stringify([line.id ?? null, line.author, line.text]);
  return {
    markRead(lines) {
      for (const line of lines) read.add(keyOf(line));
    },
    project(lines) {
      return lines.map((line) => ({ ...line, captionRead: read.has(keyOf(line)) }));
    },
  };
}

const tracker = createCaptionReadTracker();

function mainWindowForeground() {
  const win = state.mainWindow;
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused());
}

export function projectCaptionReadState(uiState) {
  if (mainWindowForeground()) tracker.markRead(uiState.recentLines);
  return { ...uiState, recentLines: tracker.project(uiState.recentLines) };
}

/** 焦点切回主窗口时立即消费，避免在下一次 renderer 上报前失焦又重播。 */
export function markCurrentCaptionRead() {
  if (!mainWindowForeground()) return;
  state.lastUiState = projectCaptionReadState(state.lastUiState);
  for (const win of [state.floatingWindow, state.floatingCaptionWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.ui.state, state.lastUiState);
  }
}
