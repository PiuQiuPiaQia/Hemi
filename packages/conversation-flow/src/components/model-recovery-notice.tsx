import {useEffect, useId, useState} from 'react';
import {CheckCheck, ChevronDown, CircleAlert, LoaderCircle, Pause, RefreshCw, WifiOff} from 'lucide-react';
import type {ModelRecoveryView} from '../types/presentation.js';
import {useTranscriptRowState} from './transcript-row-state.js';

/** Compact, snapshot-driven status. Only the host owns timers that issue requests. */
export function ModelRecoveryNotice({recovery, onAction, onRestart, failureText}: {
  recovery: ModelRecoveryView;
  failureText?: string;
  onAction?: (action: 'stop' | 'retry', recoveryId: string) => void;
  onRestart?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useTranscriptRowState('model-recovery-details', false);
  const [pending, setPending] = useState(false);
  const detailId = useId();
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
  const remaining = Math.max(0, Math.ceil((recovery.deadlineAt - now) / 60000));
  const recovered = recovery.phase === 'recovered';
  const title = recovery.phase === 'offline' ? '等待网络恢复' : recovery.phase === 'expired' ? '自动恢复已到期'
    : recovery.phase === 'stopped' ? '已停止重连' : recovery.phase === 'failed' ? '恢复未完成'
    : recovered ? now - recovery.updatedAt < 3000 ? '已恢复' : '恢复记录' : '正在重连';
  const Icon = recovery.phase === 'offline' ? WifiOff : recovery.phase === 'connecting' ? LoaderCircle
    : recovered ? CheckCheck : recovery.phase === 'stopped' ? Pause
    : ['expired', 'failed'].includes(recovery.phase) ? CircleAlert : RefreshCw;
  const act = (action: 'stop' | 'retry') => { setPending(true); onAction?.(action, recovery.id); };
  return <div className="model-recovery-notice" data-phase={recovery.phase}>
    <div className="model-recovery-row">
      <Icon className="model-recovery-icon" size={14} strokeWidth={1.75} aria-hidden="true"/>
      <span className="model-recovery-title" role="status">{title}</span>
      {['waiting','offline'].includes(recovery.phase) ? <span className="model-recovery-countdown">{seconds} 秒后{recovery.phase === 'offline' ? '检查' : '重试'}</span>
        : recovery.phase === 'connecting' ? <span className="model-recovery-countdown">第 {recovery.attempt} 次</span> : null}
      {active && onAction ? <button type="button" className="model-recovery-action" disabled={pending} aria-label="停止恢复" onClick={() => act('stop')}>停止</button> : null}
      {['expired','failed'].includes(recovery.phase) && onRestart ? <button type="button" className="model-recovery-action primary" onClick={onRestart}>重新开始</button> : null}
      <button type="button" className="model-recovery-toggle" aria-label="恢复详情" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(value => !value)}><ChevronDown size={13} aria-hidden="true"/></button>
    </div>
    <div className="model-recovery-details" id={detailId} hidden={!open}>
      {recovery.phase === 'failed' && failureText ? <pre>{failureText}</pre> : null}
      <p>已重试 {recovery.attemptsMade ?? (['waiting','offline'].includes(recovery.phase) ? Math.max(0, recovery.attempt - 1) : recovery.attempt)} 次{active ? ` · 剩余 ${remaining} 分钟` : ''}</p>
      {active && recovery.phase !== 'connecting' && onAction ? <button type="button" className="model-recovery-action" disabled={pending || now < (recovery.notBefore ?? 0) || now >= recovery.deadlineAt} onClick={() => act('retry')}>立即重试</button> : null}
      {recovery.phase === 'expired' ? <p>会重发原消息，请先核对已执行的操作。</p> : null}
      <ol aria-label="恢复记录">{recovery.history?.map((entry, index) => <li key={`${entry.at}:${index}`}><time>{new Date(entry.at).toLocaleTimeString([], {hour12: false})}</time><span>{entry.phase === 'waiting' ? `第 ${entry.attempt} 次重试前：${entry.summary ?? '连接中断'}` : entry.phase === 'connecting' ? `第 ${entry.attempt} 次连接` : entry.phase === 'recovered' ? '已恢复连接' : entry.summary}</span></li>)}</ol>
    </div>
  </div>;
}
