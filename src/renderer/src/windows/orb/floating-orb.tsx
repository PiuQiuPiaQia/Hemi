import { useEffect, useRef, useState } from 'react';

import { useTaskState, useUiState } from '@/windows/voice/lib/voice-bridge';

const HOLD_DELAY_MS = 360;
const DRAG_THRESHOLD_PX = 6;

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  holding: boolean;
};

export function FloatingOrb() {
  const uiState = useUiState();
  const taskState = useTaskState();
  const [gestureMode, setGestureMode] = useState<
    'idle' | 'pressing' | 'dragging' | 'holding'
  >('idle');
  // 悬停态用 JS 驱动（data-hovered），不信 CSS :hover——Chromium 在窗口
  // hide() 时不发 mouseleave，:hover 会冻结在旧值（用户反馈 2026-09-24：
  // 点球弹主窗、点别处回来后球常亮）。主进程在隐藏/重现时广播
  // visibilityChanged，这里把两个悬停态一并清掉。
  const [hovered, setHovered] = useState(false);
  const gestureRef = useRef<GestureState | null>(null);
  const holdTimerRef = useRef<number | null>(null);

  // 004：有任务时球挂角标；悬停出任务菜单（enter 延迟与宽限在主进程统一）。
  // 终态要熄灭：任务管理器全终态时顶层快照仍取最新一条（phase='terminal'，
  // 供字幕交代行），角标若不排除会把「已完成的任务」当「在跑」常亮不灭；
  // 终态但还在核验（verifying）的算数，核验也是任务在进行。
  const taskVisible =
    taskState.phase !== 'idle' &&
    (taskState.phase !== 'terminal' || taskState.verifying);
  const taskWaiting = taskState.phase === 'waiting';

  const isActive =
    uiState.sessionState === 'requesting' ||
    uiState.sessionState === 'listening';

  // 037：视觉状态单一来源（只驱动样式，不参与手势/窗口逻辑）。
  // 出错 > 思考 > 说话 > 聆听（含长按）> 空闲；各态由 037-overlays.css
  // 映射成色环转速、呼吸节奏与尺寸，状态间 400ms 插值。
  const orbState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' =
    uiState.sessionState === 'error' || uiState.turnPhase === 'error'
      ? 'error'
      : uiState.turnPhase === 'thinking'
        ? 'thinking'
        : uiState.isSpeaking || uiState.ttsActive || uiState.turnPhase === 'speaking'
          ? 'speaking'
          : isActive || gestureMode === 'holding'
            ? 'listening'
            : 'idle';
  const voiceActive = orbState === 'listening' || orbState === 'speaking';

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const finishGesture = (openOnTap: boolean) => {
    clearHoldTimer();
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setGestureMode('idle');

    if (!gesture) return;
    if (gesture.holding) {
      // 失焦/取消路径（openOnTap=false）不算「松手提交」，让主窗口作废这次单句。
      if (openOnTap) window.hemiVoice?.floatingHoldEnd();
      else window.hemiVoice?.floatingHoldCancel();
    }
    window.hemiVoice?.floatingDragEnd();

    if (openOnTap && !gesture.holding && !gesture.dragging) {
      window.hemiVoice?.showMainWindow();
    }
  };

  useEffect(() => {
    if (!window.hemiVoice) return undefined;

    const removeDragListener = window.hemiVoice.onFloatingDragDetected(() => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.holding || gesture.dragging) return;
      gesture.dragging = true;
      clearHoldTimer();
      setGestureMode('dragging');
    });
    // 窗口隐藏/重现（含首次加载前的 show）都重置悬停——重现时光标多半
    // 不在球上，冻结的悬停只会让球白亮。
    const removeVisibilityListener = window.hemiVoice.onFloatingVisibilityChanged?.(
      () => {
        setHovered(false);
      },
    );
    const cancelOnBlur = () => finishGesture(false);
    window.addEventListener('blur', cancelOnBlur);

    return () => {
      removeDragListener();
      removeVisibilityListener?.();
      window.removeEventListener('blur', cancelOnBlur);
      clearHoldTimer();
      if (gestureRef.current?.holding) window.hemiVoice.floatingHoldCancel();
      if (gestureRef.current) window.hemiVoice.floatingDragEnd();
    };
  }, []);

  const statusLabel = (() => {
    if (gestureMode === 'holding') return '松开提交';
    if (gestureMode === 'pressing') return '继续按住开始说话';
    if (gestureMode === 'dragging') return '拖动悬浮球';
    if (uiState.turnPhase === 'thinking') return '正在想';
    if (uiState.turnPhase === 'speaking') return '正在说，直接开口可以打断';
    if (uiState.turnPhase === 'replying') return '说完了';
    if (uiState.turnPhase === 'error') return '这次没接上';
    if (uiState.sessionState === 'requesting') {
      return uiState.callActive ? '正在接通通话' : '正在连接';
    }
    if (uiState.sessionState === 'listening') {
      return uiState.callActive ? '通话中，点击打开 Hemi' : '正在聆听';
    }
    if (uiState.sessionState === 'error') return '语音识别出现错误';
    return 'Hemi，按住说话，点击打开';
  })();

  return (
    <main className="floating-orb-shell">
      <button
        type="button"
        className="floating-orb-button"
        data-active={isActive ? 'true' : 'false'}
        data-hovered={hovered ? 'true' : 'false'}
        data-speaking={uiState.isSpeaking ? 'true' : 'false'}
        data-pressing={gestureMode === 'pressing' ? 'true' : 'false'}
        data-holding={gestureMode === 'holding' ? 'true' : 'false'}
        data-call={uiState.callActive ? 'true' : 'false'}
        data-state={orbState}
        data-task={taskVisible ? 'true' : undefined}
        aria-label={statusLabel}
        onMouseEnter={() => {
          setHovered(true);
          if (taskVisible) window.hemiVoice?.floatingTaskHover?.(true);
        }}
        onMouseLeave={() => {
          setHovered(false);
          window.hemiVoice?.floatingTaskHover?.(false);
        }}
        title={
          uiState.callActive
            ? '通话中 · 拖动移动 · 点击打开'
            : '按住说话 · 拖动移动 · 点击打开'
        }
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0 || gestureRef.current) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          gestureRef.current = {
            pointerId: event.pointerId,
            startX: event.screenX,
            startY: event.screenY,
            dragging: false,
            holding: false,
          };
          setGestureMode('pressing');
          window.hemiVoice?.floatingDragStart({
            x: event.screenX,
            y: event.screenY,
          });

          holdTimerRef.current = window.setTimeout(() => {
            const gesture = gestureRef.current;
            if (!gesture || gesture.dragging) return;
            gesture.holding = true;
            setGestureMode('holding');
            window.hemiVoice?.floatingHoldStart();
          }, HOLD_DELAY_MS);
        }}
        onPointerMove={(event) => {
          const gesture = gestureRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId || gesture.holding) return;
          const distance = Math.hypot(
            event.screenX - gesture.startX,
            event.screenY - gesture.startY,
          );

          if (!gesture.dragging && distance >= DRAG_THRESHOLD_PX) {
            gesture.dragging = true;
            clearHoldTimer();
            setGestureMode('dragging');
          }

          if (gesture.dragging) {
            window.hemiVoice?.floatingDragMove({
              x: event.screenX,
              y: event.screenY,
            });
          }
        }}
        onPointerUp={(event) => {
          if (gestureRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          finishGesture(true);
        }}
        onPointerCancel={() => finishGesture(false)}
      >
        <span className="floating-orb-waves" aria-hidden="true">
          <span className="floating-orb-wave floating-orb-wave-one" />
          <span className="floating-orb-wave floating-orb-wave-two" />
          <span className="floating-orb-wave floating-orb-wave-three" />
        </span>
        {/* 037：球体改用共享 h37-orb（conic 色环 + 不规则轮廓 + 呼吸），
            声波改用共享 h37-wave；不再有本组件私有的光团/音柱 keyframes。 */}
        <span className="floating-orb-core" aria-hidden="true">
          <span
            className="h37-orb floating-orb-face"
            data-live={orbState === 'thinking' ? 'false' : 'true'}
            data-still={orbState === 'error' ? 'true' : undefined}
          />
          <span
            className="h37-wave floating-orb-voice"
            data-active={voiceActive ? 'true' : 'false'}
          >
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </span>
        {taskVisible ? (
          <span
            className={`task-indicator${taskWaiting ? ' warning' : ''}`}
            aria-hidden="true"
          />
        ) : null}
      </button>
    </main>
  );
}
