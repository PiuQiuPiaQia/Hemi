import {useEffect, useState} from 'react';
import {CheckCheck, CircleAlert, LoaderCircle, Pause, RefreshCw, WifiOff} from 'lucide-react';
import type {ModelRecoveryView} from '../types/presentation.js';

/** Compact, snapshot-driven status. Only the host owns timers that issue requests. */
export function ModelRecoveryNotice({recovery, onAction, onRestart}: {
  recovery: ModelRecoveryView;
  onAction?: (action: 'stop' | 'retry', recoveryId: string) => void;
  onRestart?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const active = ['waiting', 'offline', 'connecting'].includes(recovery.phase);
  useEffect(() => {
    setNow(Date.now());
    if (active) {
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    if (recovery.phase === 'recovered' && recovery.updatedAt + 3000 > Date.now()) {
      const timer = window.setTimeout(() => setNow(Date.now()), recovery.updatedAt + 3000 - Date.now());
      return () => window.clearTimeout(timer);
    }
  }, [active, recovery.id, recovery.phase, recovery.updatedAt]);
  useEffect(() => setPending(false), [recovery.id, recovery.updatedAt, recovery.phase]);
  const seconds = Math.max(0, Math.ceil(((recovery.nextRetryAt ?? now) - now) / 1000));
  const recovered = recovery.phase === 'recovered';
  // 2026-11-03 用户裁决：不设展开详情，历史重试次数没有读者——状态行只保留状态、时间和操作。
  const title = recovery.phase === 'offline' ? '等待网络恢复' : recovery.phase === 'expired' ? '自动恢复已到期'
    : recovery.phase === 'stopped' ? '已停止重连' : recovery.phase === 'failed' ? '恢复未完成'
    : recovered ? '已恢复' : '正在重连';
  const Icon = recovery.phase === 'offline' ? WifiOff : recovery.phase === 'connecting' ? LoaderCircle
    : recovered ? CheckCheck : recovery.phase === 'stopped' ? Pause
    : ['expired', 'failed'].includes(recovery.phase) ? CircleAlert : RefreshCw;
  const act = (action: 'stop' | 'retry') => {
    setPending(true);
    // 点击被拒（恢复状态已变化）时快照不会更新，靠派发结果收尾解除 pending，避免按钮卡在禁用。
    Promise.resolve(onAction?.(action, recovery.id)).catch(() => {}).finally(() => setPending(false));
  };
  return <div className="model-recovery-notice" data-phase={recovery.phase}>
    <div className="model-recovery-row">
      <Icon className="model-recovery-icon" size={14} strokeWidth={1.75} aria-hidden="true"/>
      <span className="model-recovery-title" role="status">{title}</span>
      {['waiting','offline'].includes(recovery.phase) ? <span className="model-recovery-countdown">{seconds} 秒后{recovery.phase === 'offline' ? '检查' : '重试'}</span>
        : recovery.phase === 'connecting' ? <span className="model-recovery-countdown">第 {recovery.attempt} 次</span> : null}
      {active && recovery.phase !== 'connecting' && onAction ? <button type="button" className="model-recovery-action" disabled={pending || now < (recovery.notBefore ?? 0) || now >= recovery.deadlineAt} onClick={() => act('retry')}>立即重试</button> : null}
      {active && onAction ? <button type="button" className="model-recovery-action" disabled={pending} aria-label="停止恢复" onClick={() => act('stop')}>停止</button> : null}
      {['expired','failed'].includes(recovery.phase) && onRestart ? <button type="button" className="model-recovery-action primary" onClick={onRestart}>重新开始</button> : null}
    </div>
  </div>;
}
