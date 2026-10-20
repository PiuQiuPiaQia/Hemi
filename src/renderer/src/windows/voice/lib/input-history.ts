/**
 * 030 R-04（第二批）：输入历史的纯逻辑（组件外置，供单测覆盖）。
 *
 * 历史来源＝当前会话已受理的用户 turns（不含助手回复/任务卡），最新在前；
 * 相邻重复去重（同文案连发保留一条展示，历史事实仍在会话档案里）。
 * ↑/↓ 浏览只在不冲突时接管（IME 候选、多行光标边界判定在组件侧），
 * 浏览期间缓存原草稿：编辑即离开浏览、Esc/走完恢复原稿，不误覆盖。
 */

import type { TranscriptItem } from '@/shared/types';

/** 从会话 turns 派生输入历史（最新在前，相邻去重）。 */
export function buildInputHistory(transcripts: TranscriptItem[]): string[] {
  const texts: string[] = [];
  for (let i = transcripts.length - 1; i >= 0; i -= 1) {
    const item = transcripts[i];
    if (item.author !== 'user' || item.kind === 'task') continue;
    const text = item.text.trim();
    if (!text) continue;
    if (texts.length && texts[texts.length - 1] === text) continue; // 相邻重复只展示一条
    texts.push(text);
  }
  return texts;
}

export type HistoryBrowseState = {
  /** 浏览中的历史下标（0＝最新一条）；null＝未在浏览。 */
  index: number | null;
  /** 进入浏览前缓存的原草稿（Esc/走完恢复）。 */
  cachedDraft: string | null;
};

export const HISTORY_BROWSE_IDLE: HistoryBrowseState = { index: null, cachedDraft: null };

/**
 * ↑：进入浏览或向更旧移动。空草稿/光标在首行首列等前置判定由组件做，
 * 这里只管状态机：进入时缓存原稿；已到最旧不再前进。
 */
export function browseOlder(
  state: HistoryBrowseState,
  history: string[],
  currentDraft: string,
): HistoryBrowseState {
  if (!history.length) return state;
  if (state.index == null) {
    return { index: 0, cachedDraft: currentDraft };
  }
  if (state.index >= history.length - 1) return state;
  return { ...state, index: state.index + 1 };
}

/** ↓：向更新移动；越过最新一条＝退出浏览并恢复缓存原稿。 */
export function browseNewer(state: HistoryBrowseState, history: string[]): HistoryBrowseState & { text: string | null } {
  if (state.index == null) return { ...state, text: null };
  if (state.index > 0) {
    return { index: state.index - 1, cachedDraft: state.cachedDraft, text: history[state.index - 1] ?? null };
  }
  return { index: null, cachedDraft: null, text: state.cachedDraft };
}

/** 当前浏览项文本（未在浏览＝null）。 */
export function browseText(state: HistoryBrowseState, history: string[]): string | null {
  return state.index == null ? null : history[state.index] ?? null;
}

/** 离开浏览（编辑/Esc/发送后）：清状态；调用方自行决定是否恢复 cachedDraft。 */
export function exitBrowse(state: HistoryBrowseState): HistoryBrowseState {
  return HISTORY_BROWSE_IDLE;
}

/**
 * ↑/↓ 是否允许接管：IME 合成中不接管；空草稿直接允许；非空只允许光标在
 * 首行行首（↑）或末行行尾（↓）——多行编辑里方向键先移动光标。
 */
export function shouldTakeOverArrow(
  key: 'ArrowUp' | 'ArrowDown',
  draft: string,
  caret: number,
  isComposing: boolean,
): boolean {
  if (isComposing) return false;
  if (!draft) return true;
  const before = draft.slice(0, caret);
  const after = draft.slice(caret);
  if (key === 'ArrowUp') return !before.includes('\n'); // 光标在首行（行内列不限→仅当在行首? 取首行任意列为可接管）
  return !after.includes('\n'); // 光标在末行
}
