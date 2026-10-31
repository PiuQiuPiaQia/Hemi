import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArchiveRestore, Check, CircleAlert, Cloud, FolderOpen, HardDrive, KeyRound } from 'lucide-react';
import type { BackupProgressEvent, BackupRestorePrepareResult, BackupSetSummary, BackupTargetDraft } from '@shared/protocol';
import { dateLabel, failure, sizeLabel, tierLabel } from './backup-settings';

export type OnboardingRestoreStage = 'source' | 'list' | 'preview' | 'done';
type Preview = NonNullable<BackupRestorePrepareResult['preview']>;

const JIANGUOYUN_DAV = 'https://dav.jianguoyun.com/dav/';
const JIANGUOYUN_HELP = 'https://help.jianguoyun.com/?p=2064';

function message(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function StepIcon({ children }: { children: ReactNode }) {
  return <span className="h37-tile onboarding-step-icon" data-tone="g" aria-hidden="true">{children}</span>;
}

/**
 * 首启「从备份恢复」：选来源 → 备份列表 → 恢复预览 → 完成。
 * 引导页风格（onboarding-*），备份读写全部走主进程备份桥；2026-11 起密钥随备份恢复。
 * initialStage 只给 fixtures 用：从真实桥（桩）按顺序取数据直达指定屏。
 */
export function OnboardingRestoreStep({ onFinished, onBack, onLockChange, initialStage = 'source' }: {
  onFinished: () => Promise<void>;
  onBack: () => void;
  /** 进行中或已恢复时锁住顶栏返回，避免恢复中途离开引导页。 */
  onLockChange: (locked: boolean) => void;
  initialStage?: OnboardingRestoreStage;
}) {
  const [stage, setStage] = useState<OnboardingRestoreStage>('source');
  const [kind, setKind] = useState<'local' | 'webdav'>('local');
  const [dir, setDir] = useState('');
  const [url, setUrl] = useState(JIANGUOYUN_DAV);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remoteDir, setRemoteDir] = useState('hemi-backups');
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [sets, setSets] = useState<BackupSetSummary[]>([]);
  const [chosen, setChosen] = useState<BackupSetSummary | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<null | 'pick' | 'test' | 'list' | 'prepare' | 'cancel' | 'apply' | 'finish'>(null);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [progress, setProgress] = useState<BackupProgressEvent | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const prepared = useRef(false);

  const locked = busy === 'apply' || busy === 'prepare' || busy === 'finish' || stage === 'done';
  useEffect(() => { onLockChange(locked); }, [locked, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);

  const run = useCallback(async (name: NonNullable<typeof busy>, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    setError('');
    try { await action(); }
    catch (reason) { if (alive.current) setError(message(reason)); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  }, []);

  const draft: BackupTargetDraft = kind === 'local' ? { kind, dir: dir.trim() } : {
    kind, url: url.trim(), username: username.trim(), remoteDir: remoteDir.trim(),
    hasPassword: hasSavedPassword, ...(password ? { password } : {}),
  };
  const validTarget = kind === 'local'
    ? !!dir.trim()
    : /^https?:\/\//i.test(url.trim()) && !!username.trim() && !!remoteDir.trim() && (!!password || hasSavedPassword);

  const loadList = useCallback(async (target?: BackupTargetDraft) => {
    if (target) {
      const view = await window.hemiVoice.saveBackupSettings({ target });
      setHasSavedPassword(view.target?.kind === 'webdav' && view.target.hasPassword);
      setPassword('');
    }
    const result = await window.hemiVoice.listBackups();
    const sorted = [...result].sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
    if (!alive.current) return sorted;
    setSets(sorted);
    setStage('list');
    return sorted;
  }, []);

  const prepare = useCallback(async (set: BackupSetSummary) => {
    setChosen(set);
    setProgress(null);
    const result = await window.hemiVoice.prepareBackupRestore(set.name);
    if (!result.ok || !result.preview) throw new Error(result.ok ? '没有拿到恢复预览，请重试。' : failure(result));
    prepared.current = true;
    if (!alive.current) return;
    setPreview(result.preview);
    setStage('preview');
  }, []);

  // 预填已保存的备份目标（同机重装后配置仍在时可直接查看）；读取失败不阻塞手动填写。
  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.hemiVoice.onBackupProgress?.(event => {
        if (!alive.current) return;
        setProgress(event.phase === 'done' || event.phase === 'error' ? null : event);
      });
    } catch { /* 进度只用于提示，订阅失败不影响恢复本身 */ }
    void window.hemiVoice.getBackupState?.().then(view => {
      const target = view?.target;
      if (!alive.current || !target) return;
      setKind(target.kind);
      if (target.kind === 'local') setDir(target.dir);
      else { setUrl(target.url); setUsername(target.username); setRemoteDir(target.remoteDir); setHasSavedPassword(target.hasPassword); }
    }).catch(() => {});
    if (initialStage !== 'source') {
      void run('list', async () => {
        const list = await loadList();
        if (initialStage === 'list') return;
        const first = list.find(item => !item.broken);
        if (first) await prepare(first);
        if (initialStage === 'done') { setPreview(null); prepared.current = false; setStage('done'); }
      });
    }
    return () => {
      alive.current = false;
      unsubscribe?.();
      // 离开引导页时清理已准备但未确认的恢复数据，不触发恢复。
      if (prepared.current && !lock.current) void window.hemiVoice.cancelBackupRestore().catch(() => {});
    };
  }, [initialStage, loadList, prepare, run]);

  const cancelPreview = () => void run('cancel', async () => {
    const result = await window.hemiVoice.cancelBackupRestore();
    if (!result.ok) throw new Error(failure(result));
    prepared.current = false;
    setPreview(null);
    setChosen(null);
    setStage('list');
  });

  const apply = () => void run('apply', async () => {
    const result = await window.hemiVoice.applyBackupRestore();
    if (!result.ok) throw new Error(failure(result));
    prepared.current = false;
    setProgress(null);
    setStage('done');
  });

  if (stage === 'source') return <>
    <StepIcon><ArchiveRestore /></StepIcon>
    <h1 className="onboarding-title">从备份恢复</h1>
    <p className="onboarding-lead">找到之前的备份，恢复会话、记忆和设置。</p>
    <div className="onboarding-restore-body">
      <div className="h37-seg onboarding-restore-kind" role="group" aria-label="备份位置">
        <button type="button" aria-pressed={kind === 'local'} disabled={!!busy} onClick={() => { setKind('local'); setTestResult(null); setError(''); }}><HardDrive size={14} aria-hidden="true" />本地文件夹</button>
        <button type="button" aria-pressed={kind === 'webdav'} disabled={!!busy} onClick={() => { setKind('webdav'); setTestResult(null); setError(''); }}><Cloud size={14} aria-hidden="true" />云端 WebDAV</button>
      </div>
      <fieldset className="onboarding-restore-fields" disabled={!!busy}>
        {kind === 'local' ? <div className="onboarding-restore-field">
          <label className="onboarding-field-label" htmlFor="restore-dir">备份文件夹</label>
          <div className="onboarding-restore-inline">
            <input id="restore-dir" className="h37-input onboarding-input" value={dir} placeholder="选择或粘贴备份所在的文件夹" onChange={event => { setDir(event.target.value); setTestResult(null); }} />
            <button type="button" className="h37-btn h37-btn-secondary onboarding-restore-pick" onClick={() => void run('pick', async () => {
              const picked = await window.hemiVoice.pickBackupDirectory();
              if (!picked.canceled && picked.path) { setDir(picked.path); setTestResult(null); }
            })}><FolderOpen size={14} aria-hidden="true" />{busy === 'pick' ? '选择中…' : '选择…'}</button>
          </div>
        </div> : <>
          <div className="onboarding-restore-field">
            <label className="onboarding-field-label" htmlFor="restore-url">服务器地址</label>
            <input id="restore-url" className="h37-input onboarding-input" value={url} inputMode="url" onChange={event => { setUrl(event.target.value); setTestResult(null); }} />
          </div>
          <div className="onboarding-restore-field">
            <label className="onboarding-field-label" htmlFor="restore-user">账号</label>
            <input id="restore-user" className="h37-input onboarding-input" value={username} autoComplete="username" placeholder="坚果云登录邮箱" onChange={event => { setUsername(event.target.value); setTestResult(null); }} />
          </div>
          <div className="onboarding-restore-field">
            <div className="onboarding-field-top"><label className="onboarding-field-label" htmlFor="restore-password">应用密码</label><button type="button" className="h37-link onboarding-link" onClick={() => void window.hemiVoice.openExternal(JIANGUOYUN_HELP)}>打开教程 ↗</button></div>
            <input id="restore-password" className="h37-input onboarding-input" type="password" autoComplete="new-password" value={password} placeholder={hasSavedPassword ? '已保存，留空保持不变' : '在坚果云「账户信息 → 安全选项」中生成'} onChange={event => { setPassword(event.target.value); setTestResult(null); }} />
            <p className="onboarding-field-help">应用密码不是坚果云登录密码。</p>
          </div>
          <div className="onboarding-restore-field">
            <label className="onboarding-field-label" htmlFor="restore-remote">备份目录</label>
            <input id="restore-remote" className="h37-input onboarding-input" value={remoteDir} onChange={event => { setRemoteDir(event.target.value); setTestResult(null); }} />
          </div>
        </>}
      </fieldset>
      <div className="onboarding-test-row">
        <button type="button" className="h37-btn h37-btn-ghost onboarding-test-button" disabled={!!busy || !validTarget} onClick={() => void run('test', async () => {
          const result = await window.hemiVoice.testBackupConnection(draft);
          if (alive.current) setTestResult(result.ok ? { ok: true, text: result.message || '连接成功' } : { ok: false, text: failure(result) });
        })}>{busy === 'test' ? '测试中…' : '测试连接'}</button>
        {testResult ? <span className="onboarding-test-result" data-kind={testResult.ok ? 'ok' : 'error'} role={testResult.ok ? 'status' : 'alert'}>{testResult.ok ? <span className="h37-badge" data-tone="ok">{testResult.text}</span> : testResult.text}</span> : null}
      </div>
    </div>
    <div className="onboarding-actions" data-row="true">
      <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={!!busy || !validTarget} onClick={() => void run('list', async () => { await loadList(draft); })}>{busy === 'list' ? '正在查找…' : '查看备份'}</button>
      <button type="button" className="h37-btn h37-btn-ghost onboarding-secondary" disabled={!!busy} onClick={onBack}>返回</button>
    </div>
    {error ? <p className="onboarding-field-error" role="alert">{error}</p> : null}
  </>;

  if (stage === 'list') {
    const where = kind === 'local' ? dir.trim() : `${url.trim().replace(/\/+$/, '')}/${remoteDir.trim()}`;
    return <>
      <StepIcon><ArchiveRestore /></StepIcon>
      <h1 className="onboarding-title">选择要恢复的备份</h1>
      <p className="onboarding-lead onboarding-restore-where" title={where}>{where || '已保存的备份位置'}</p>
      {busy === 'list' && sets.length === 0 ? <p className="onboarding-field-help" role="status">正在查找备份…</p> : sets.length === 0 ? (
        <div className="onboarding-restore-empty" role="status">
          <p>没有找到备份，检查位置后重试。</p>
          <button type="button" className="h37-btn h37-btn-secondary" onClick={() => { setError(''); setStage('source'); }}>修改位置</button>
        </div>
      ) : (
        <ul className="h37-group onboarding-restore-list" aria-label="备份列表">
          {sets.map(set => <li key={`${set.source}:${set.name}`} className="h37-row" data-broken={set.broken ? 'true' : undefined}>
            <span className="h37-row-text">
              <b>{dateLabel(set.createdAt)}</b>
              <span>{set.broken ? '备份已损坏，无法恢复' : `${tierLabel(set.tier)} · ${sizeLabel(set.totals?.packedBytes)}${set.appVersion ? ` · v${set.appVersion}` : ''}`}</span>
            </span>
            <span className="h37-row-end">
              <span className="h37-badge" data-tone={set.broken ? 'danger' : undefined}>{set.broken ? '已损坏' : set.source === 'webdav' ? '云端' : '本机'}</span>
              <button type="button" className="h37-btn h37-btn-secondary" disabled={!!busy || set.broken} aria-label={`恢复 ${dateLabel(set.createdAt)} 的备份`} onClick={() => void run('prepare', () => prepare(set))}>{busy === 'prepare' && chosen?.name === set.name ? '准备中…' : '恢复'}</button>
            </span>
          </li>)}
        </ul>
      )}
      {sets.length > 0 ? <div className="onboarding-actions" data-row="true">
        <button type="button" className="h37-btn h37-btn-ghost onboarding-secondary" disabled={!!busy} onClick={() => { setError(''); setStage('source'); }}>更换位置</button>
      </div> : null}
      {busy === 'prepare' && progress ? <p className="onboarding-field-help" role="status">{progress.phase === 'restore-download' ? '正在下载备份…' : '正在准备…'}{progress.detail ? ` ${progress.detail}` : ''}</p> : null}
      {error ? <p className="onboarding-field-error" role="alert">{error}</p> : null}
    </>;
  }

  if (stage === 'preview') return <>
    <StepIcon><ArchiveRestore /></StepIcon>
    <h1 className="onboarding-title">确认恢复</h1>
    <p className="onboarding-lead">{chosen ? `${dateLabel(chosen.createdAt)} 的备份` : '所选备份'}将恢复以下内容。</p>
    {preview ? <dl className="onboarding-restore-stats">
      <div><dt>文件</dt><dd>{preview.files.toLocaleString('zh-CN')}</dd></div>
      <div><dt>会话</dt><dd>{preview.conversations.toLocaleString('zh-CN')}</dd></div>
      <div><dt>记忆</dt><dd>{preview.memoryFiles.toLocaleString('zh-CN')}</dd></div>
      {preview.estimate && <>
        <div><dt>新增</dt><dd>{preview.estimate.newFiles.toLocaleString('zh-CN')}</dd></div>
        <div><dt>相同跳过</dt><dd>{preview.estimate.identical.toLocaleString('zh-CN')}</dd></div>
        <div><dt>冲突</dt><dd>{preview.estimate.conflicts.toLocaleString('zh-CN')}</dd></div>
      </>}
    </dl> : null}
    <div className="onboarding-restore-note">
      <p><CircleAlert aria-hidden="true" /><span>合并恢复：相同数据自动跳过；冲突保留较新版本，落选数据存入安全副本；密钥与加密配置按备份整组恢复，本地较新者如需保留请重填。</span></p>
      <p data-strong="true"><KeyRound aria-hidden="true" /><span><b>模型与语音密钥已包含在备份中</b>，恢复后即可直接使用。</span></p>
    </div>
    <div className="onboarding-actions" data-row="true">
      <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={!!busy || !preview} onClick={apply}>{busy === 'apply' ? '正在恢复…' : '确认恢复'}</button>
      <button type="button" className="h37-btn h37-btn-ghost onboarding-secondary" disabled={!!busy} onClick={cancelPreview}>{busy === 'cancel' ? '取消中…' : '取消'}</button>
    </div>
    {busy === 'apply' ? <p className="onboarding-field-help" role="status">正在恢复，请不要关闭应用。</p> : null}
    {error ? <p className="onboarding-field-error" role="alert">{error}</p> : null}
  </>;

  return <>
    <StepIcon><Check /></StepIcon>
    <h1 className="onboarding-title">已恢复</h1>
    <p className="onboarding-lead">重启应用后完全生效。</p>
    <div className="onboarding-restore-note">
      <p><CircleAlert aria-hidden="true" /><span>合并恢复已完成：相同数据自动跳过，冲突保留了较新版本，落选数据存入安全副本。</span></p>
      <p data-strong="true"><KeyRound aria-hidden="true" /><span><b>模型与语音密钥已随备份恢复。</b>密钥与加密配置按备份整组恢复，若某项在备份后更换过，请到 设置 → 模型与路由／语音与通话 重填。</span></p>
    </div>
    <div className="onboarding-actions">
      <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={!!busy} onClick={() => void run('finish', onFinished)}>{busy === 'finish' ? '正在进入…' : '开始使用'}</button>
    </div>
    {error ? <p className="onboarding-field-error" role="alert">{error}</p> : null}
  </>;
}
