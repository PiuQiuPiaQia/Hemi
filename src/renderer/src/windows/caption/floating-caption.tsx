import type { CSSProperties } from 'react';

import { Markdown } from '@/shared/markdown';
import {
  useAutoHide,
  useFloatingCaption,
  useIdleHintVisible,
} from '@/windows/caption/use-floating-caption';
import { useTaskState } from '@/windows/voice/lib/voice-bridge';

/**
 * 悬浮球上方的字幕条（独立的透明窗口）。
 *
 * 状态与句子模型在 `use-floating-caption.ts` / `floating-caption-lines.ts`，
 * 这里只负责渲染：有内容时是一张毛玻璃字幕卡（单轮焦点，最多两行）；
 * 内容超出卡片高度不再自动上滚——读过的内容不在球上再滚一遍
 * （2026-10-15 用户反馈），超长只显示开头，全文去主窗口看；
 * 没有内容时收敛成一颗状态小药丸——空闲的操作提示只在首次放置后
 * 亮几秒就淡出，会话状态提示（连接中／聆听中／错误）保持常亮。
 *
 * 004：任务进行中追加一行任务进度（对话行 + 任务行分层，R-13），
 * 任务活跃期间整卡保持可见。
 */
export function FloatingCaption() {
  const { uiState, layout, lines, fallbackCopy, contentKey, hasLines } =
    useFloatingCaption();
  const taskState = useTaskState();
  // 使用真实 TTS 生命周期驱动字幕卡：播报中保持可见，播完后才开始淡出倒计时。
  const playbackActive = uiState.ttsActive;
  const autoVisible = useAutoHide(contentKey, playbackActive);
  const idleHintVisible = useIdleHintVisible();

  const taskActive = taskState.phase !== 'idle' && taskState.phase !== 'terminal';
  const taskVerifying = taskState.phase === 'terminal' && taskState.verifying;
  const permissionWaiting = taskState.phase === 'waiting' && taskState.permission;
  const showTaskRow = taskActive || taskVerifying;
  const visible = showTaskRow ? true : autoVisible;
  const taskCopy = showTaskRow
    ? `${taskState.verifying ? '正在核实：' : ''}${taskState.progressText}`
    : '';

  return (
    <main
      className="floating-caption-shell"
      data-placement={layout.placement}
      style={
        {
          '--caption-anchor-x': `${layout.anchorX}px`,
          '--caption-max-width': `${layout.maxWidth}px`,
        } as CSSProperties
      }
    >
      {hasLines || showTaskRow ? (
        <div
          className="floating-caption-copy"
          data-active={
            uiState.sessionState === 'requesting' ||
            uiState.sessionState === 'listening'
              ? 'true'
              : 'false'
          }
          data-speaking={uiState.isSpeaking ? 'true' : 'false'}
          data-has-lines="true"
          data-visible={visible ? 'true' : 'false'}
          data-floating-caption
          aria-live="polite"
        >
          {(hasLines && (!showTaskRow || autoVisible) ? lines : []).map((line) => (
            <span
              key={line.key}
              data-final={line.kind === 'final' ? 'true' : undefined}
              data-interim={line.kind === 'interim' ? 'true' : undefined}
              data-thinking={line.kind === 'thinking' ? 'true' : undefined}
              data-error={line.kind === 'error' ? 'true' : undefined}
              data-author={line.author}
              data-role={
                line.kind === 'error' || line.kind === 'thinking'
                  ? 'Hemi'
                  : line.author === 'hemi'
                    ? 'Hemi'
                    : '你'
              }
            >
              {/* Hemi 的定稿回应与主窗口同一套 Markdown 渲染（react-markdown + GFM）；
                  用户转写、思考与错误行保持纯文本。链接走主进程 allowlist，
                  但字幕条整窗点击穿透，点击交互仍在主窗口完成。 */}
              {line.kind === 'final' && line.author === 'hemi' ? (
                <Markdown text={line.text} />
              ) : (
                <em>{line.text}</em>
              )}
              {line.kind === 'thinking' ? (
                <i className="caption-thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </i>
              ) : null}
            </span>
          ))}

          {showTaskRow ? (
            <span className="caption-task-row" data-role="任务" role="status">
              <i className="caption-task-dot" aria-hidden="true" data-waiting={taskState.phase === 'waiting' ? 'true' : undefined} />
              <em>{taskCopy}</em>
            </span>
          ) : null}

          {/* 005 R-08：确认请求出现时字幕上给一行「需要授权」，语音场景不用盯主窗口。 */}
          {permissionWaiting ? (
            <span className="caption-task-row caption-permission-row" data-role="授权" role="alert">
              <i className="caption-task-dot" aria-hidden="true" data-waiting="true" />
              <em>需要你的允许：{permissionWaiting.summary}（去主窗口点一下）</em>
            </span>
          ) : null}
        </div>
      ) : (
        <div
          className="floating-status-pill"
          data-state={uiState.sessionState}
          data-visible={
            uiState.sessionState === 'idle'
              ? idleHintVisible
                ? 'true'
                : 'false'
              : 'true'
          }
          data-floating-caption
          aria-live="polite"
        >
          {fallbackCopy}
        </div>
      )}
    </main>
  );
}
