import { useEffect, useState } from 'react';

import type {
  FloatingCaptionLayout,
  TaskStateSnapshot,
  UiState,
} from '@/shared/types';

/** 主进程还没推送之前，两个悬浮窗用的初始状态。 */
export const initialUiState: UiState = {
  sessionState: 'idle',
  isSpeaking: false,
  interimText: '',
  recentLines: [],
  errorText: '',
  turnPhase: 'idle',
  elapsedSeconds: 0,
  callActive: false,
  callMuted: false,
  ttsActive: false,
};

/** 004：无任务时的快照兜底（主进程 task:state 尚未到达）。 */
export const initialTaskState: TaskStateSnapshot = {
  seq: 0,
  key: null,
  taskId: null,
  phase: 'idle',
  outcome: null,
  taskText: '',
  progressText: '',
  readOnly: true,
  verifying: false,
  verified: false,
  permission: null,
  queueCount: 0,
        steeredCount: 0,
  log: [],
  resultText: null,
  outcomeReason: null,
  verification: null,
  artifacts: [],
  lastAction: null,
  resumedFrom: null,
};

/**
 * 字幕条在拿到主进程算好的版面参数之前的兜底值。
 * 与 electron/floating-caption-layout.mjs 的窗口尺寸/默认居中一致。
 */
export const initialFloatingCaptionLayout: FloatingCaptionLayout = {
  anchorX: 220,
  maxWidth: 400,
  placement: 'above',
};

/**
 * 订阅一类主进程推送：先取一次当前值，再监听后续变化。
 *
 * `read` / `subscribe` 必须是模块级函数（引用稳定），否则每次渲染都会重新订阅。
 */
function useBridgeValue<T>(
  read: () => Promise<T>,
  subscribe: (onChange: (value: T) => void) => () => void,
  initial: T,
): T {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    let cancelled = false;
    if (!window.hemiVoice) return undefined;

    void read().then((next) => {
      if (!cancelled) setValue(next);
    });
    const removeListener = subscribe(setValue);

    return () => {
      cancelled = true;
      removeListener();
    };
  }, [read, subscribe]);

  return value;
}

function readUiState(): Promise<UiState> {
  return window.hemiVoice?.getUiState() ?? Promise.resolve(initialUiState);
}

function subscribeUiState(onChange: (state: UiState) => void): () => void {
  return window.hemiVoice?.onUiState(onChange) ?? (() => {});
}

function readFloatingCaptionLayout(): Promise<FloatingCaptionLayout> {
  return (
    window.hemiVoice?.getFloatingCaptionLayout() ??
    Promise.resolve(initialFloatingCaptionLayout)
  );
}

function subscribeFloatingCaptionLayout(
  onChange: (layout: FloatingCaptionLayout) => void,
): () => void {
  return (
    window.hemiVoice?.onFloatingCaptionLayout(onChange) ?? (() => {})
  );
}

function readTaskState(): Promise<TaskStateSnapshot> {
  return (
    window.hemiVoice?.getTaskState?.() ?? Promise.resolve(initialTaskState)
  );
}

function subscribeTaskState(
  onChange: (state: TaskStateSnapshot) => void,
): () => void {
  return window.hemiVoice?.onTaskState?.(onChange) ?? (() => {});
}

/** 主窗口推来的语音状态：悬浮球和字幕条共用同一份。 */
export function useUiState(): UiState {
  return useBridgeValue(readUiState, subscribeUiState, initialUiState);
}

/** 主进程算好的字幕条版面：文字锚点、最大宽度、在球上方还是下方。 */
export function useFloatingCaptionLayout(): FloatingCaptionLayout {
  return useBridgeValue(
    readFloatingCaptionLayout,
    subscribeFloatingCaptionLayout,
    initialFloatingCaptionLayout,
  );
}

/** 004 任务快照：悬浮字幕的任务行与悬浮球的角标/菜单共用。 */
export function useTaskState(): TaskStateSnapshot {
  return useBridgeValue(readTaskState, subscribeTaskState, initialTaskState);
}
