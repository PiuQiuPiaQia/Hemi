import { useEffect, useState } from 'react';

import type { TaskStateSnapshot } from '@/shared/types';
import { useTaskState } from '@/windows/voice/lib/voice-bridge';
import { CompactDelegation } from '@/windows/voice/compact-delegation';

/**
 * 悬浮任务菜单（独立小窗，R-14，对齐稿件 .hover-menu）：悬停悬浮球出现，
 * 内容是在跑任务的一行（056 起与对话流同一形态，不再是迷你任务卡）＋打开入口。悬停续命/离开隐藏由本窗与球
 * 各自上报 floating:task-hover，主进程统一宽限。
 */
export function TaskPopover() {
  const snap: TaskStateSnapshot = useTaskState();
  const [nowTick, setNowTick] = useState(Date.now);
  useEffect(() => {
    if (snap.phase === 'terminal') return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snap.phase]);
  // 017：小窗不翻页——计数一行 + 只显示最新布置的那张任务卡（017 交互稿 §附）。
  const activeTasks = (snap.tasks ?? []).filter(
    (task) => task.phase !== 'idle' && task.phase !== 'terminal',
  );
  const shown = activeTasks.at(-1) ?? (snap.phase !== 'idle' && snap.phase !== 'terminal' ? snap : null);

  return (
    <main
      className="task-popover-shell compact-shell"
      onMouseEnter={() => window.hemiVoice?.floatingTaskHover?.(true)}
      onMouseLeave={() => window.hemiVoice?.floatingTaskHover?.(false)}
    >
      <div className="hover-menu-popover" role="dialog" aria-label="当前任务">
        {activeTasks.length > 1 ? (
          <div className="mini-count">在跑 {activeTasks.length} 个任务 · 显示最新的</div>
        ) : null}
        {shown ? (
          <CompactDelegation
            snap={shown}
            nowTick={nowTick}
            onAction={(action, payload) =>
              void window.hemiVoice?.taskAction(action, { ...payload, taskKey: payload?.taskKey ?? shown.key ?? undefined })
            }
          />
        ) : null}
        <button
          type="button"
          className="h37-btn h37-btn-ghost h37-btn-sm task-popover-open"
          onClick={() => {
            window.hemiVoice?.floatingTaskHover?.(false);
            window.hemiVoice?.showMainWindow();
          }}
        >
          打开 Hemi 查看对话
        </button>
      </div>
    </main>
  );
}
