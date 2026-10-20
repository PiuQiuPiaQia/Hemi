import type { RecentLine, UiState } from '@/shared/types';

/**
 * 悬浮字幕条的「句子模型」：把 UiState 变成一行一句的字幕。全是纯函数，
 * 方便单独推理和在冒烟测试里验证。
 *
 * 显示策略与主窗口的活区一致（2026-09-18 用户确认）：**单轮焦点**——
 * - 用户说话中：只显示正在识别的这句（字幕跟读）；
 * - 思考／回应中：显示用户的句子 + 「正在想」指示行，状态可见；
 * - 回应一到：只显示 Hemi 的回应，用户句让位；
 * - 没有内容时不留占位行。超长内容由 CSS 自动换行展示全文，不用省略号。
 *
 * 动画约定（2026-09-18 简化）：内容切换即替换（新行有入场动画），
 * **不做退场副本、不做逐句错峰**——那是「背景高度来回闪烁」和
 * 「空卡片留白」的根源；淡出时文字与卡片背景同生同灭。
 */

/** 字幕停在原地多久后整卡淡出（globals.css 同一套时长）。 */
export const CAPTION_HOLD_MS = 4500;

export type CaptionLine = {
  /** React key：定稿句按内容，临时／思考行固定。 */
  key: string;
  text: string;
  kind: 'final' | 'interim' | 'thinking' | 'error';
  /** 行的作者：Hemi／思考行上色（淡玉），用户行保持原样。 */
  author?: 'user' | 'hemi';
};

type RawLine = string | Partial<RecentLine> | undefined;

function normalizeLine(line: RawLine) {
  const text = typeof line === 'string' ? line : (line?.text ?? '');
  const author: RecentLine['author'] =
    typeof line === 'object' && line?.author === 'hemi' ? 'hemi' : 'user';
  const trimmed = text.trim();
  return trimmed ? {
    text: trimmed,
    author,
    id: typeof line === 'object' ? line.id : undefined,
    captionRead: typeof line === 'object' && line.captionRead === true,
  } : null;
}

/**
 * 没有字幕时显示的提示文案（按会话状态区分）。
 * 空闲文案是给首次放置悬浮球看的操作提示（用户反馈 2026-09-19）：
 * 字幕层只在前几秒亮出它，随后永久淡出，不再挂一句常驻提示。
 */
export function resolveCaptionFallback(uiState: UiState): string {
  if (uiState.sessionState === 'requesting') {
    return uiState.callActive ? '正在接通通话…' : '正在连接…';
  }
  if (uiState.sessionState === 'listening') {
    return uiState.callActive ? '通话中，直接说话' : '我在听，松开回应';
  }
  if (uiState.sessionState === 'error') return '语音识别暂时不可用';
  return '长按或点击，开始对话';
}

function finalLine(line: RecentLine): CaptionLine {
  return {
    key: `final-${line.id ?? line.text}`,
    text: line.text,
    kind: 'final',
    author: line.author,
  };
}

/**
 * 单轮焦点：最多两行（焦点句 + 状态行）。
 * - 说话中：只显示临时结果这一行——谁在说话就显示谁的话；
 * - 思考／回应中：用户句 + 「正在想」指示，回应没落地前状态不消失；
 * - 回应落地（末句是 Hemi）：只显示回应；
 * - 错误：焦点句 + 独立错误行（不伪装成 Hemi 的话）。
 * 没有任何内容时返回空数组，由调用方改显示提示文案。
 */
