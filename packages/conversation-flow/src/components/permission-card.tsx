import {useLayoutEffect} from 'react';
import {ShieldAlert} from 'lucide-react';
import type {TaskStateSnapshot, TaskPermissionChoice} from '../types/presentation.js';

const OPTION_ORDER = ['拒绝', '本任务允许', '允许这次', '持续允许'];

/** Historical labels remain supported; an unknown label never grants access. */
function choiceOf(option: string): TaskPermissionChoice {
  switch (option) {
    case '本任务允许': case '本会话允许': return 'task';
    case '持续允许': case '永远允许': return 'persistent';
    case '允许这次': case '仅此一次': case '允许一次': return 'once';
    default: return 'deny';
  }
}

export interface PermissionRequest {
  id: string;
  title: string;
  options: readonly string[];
  kind?: 'grant' | 'action';
  args?: Record<string, unknown>;
  note?: string | null;
  /** Omit for Bot requests, which wait until explicitly decided. */
  remainingMs?: number;
}

export interface PermissionRequestCardProps {
  request: PermissionRequest;
  layout?: 'desktop' | 'touch';
  taskText?: string;
  queuedTitles?: readonly string[];
  disabled?: boolean;
  onChooseOption(option: string): void;
  onStop?(): void;
}

/** Raw options round-trip unchanged. Host adapters retain transport and receipt ownership. */
export function PermissionRequestCard({request, layout = 'desktop', taskText, queuedTitles = [], disabled = false, onChooseOption, onStop}: PermissionRequestCardProps) {
  const remainingMs = request.remainingMs;
  const timed = remainingMs !== undefined;
  const blocked = disabled || (timed && remainingMs <= 0);
  const rank = (option: string) => {const index = OPTION_ORDER.indexOf(option); return index < 0 ? OPTION_ORDER.length : index;};
  const options = layout === 'touch' ? request.options : [...request.options].sort((a, b) => rank(a) - rank(b));
  const primary = options.includes('持续允许') ? '持续允许' : options.find(option => choiceOf(option) !== 'deny') ?? options[0];
  const command = typeof request.args?.command === 'string' ? request.args.command : typeof request.args?.path === 'string' ? request.args.path : '';
  const foot = request.kind === 'grant' || options.includes('本任务允许')
    ? '本任务允许：结束后收回。持续允许：下次可直接使用，随时可撤销。'
    : '这次的选择不会被记住；下次同样的操作，还会再问。';

  return <section role={layout === 'touch' ? 'group' : 'alertdialog'} aria-modal={layout === 'desktop' ? false : undefined} aria-label={layout === 'touch' ? 'Bot 操作确认' : '操作授权请求'} className={layout === 'touch' ? 'hcf-touch-permission' : `permission-card permission-anchor${timed && remainingMs <= 3000 ? ' urgent' : ''}`}>
    {layout === 'desktop' ? <div className="permission-header">
      <span><ShieldAlert aria-hidden="true"/>Hemi 需要你的允许</span>
      <span className="count-label">{timed ? <><span data-count>{Math.max(0, Math.ceil(remainingMs / 1000))}</span> 秒</> : '等待确认'}</span>
      {onStop ? <button type="button" className="text-btn" onClick={onStop} disabled={disabled}>停止任务</button> : null}
    </div> : null}
    {timed ? <div className="countdown-track"><div className="countdown-fill" style={{width: `${Math.max(0, Math.min(100, remainingMs / 300))}%`}}/></div> : null}
    {layout === 'touch' ? <p>{request.title}</p> : <div className="permission-body">
      {taskText ? <span className="perm-task" title={`属于任务：${taskText}`}>属于任务 · {taskText.slice(0, 12)}</span> : null}
      <h3>{request.title}</h3>
      {command ? <pre className="permission-command">{command}</pre> : null}
      {request.note ? <p className="permission-note">{request.note}</p> : null}
      {command ? <details><summary>查看完整命令与路径</summary><pre>{command}</pre></details> : null}
    </div>}
    <div className={layout === 'touch' ? 'hcf-touch-permission-actions' : 'permission-actions'}>{options.map(option => <button key={option} type="button" className={layout === 'touch' ? 'secondary-button' : `tbtn${option === primary ? ' primary' : ''}`} disabled={blocked} onClick={() => onChooseOption(option)}>{option}</button>)}</div>
    {layout === 'desktop' ? <p className="permission-foot">{foot}</p> : null}
    {queuedTitles.length ? <div className="perm-queued" role="status">处理完这张，还有 {queuedTitles.length} 项在等 · {queuedTitles[0]}</div> : null}
  </section>;
}

/** Local task adapter: countdown, historical wording, and legacy Escape-to-deny. */
export function PermissionCard({snap, onDecide, onStop, queuedTitles = [], disabled = false}: {
  snap: TaskStateSnapshot;
  onDecide(choice: TaskPermissionChoice): void;
  onStop(): void;
  queuedTitles?: string[];
  disabled?: boolean;
}) {
  const permission = snap.permission;
  const legacy = Boolean(permission && !permission.kind);
  useLayoutEffect(() => {
    if (!legacy || disabled || !permission || permission.remainingMs <= 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.h37-menu, .scope-popover, .h37-scrim, [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); onDecide('deny');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [legacy, disabled, permission, onDecide]);
  if (!permission) return null;
  return <PermissionRequestCard request={{...permission,
    title: permission.kind ? permission.summary : `允许${permission.tool === 'bash' ? '执行这条命令' : permission.summary}吗？`,
    options: permission.options?.length ? permission.options : permission.kind === 'grant' ? ['本任务允许', '持续允许', '拒绝'] : ['允许这次', '拒绝'],
  }} taskText={snap.taskText} queuedTitles={queuedTitles} disabled={disabled} onStop={onStop} onChooseOption={option => onDecide(choiceOf(option))}/>;
}
