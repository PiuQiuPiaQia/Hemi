import { useEffect, useRef, useState } from 'react';

import type { UiState } from '@/shared/types';
import {
  CAPTION_HOLD_MS,
  buildCaptionLines,
  captionContentKey,
  isCaptionContentFresh,
  resolveCaptionFallback,
} from '@/windows/caption/floating-caption-lines';
import {
  initialUiState,
  useFloatingCaptionLayout,
  useUiState,
} from '@/windows/voice/lib/voice-bridge';

/** 空闲操作提示亮多久：悬浮球首次放置后亮这几秒，随后整颗药丸淡出。 */
export const IDLE_HINT_HOLD_MS = 5000;

/**
 * 空闲提示只出现一次（用户反馈 2026-09-19：悬浮球常驻时不再挂一句
 * 永久的「点击开始通话」）。字幕窗口在悬浮球首次放置时才加载，
 * 所以「挂载后计时」恰好等于「首次放置后亮几秒」；计时结束就永久
 * 淡出，会话状态类提示（连接中／聆听中／错误）不受它影响。
 */
export function useIdleHintVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), IDLE_HINT_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return visible;
}

/**
 * 内容「点亮」判定——字幕卡只显示当前轮次的内容（2026-09-24 定稿模型）。
 *
 * 悬浮面三个显示器的分工：
 * - 字幕卡＝当前轮次的内容（临时结果／定稿／思考／错误）；
 * - 状态药丸＝会话状态（连接中／聆听中／错误／首次操作提示）；
 * - 球体＝交互与活跃（悬停／按住／聆听时全亮，静止半透明）。
 *
 * 点亮规则：挂载基线（第一拍真实状态）内容新鲜（在途轮次，见
 * isCaptionContentFresh）→ 点亮；之后内容指纹一变（新一轮开始）→ 点亮。
 * 一旦点亮就闩住——轮次落定后的 4.5 秒阅读停留由 useAutoHide 计时收尾，
 * 也保证「重复出现与挂载基线相同文本」的轮次不会中途熄灭。
 *
 * 两条旧答案重播路径都断在这里：切到浮球模式时字幕窗首帧读到的是上一轮
 * recentLines（基线不新鲜）；按 Option 转聆听但还没开口（聆听不是内容
 * 新鲜，指纹也没变）——都收敛成状态药丸，等人开口（interim 落地）才亮卡。
 */
export function useContentLit(
  uiState: UiState,
  contentKey: string,
): boolean {
  const baselineRef = useRef<{ key: string; lit: boolean } | null>(null);

  if (uiState !== initialUiState && !baselineRef.current) {
    baselineRef.current = {
      key: contentKey,
      lit: isCaptionContentFresh(uiState),
    };
  }
  const baseline = baselineRef.current;
  if (!baseline) return false;

  if (!baseline.lit) {
    if (isCaptionContentFresh(uiState) || contentKey !== baseline.key) {
      baseline.lit = true;
    }
  }
  return baseline.lit;
}

/**
 * 字幕条的状态与句子模型，`floating-caption.tsx` 负责渲染与滚动。
 *
 * 动画只有两个：新行入场（CSS animation）、整卡淡出（文字与背景同时）。
 * 旧版的「退场副本 + 逐句错峰 + 卡片延迟淡出」会造成背景高度来回闪烁
 * 和文字走光后的空卡留白，已整体移除。
 */
export function useFloatingCaption() {
  const uiState = useUiState();
  const layout = useFloatingCaptionLayout();

  const lines = buildCaptionLines(uiState);
  const fallbackCopy = resolveCaptionFallback(uiState);
  const contentKey = captionContentKey(lines, fallbackCopy);
  const contentLit = useContentLit(uiState, contentKey);

  return {
    uiState,
    layout,
    lines: contentLit ? lines : [],
    fallbackCopy,
    contentKey,
    // 未点亮的内容当「没有内容」处理：收敛成状态药丸而不是亮一张旧答案卡。
    hasLines: lines.length > 0 && contentLit,
  };
}

/**
 * 字幕停在原地几秒后整卡淡出；内容一变就重新计时并立刻亮回来。
 * TTS 播报期间不启动倒计时，播放结束后才开始阅读停留时间。
 */
export function useAutoHide(
  contentKey: string,
  holdWhileActive = false,
): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    if (holdWhileActive) return;

    const timer = window.setTimeout(
      () => setVisible(false),
      CAPTION_HOLD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [contentKey, holdWhileActive]);

  return visible;
}

/**
 * 自动上滚已移除（2026-10-15 用户反馈「读过的消息就别再悬浮球上面展示了」）：
 * 此前长回应会在卡内以 26px/s 从头滚到尾、淡出推迟到滚完——整篇已读内容
 * 在球上方回放数十秒到数分钟。现在超长内容只显示开头（卡片 max-height
 * 钳制），全文去主窗口看，字幕卡回归「当前轮次的临时显示器」。
 */
