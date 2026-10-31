import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { TimedToast, useUiEnvironment } from '@hemi/ui';
import { openExternal } from '@/shared/open-external';
import type {
  BackupSettingsView, BackupTargetDraft, BackupTier, BackupSetSummary,
  BackupProgressEvent, BackupRestorePrepareResult,
} from '@shared/protocol';

const tierLabel = (tier: BackupTier | null) => tier === 'full' ? '完整档' : tier === 'light' ? '轻量档' : '档位未知';
function sizeLabel(bytes?: number | null) {
  if (bytes == null) return '体积未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[unit]}`;
}
function dateLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  return new Date(value).toLocaleString('zh-CN');
}
function failure(result: { code?: string; message?: string }) {
  const hint = result.code === 'AUTH_FAILED' ? '账号或应用密码错误，请检查后重试。'
    : result.code === 'NOT_FOUND' ? '未找到目标，请检查服务器地址或目录。' : '操作失败，请重试。';
  return result.message ? `${hint} ${result.message}` : `${hint}${result.code ? `（${result.code}）` : ''}`;
}
/** 页内进度行只描述进行中的阶段；done/error 终态反馈走 toast，不再占页内行。 */
const PROGRESS_LABELS: Partial<Record<BackupProgressEvent['phase'], string>> = {
  start: '正在开始备份', pack: '打包中', upload: '上传中', prune: '清理旧备份', 'restore-download': '下载恢复数据中',
};
function progressLabel(event: BackupProgressEvent) {
  return [PROGRESS_LABELS[event.phase] ?? '备份进行中', event.detail, event.packedBytes == null ? '' : sizeLabel(event.packedBytes), event.message].filter(Boolean).join(' · ');
}
function Select({ id, value, onChange, children, disabled, label }: { id: string; value: string; onChange: (value: string) => void; children: ReactNode; disabled?: boolean; label?: string }) {
  return <span className="h37-settings-select"><select id={id} className="h37-select" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{children}</select><ChevronDown aria-hidden="true" /></span>;
}
/** 编辑态的一行：定宽标签＋吃满剩余宽度的控件（可附说明）。 */
function EditRow({ id, label, children, help }: { id: string; label: string; children: ReactNode; help?: ReactNode }) {
  return <div className="h68-row">
    <label className="h68-key" data-fixed="true" htmlFor={id}>{label}</label>
    <span className="h68-field" style={{ flexWrap: 'wrap' }}>{children}{help && <small className="h37-help" style={{ flexBasis: '100%', overflowWrap: 'anywhere' }}>{help}</small>}</span>
  </div>;
}
/** 只读值行：左标签，右侧灰字值＋可选的就地编辑入口。 */
function ValueRow({ label, value, mono, action }: { label: string; value: ReactNode; mono?: boolean; action?: ReactNode }) {
  return <div className="h68-row"><span className="h68-key">{label}</span><span className={mono ? 'h68-value h68-mono' : 'h68-value'}>{value}</span>{action}</div>;
}

/**
 * 删除二次确认：锚定在「删除」链接旁的小气泡（Base UI Popover，定位/碰撞/外部点击/Esc
 * 与 @hemi/ui InfoPopover 同一套底座，但不要标题栏与关闭钮，只留一句话＋两个按钮）。
 * 开合由父级 deleting 单值受控，所以全页同时最多一个气泡；删除进行中拒绝任何关闭。
 */