export function buildCaptionLines(uiState: UiState): CaptionLine[] {
  const lastFinal = uiState.recentLines
    .map(normalizeLine)
    .filter((line): line is NonNullable<typeof line> =>
      Boolean(line),
    )
    .at(-1);

  // 聆听相位且没有临时结果：末句若是 Hemi 的，必然属于上一轮——本轮还没
  // 说过话，定稿落地与临时清空之间一旦出现空窗（2026-09-24 实录：Option
  // 发送完成后闪一下旧答案再回来），回退显示它就是重播旧信息，收敛为空
  // （状态药丸接手）。末句是用户的则照常显示：那是本会话刚定稿的话，
  // 连续通话里「我刚说了什么」是有价值的当前反馈；阅读停留发生在
  // speaking/replying/idle 相位，不在本规则判定面内。
  const interim = uiState.interimText.trim();
  if (
    !interim &&
    uiState.turnPhase === 'listening' &&
    lastFinal?.author === 'hemi'
  ) {
    return [];
  }

  const errorText = uiState.errorText.trim();
  if (errorText) {
    const lines: CaptionLine[] = [];
    if (lastFinal && !lastFinal.captionRead) lines.push(finalLine(lastFinal));
    lines.push({
      key: 'error',
      text: errorText,
      kind: 'error',
      author: 'hemi',
    });
    return lines;
  }

  // 临时结果与末句定稿撞车时只显示一次（定稿刚落、临时结果还没清）。
  if (interim && interim !== lastFinal?.text) {
    return [
      {
        key: 'interim',
        text: interim,
        kind: 'interim',
        author: 'user',
      },
    ];
  }

  if (!lastFinal) return [];
  const unreadLines = lastFinal.captionRead ? [] : [finalLine(lastFinal)];
  if (lastFinal.author === 'hemi') return unreadLines;

  // 末句是用户句：等回应中。思考／回应阶段挂上「正在想」，状态可见。
  // 048：思考计时（thinkingSince 非空）只换文案不出思考文字；正文开始后
  // thinkingSince 被清，回到「正在想」。
  const waitingReply =
    uiState.turnPhase === 'thinking' || uiState.turnPhase === 'replying';
  if (!waitingReply) return unreadLines;
  const thinkingText = uiState.thinkingSince
    ? `思考中 · ${Math.max(0, Math.round((Date.now() - uiState.thinkingSince) / 1000))}s`
    : '正在想';
  return [...unreadLines, { key: 'thinking', text: thinkingText, kind: 'thinking', author: 'hemi' }];
}

/**
 * 字幕的「内容指纹」：只有内容真的变了才重新计时。
 * 用整个 UiState 当依据会被主窗口每秒推送的 elapsedSeconds 一直重置。
 */
export function captionContentKey(
  lines: CaptionLine[],
  fallbackCopy: string,
): string {
  return lines.length
    ? lines.map((line) => `${line.key}:${line.kind}:${line.text}`).join('\u0000')
    : fallbackCopy;
}

/**
 * 内容是否「新鲜」＝属于在途轮次（2026-09-24 两轮用户反馈后定稿的模型）：
 * 字幕卡是当前轮次的显示器，只在新内容（临时结果／定稿落地／思考行／
 * 错误行）或轮次仍在途（思考／播报／收尾）时点亮。
 *
 * **会话状态不等于内容新鲜**：按 Option 开始聆听时 sessionState/turnPhase
 * 转了 listening，但人还没开口、interim 为空——recentLines 里是上一轮的
 * 残留，那是旧内容，不能点亮（旧答案重播的根因）。聆听期该亮的是状态
 * 药丸（「我在听」）和球体（data-active），不是字幕卡。
 *
 * 注意「轮次刚落定」不算新鲜：那 4.5 秒阅读停留由 useAutoHide 计时负责，
 * 点亮过的内容靠闩锁保持（见 useContentLit），不靠这里反复判真。
 */
export function isCaptionContentFresh(uiState: UiState): boolean {
  return (
    uiState.turnPhase === 'thinking' ||
    uiState.turnPhase === 'speaking' ||
    uiState.turnPhase === 'replying' ||
    uiState.turnPhase === 'error' ||
    uiState.isSpeaking === true ||
    uiState.ttsActive === true ||
    uiState.interimText.trim() !== '' ||
    uiState.errorText.trim() !== ''
  );
}