function DeleteConfirm({ set, open, busy, disabled, onOpenChange, onConfirm }: {
  set: BackupSetSummary; open: boolean; busy: boolean; disabled: boolean;
  onOpenChange: (open: boolean) => void; onConfirm: () => void;
}) {
  const { portal } = useUiEnvironment();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <Popover.Root open={open} modal={false} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <Popover.Trigger ref={triggerRef} className="h37-link" disabled={disabled} aria-label={`删除 ${set.name}`}>删除</Popover.Trigger>
    <Popover.Portal container={portal ?? triggerRef.current?.closest<HTMLElement>('.compact-shell') ?? undefined}>
      <Popover.Positioner className="h68-confirm-positioner" side="bottom" align="end" sideOffset={6} collisionPadding={12} positionMethod="fixed">
        <Popover.Popup className="h68-confirm" role="alertdialog" aria-busy={busy} initialFocus={cancelRef}>
          <Popover.Title className="h68-confirm-text">{set.broken ? '此备份已损坏，删除后不可恢复。' : '删除此备份？此操作不可恢复。'}</Popover.Title>
          <div className="h68-confirm-actions">
            <Popover.Close ref={cancelRef} className="h37-link" disabled={busy}>取消</Popover.Close>
            <button type="button" className="h37-btn h37-btn-sm h37-btn-danger-solid" disabled={busy} aria-label={`确认删除 ${set.name}`} onClick={onConfirm}>{busy ? '删除中…' : '确认删除'}</button>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/**
 * 自包含的本机备份设置（系统偏好设置风，2026-11 用户选定方向 B）。
 * 目标与定时配置分别显式保存，避免半填写内容生效；已保存的目标默认收起为只读值行，
 * 「编辑／更改…」在原位置展开表单，取消即回到已保存的值。
 * 反馈口径（2026-11 重复「备份完成」修复）：进行中的进度留在页内行；终态 toast 严格以
 * 用户操作的 promise 返回为唯一出口——事件侧 done/error 只清进度行、不产生任何反馈，
 * 从根上避免「事件＋返回值」双报与跨 IPC 迟到事件的时间窗（无需后端给事件加标识）。
 * 操作成败等短反馈复用 @hemi/ui 的 TimedToast（同复制/会话菜单形态）；初始读取失败
 * 留在页内常驻并保留重试。
 */
export function BackupSettings() {
  const [state, setState] = useState<BackupSettingsView | null>(null);
  const [kind, setKind] = useState<'local' | 'webdav'>('local');
  const [dir, setDir] = useState('');
  const [url, setUrl] = useState('https://dav.jianguoyun.com/dav/');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remoteDir, setRemoteDir] = useState('hemi-backups');
  const [schedule, setSchedule] = useState<BackupSettingsView['schedule']>({ enabled: false, interval: 'daily', tier: 'light' });
  const [keep, setKeep] = useState('5');
  const [sets, setSets] = useState<BackupSetSummary[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>('load');
  // 初始读取失败留在页内（role=alert，重试成功前常驻）；操作类成/败反馈走 toast。
  const [loadError, setLoadError] = useState('');
  const [progress, setProgress] = useState<BackupProgressEvent | null>(null);
  const [toast, setToast] = useState<{ id: number; ok: boolean; text: string; duration: number } | null>(null);
  const [restore, setRestore] = useState<{ name: string; preview?: BackupRestorePrepareResult['preview'] } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(false);
  const toastSeq = useRef(0);
  const prepared = useRef(false);
  const restoreHeading = useRef<HTMLHeadingElement>(null);

  /** 短暂反馈统一出口：成功 2.6s；失败带原因停 6s；恢复成功含重启提示停 8s。 */
  function notify(text: string, ok = true, duration = ok ? 2600 : 6000) {
    setToast({ id: ++toastSeq.current, ok, text, duration });
  }

  function populateTarget(target: BackupSettingsView['target']) {
    if (!target) return;
    setKind(target.kind);
    if (target.kind === 'local') setDir(target.dir);
    else { setUrl(target.url); setUsername(target.username); setRemoteDir(target.remoteDir); }
  }
  function populate(view: BackupSettingsView) {
    setState(view);
    setSchedule(view.schedule);
    setKeep(String(view.keep));
    populateTarget(view.target);
  }
  async function refreshList() {
    const result = await window.hemiVoice.listBackups();
    if (alive.current) { setSets(result); setListLoaded(true); }
  }
  async function perform(name: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    if (name === 'load') setLoadError('');
    try { await action(); }
    catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      // 重试加载的失败留在页内（重试按钮就在旁边）；其余操作失败弹 toast，不静默吞掉。
      if (alive.current) { if (name === 'load') setLoadError(text); else notify(text, false); }
    }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  }
  useEffect(() => {
    alive.current = true;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.hemiVoice.onBackupProgress(event => {
        if (!active) return;
        // 事件只驱动页内「进行中」进度；终态（done/error）一律清行、不弹反馈——终态
        // toast 的唯一出口是发起操作的 promise 返回（见 runBackup/perform）。同 channel
        // IPC FIFO＋主进程 running 互斥保证终态事件不会晚于下一次操作的 start 事件到达，
        // 清行不会覆盖新操作的进度；极端乱序下最坏也只是进度行短暂消失、由后续事件恢复，
        // 任何延迟的迟到终态事件都不会再多弹一条 toast。
        if (event.phase === 'done' || event.phase === 'error') setProgress(null);
        else setProgress(event);
      });
    }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : String(cause)); }
    void (async () => {
      try {
        const view = await window.hemiVoice.getBackupState();
        if (active) populate(view);
        const result = await window.hemiVoice.listBackups();
        if (active) { setSets(result); setListLoaded(true); }
      } catch (cause) { if (active) setLoadError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) setBusy(null); }
    })();
    return () => {
      active = false; alive.current = false; unsubscribe?.();
      // 清理本页已准备但尚未确认的恢复数据，不触发恢复。
      if (prepared.current && !lock.current) {
        void window.hemiVoice.cancelBackupRestore().then(result => {
          if (!result.ok) console.warn('清理恢复预览失败', result.code);
        }).catch(cause => console.warn('清理恢复预览失败', cause));
      }
    };
  }, []);
  useEffect(() => { if (restore) restoreHeading.current?.focus(); }, [restore]);
  useEffect(() => {
    if (!focusField) return;
    document.getElementById(focusField)?.focus();
    setFocusField(null);
  }, [focusField]);

  const draft: BackupTargetDraft = kind === 'local' ? { kind, dir: dir.trim() } : {
    kind, url: url.trim(), username: username.trim(), remoteDir: remoteDir.trim(),
    hasPassword: state?.target?.kind === 'webdav' && state.target.hasPassword,
    ...(password ? { password } : {}),
  };
  const saved = state?.target;
  const targetDirty = !saved || saved.kind !== kind || (saved.kind === 'local'
    ? saved.dir !== dir.trim()
    : saved.url !== url.trim() || saved.username !== username.trim() || saved.remoteDir !== remoteDir.trim() || !!password);
  const validTarget = kind === 'local' ? !!dir.trim() : /^https?:\/\//i.test(url.trim()) && !!username.trim() && !!remoteDir.trim() && (!!password || (saved?.kind === 'webdav' && saved.hasPassword));
  const blocked = !!busy || !!restore;
  const configured = !!state?.target;
  const validKeep = /^\d+$/.test(keep) && Number(keep) >= 1 && Number(keep) <= 50;
  const scheduleDirty = !!state && (state.schedule.enabled !== schedule.enabled || state.schedule.interval !== schedule.interval || String(state.keep) !== keep);
  const last = state?.lastRun;
  const sortedSets = [...sets].sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
  // 未保存过目标时表单常开（即引导）；已保存则收起，点「编辑／更改…」或切换保存位置展开。
  const open = !saved || editing;

  function edit(field?: string) { setEditing(true); if (field) setFocusField(field); }
  function cancelEdit() { populateTarget(saved ?? null); setPassword(''); setEditing(false); }

  async function runBackup() {
    setProgress(null);
    await perform('backup', async () => {
      const result = await window.hemiVoice.runBackupNow();
      // 终态以 runBackupNow 返回为唯一出口，成败严格只报一次；失败时无需再刷新。
      notify(result.ok
        ? `备份完成${result.manifest ? ` · ${sizeLabel(result.manifest.packedBytes)}` : ''}`
        : failure(result), result.ok);
      if (!result.ok) return;
      // 备份已成功：随后的状态/列表刷新失败是另一件事，如实提示并明确归因，
      // 不得把成功的备份描述成失败，也不静默吞掉。
      try {
        setState(await window.hemiVoice.getBackupState());
        await refreshList();
      } catch {
        notify('备份已完成，列表刷新失败', false);
      }
    });
  }
  async function prepare(name: string) {
    setRestore({ name }); setProgress(null);
    await perform('prepare', async () => {
      const result = await window.hemiVoice.prepareBackupRestore(name);
      if (!result.ok || !result.preview) throw new Error(failure(result));
      if (!alive.current) { await window.hemiVoice.cancelBackupRestore(); return; }
      prepared.current = true;
      setRestore({ name, preview: result.preview });
      setProgress(null); // 恢复数据下载已结束，进行中行收掉
    });
  }

  const statusTone = !state || !configured || !last ? 'idle' : last.ok ? 'ok' : 'bad';
  const statusTitle = !state ? '正在读取备份设置' : !configured || !last ? '尚未备份' : last.ok ? '上次备份成功' : '上次备份失败';
  const statusDetail = !state ? '' : !configured ? '保存备份目标后即可开始。'
    : last ? `${dateLabel(last.at)} · ${tierLabel(last.tier)} · ${sizeLabel(last.packedBytes)} · ${last.trigger === 'manual' ? '手动' : ['scheduled', 'schedule', 'timer'].includes(last.trigger) ? '定时' : last.trigger}`
      : '目标已配置，可以开始首次备份。';
  const destination = saved?.kind === 'webdav' ? '坚果云' : saved?.kind === 'local' ? '本地文件夹' : '备份目标';

  const restorePanel = restore && <section className="h68-restore" aria-labelledby="backup-restore-title" aria-busy={busy === 'prepare' || busy === 'apply'}>
    <h4 id="backup-restore-title" tabIndex={-1} ref={restoreHeading}>恢复备份</h4>
    <p className="h68-mono" style={{ color: 'var(--muted)' }}>{restore.name}</p>
    {busy === 'prepare' && <p role="status">正在准备恢复预览…</p>}
    {restore.preview && <>
      <p>{restore.preview.files} 个文件 · {restore.preview.conversations} 个会话 · {restore.preview.memoryFiles} 条记忆文件</p>
      <p style={{ color: 'var(--muted)' }}>将覆盖的数据范围：{restore.preview.tops.join('、') || '无'}</p>
      <p className="h68-danger"><strong>恢复是目录级替换，当前同名数据会先存入安全副本；凭据不随备份恢复。</strong></p>
    </>}
    {!busy && !restore.preview && <p style={{ color: 'var(--muted)' }}>恢复预览未能完成，请取消后重试。</p>}
    <div className="h68-actions">
      <button className="h37-btn h37-btn-ghost" disabled={!!busy} onClick={() => void perform('cancel', async () => { const result = await window.hemiVoice.cancelBackupRestore(); if (!result.ok) throw new Error(failure(result)); prepared.current = false; setRestore(null); setProgress(null); })}>取消</button>
      <button className="h37-btn h37-btn-primary" disabled={!!busy || !restore.preview} onClick={() => void perform('apply', async () => { const result = await window.hemiVoice.applyBackupRestore(); if (!result.ok) throw new Error(failure(result)); prepared.current = false; setRestore(null); setProgress(null); notify('已恢复，重启应用后完全生效', true, 8000); })}>{busy === 'apply' ? '恢复中…' : '确认恢复'}</button>
    </div>
  </section>;

  return <div className="h37-enter h68-backup">
    <div className="h37-page-head"><div><h2>备份</h2><p>保留会话、记忆与设置，在需要时恢复。</p></div></div>

    <section className="h37-section" aria-label="备份状态">
      <div className="h68-list">
        <div className="h68-row">
          <span className="h68-key"><span>上次备份</span>{statusDetail && <small>{statusDetail}</small>}{last?.message && <small>{last.message}</small>}</span>
          <span className="h68-status" data-tone={statusTone}>{statusTitle}</span>
        </div>
        <div className="h68-row">
          <span className="h68-key"><span>手动备份</span><small>{targetDirty && configured ? '请先保存备份目标。' : `把当前会话、记忆与设置备份到${destination}。`}</small></span>
          <button className="h37-btn h37-btn-secondary" disabled={blocked || !configured || targetDirty} onClick={() => void runBackup()}>{busy === 'backup' ? '备份中…' : '立即备份'}</button>
        </div>
      </div>
      {progress && <p className="h37-settings-test h68-message" role="status" aria-live="polite">{progressLabel(progress)}</p>}
      {loadError && <p className="h37-settings-test h68-message" data-ok="false" role="alert">{loadError}</p>}
      {!state && !busy && <p className="h68-message"><button className="h37-btn h37-btn-secondary" onClick={() => void perform('load', async () => { populate(await window.hemiVoice.getBackupState()); await refreshList(); })}>重新加载</button></p>}
    </section>

    <section className="h37-section">
      <div className="h37-section-head"><h3>备份目标</h3>
        {saved && <span className="h37-aside">{editing
          ? <button type="button" className="h37-link" disabled={blocked} onClick={cancelEdit}>取消编辑</button>
          : <button type="button" className="h37-link" aria-label="编辑备份目标" disabled={blocked} onClick={() => edit()}>编辑</button>}</span>}
      </div>
      <fieldset className="h68-list" aria-label="保存位置" disabled={blocked || !state} style={{ border: 0, borderTop: '1px solid var(--line)', margin: 0, padding: 0, minWidth: 0 }}>
        <div className="h68-row">
          <span className="h68-key"><label htmlFor="backup-kind">保存位置</label>{!saved && <small>本地文件夹，或坚果云等 WebDAV 网盘。</small>}</span>
          <Select id="backup-kind" value={kind} onChange={value => { setKind(value as 'local' | 'webdav'); setEditing(true); }}><option value="local">本地文件夹</option><option value="webdav">云端 WebDAV（坚果云）</option></Select>
        </div>

        {kind === 'local' ? (open
          ? <EditRow id="backup-dir" label="文件夹路径">
              <input id="backup-dir" className="h37-input" style={{ flex: 1 }} value={dir} onChange={event => setDir(event.target.value)} placeholder="输入本机文件夹的完整路径" />
              <button type="button" className="h37-btn h37-btn-secondary" onClick={() => void perform('pick-dir', async () => { const picked = await window.hemiVoice.pickBackupDirectory(); if (!picked.canceled && picked.path) setDir(picked.path); })}>{busy === 'pick-dir' ? '选择中…' : '选择…'}</button>
            </EditRow>
          : <ValueRow label="文件夹路径" value={dir} mono action={<button type="button" className="h37-link" aria-label="更改文件夹路径" onClick={() => edit('backup-dir')}>更改…</button>} />
        ) : (open ? <>
            <EditRow id="backup-url" label="服务器地址"><input id="backup-url" className="h37-input" type="url" value={url} onChange={event => setUrl(event.target.value)} /></EditRow>
            <EditRow id="backup-account" label="账号"><input id="backup-account" className="h37-input" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></EditRow>
            <EditRow id="backup-password" label="应用密码"><input id="backup-password" className="h37-input" type="password" autoComplete="new-password" value={password} placeholder={saved?.kind === 'webdav' && saved.hasPassword ? '已保存，留空保持不变' : '输入应用密码，不是登录密码'} onChange={event => setPassword(event.target.value)} /></EditRow>
            <EditRow id="backup-remote-dir" label="云端目录"><input id="backup-remote-dir" className="h37-input" value={remoteDir} onChange={event => setRemoteDir(event.target.value)} /></EditRow>
          </> : <>
            <ValueRow label="服务器地址" value={url} />
            <ValueRow label="账号" value={username} />
            <ValueRow label="应用密码" value={saved?.kind === 'webdav' && saved.hasPassword ? '已保存' : '未保存'} action={<button type="button" className="h37-link" aria-label="更改应用密码" onClick={() => edit('backup-password')}>更改…</button>} />
            <ValueRow label="云端目录" value={remoteDir} mono action={<button type="button" className="h37-link" aria-label="编辑云端目录" onClick={() => edit('backup-remote-dir')}>编辑</button>} />
          </>
        )}

        {open && <div className="h68-actions">
          {saved && <button type="button" className="h37-btn h37-btn-ghost" onClick={cancelEdit}>取消</button>}
          <button type="button" className="h37-btn h37-btn-primary" disabled={!validTarget || !targetDirty} onClick={() => void perform('save-target', async () => { const view = await window.hemiVoice.saveBackupSettings({ target: draft }); setState(view); setPassword(''); setEditing(false); notify('备份目标已保存'); setListLoaded(false); setSets([]); await refreshList(); })}>{busy === 'save-target' ? '保存中…' : '保存目标'}</button>
        </div>}

        <div className="h68-row">
          <span className="h68-key">连接</span>
          <button type="button" className="h37-link" disabled={!validTarget} onClick={() => void perform('test', async () => { const result = await window.hemiVoice.testBackupConnection(draft); if (!result.ok) throw new Error(failure(result)); notify(result.message || '连接成功'); })}>{busy === 'test' ? '测试中…' : '测试连接'}</button>
        </div>
      </fieldset>
      {kind === 'webdav' && <p className="h68-foot">
        {open && <>应用密码在坚果云「账户信息 → 安全选项」中生成。<button type="button" className="h37-link" onClick={() => openExternal('https://help.jianguoyun.com/?p=2064')}>打开教程</button><br /></>}
        云端保存明文副本；登录凭据不进备份，恢复后需重新登录。
      </p>}
    </section>

    <section className="h37-section">
      <div className="h37-section-head"><h3>定时备份</h3></div>
      <fieldset className="h68-list" data-disabled={!configured} disabled={blocked || !configured} style={{ border: 0, borderTop: '1px solid var(--line)', margin: 0, padding: 0, minWidth: 0 }}>
        <div className="h68-row"><span className="h68-key"><span>自动备份</span><small>{configured ? '按所选频率自动执行。' : '配置目标后可用。'}</small></span><button type="button" role="switch" className="h37-switch" aria-label="自动备份" aria-checked={schedule.enabled} onClick={() => setSchedule({ ...schedule, enabled: !schedule.enabled })} /></div>
        <div className="h68-row"><label className="h68-key" htmlFor="backup-interval">频率</label><Select id="backup-interval" value={schedule.interval} onChange={value => setSchedule({ ...schedule, interval: value as 'daily' | 'weekly' })}><option value="daily">每天</option><option value="weekly">每周</option></Select></div>
        <div className="h68-row"><span className="h68-key"><label htmlFor="backup-keep">保留份数（1–50）</label><small>超出份数的旧备份会被自动清理。</small></span><input id="backup-keep" className="h37-input h68-keep" type="number" min={1} max={50} step={1} value={keep} aria-invalid={!validKeep} onChange={event => setKeep(event.target.value)} /></div>
        {scheduleDirty && <div className="h68-actions"><button className="h37-btn h37-btn-primary" disabled={!validKeep} onClick={() => void perform('save-schedule', async () => { setState(await window.hemiVoice.saveBackupSettings({ schedule, keep: Number(keep) })); notify('定时备份设置已保存'); })}>{busy === 'save-schedule' ? '保存中…' : '保存定时设置'}</button></div>}
      </fieldset>
    </section>

    <section className="h37-section">
      <div className="h37-section-head"><h3>备份集</h3><span className="h37-aside"><button type="button" className="h37-link" disabled={blocked || !configured || targetDirty} onClick={() => void perform('refresh', refreshList)}>{busy === 'refresh' ? '刷新中…' : '刷新'}</button></span></div>
      <div className="h68-list">
        {!sortedSets.length && <div className="h68-row"><span className="h68-key" style={{ color: 'var(--muted)' }}>{!configured ? '配置目标后可查看备份。' : !listLoaded ? '列表未加载，点击刷新。' : '还没有备份。'}</span></div>}
        {sortedSets.map(set => <div key={`${set.source}:${set.name}`}>
          <div className="h68-row">
            <span className="h68-key"><span className={set.broken ? 'h68-danger' : undefined}>{dateLabel(set.createdAt)}{set.broken ? ' · 损坏' : ''}</span><small className="h68-mono">{set.name}</small></span>
            <span className="h68-value">{set.broken ? '无法读取' : `${tierLabel(set.tier)} · ${sizeLabel(set.totals?.packedBytes)} · ${set.source === 'local' ? '本机' : '云端'}`}</span>
            <span className="h37-aside h68-row-actions">
              <button type="button" className="h37-link" disabled={blocked || targetDirty} aria-label={`恢复 ${set.name}`} onClick={() => { setDeleting(null); void prepare(set.name); }}>恢复</button>
              <DeleteConfirm set={set} open={deleting === set.name} busy={busy === 'delete'} disabled={blocked || targetDirty}
                onOpenChange={next => { if (next) setRestore(null); setDeleting(current => next ? set.name : current === set.name ? null : current); }}
                onConfirm={() => void perform('delete', async () => {
                  const result = await window.hemiVoice.deleteBackupSet(set.name);
                  if (!result.ok) throw new Error(failure(result));
                  setDeleting(null);
                  notify('已删除该备份');
                  await refreshList();
                })} />
            </span>
          </div>
          {restore?.name === set.name && restorePanel}
        </div>)}
        {restore && !sortedSets.some(set => set.name === restore.name) && restorePanel}
      </div>
    </section>

    {toast && <TimedToast key={toast.id} duration={toast.duration} tone={toast.ok ? undefined : 'error'} icon={toast.ok ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}>{toast.text}</TimedToast>}
  </div>;
}
