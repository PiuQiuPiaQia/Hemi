import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  ChevronRight,
  ChevronDown,
  Folder,
  RefreshCw,
  Server,
  Search,
  X,
} from 'lucide-react';
import type {
  BotBridge,
  BotDirectory,
  BotModelCandidate,
  BotState,
} from '@shared/bot';
import type { ModelProfilesDirectory, ModelProviderSaveInput } from '@shared/protocol';
import { AddProviderView, type ManualProviderServices, type ProviderSetupController } from '../voice/model-profiles-section';

export function BotDialog({
  title,
  children,
  footer,
  busy = false,
  onClose,
  className = '',
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={'h-bot-dialog ' + className}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="h-bot-dialog-head">
        <h2>{title}</h2>
        <button
          className="icon-btn"
          aria-label="关闭弹窗"
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="h-bot-dialog-body">{children}</div>
      {footer && <div className="h-bot-dialog-foot">{footer}</div>}
    </dialog>
  );
}
export function BotButton({
  primary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={
        'h-bot-btn' +
        (primary ? ' primary' : '') +
        ' ' +
        (props.className ?? '')
      }
    />
  );
}
export function BotFolderPicker({
  host,
  initial,
  defaultDir,
  recent = [],
  load,
  onPick,
  onClose,
  online = true,
}: {
  host: string;
  initial: string;
  defaultDir?: string;
  recent?: string[];
  online?: boolean;
  load: (path: string) => Promise<BotDirectory>;
  onPick: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(initial),
    [result, setResult] = useState<BotDirectory | null>(null),
    [busy, setBusy] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    alive = useRef(true),
    addressRevision = useRef(0),
    input = useRef<HTMLInputElement>(null);
  const parentPath = result?.parent ?? (() => {
    const value = address.trim().replace(/\/+$/, '');
    return value.slice(0, value.lastIndexOf('/')) || (value.startsWith('~') ? '~' : '/');
  })();
  async function browse(path: string) {
    if (saving || !online) return;
    const addressAtStart = ++addressRevision.current;
    const seq = ++epoch.current;
    setAddress(path);
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await load(path);
      if (alive.current && seq === epoch.current) {
        setResult(next);
        if (addressRevision.current === addressAtStart) setAddress(next.path);
        requestAnimationFrame(() => {
          if (
            document.activeElement === document.body ||
            document.activeElement === input.current?.closest('dialog')
          )
            input.current?.focus();
        });
      }
    } catch (e) {
      if (alive.current && seq === epoch.current)
        setError(e instanceof Error ? e.message : '服务器目录读取失败');
    } finally {
      if (alive.current && seq === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void browse(initial);
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    if (!online) {
      epoch.current++;
      setResult(null);
      setBusy(false);
      setError('连接已断开，恢复连接后重新读取目录。');
    }
  }, [online]);
  async function commit() {
    if (!result || address !== result.path) return;
    setSaving(true);
    try {
      await onPick(result.path);
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : '设置目录失败');
        setSaving(false);
      }
    }
  }
  return (
    <BotDialog
      title="选择云端文件夹"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <BotButton disabled={saving} onClick={onClose}>
            取消
          </BotButton>
          <BotButton
            primary
            disabled={
              busy ||
              saving ||
              !!error ||
              !result ||
              address !== result.path ||
              !online
            }
            onClick={() => void commit()}
          >
            {saving ? '正在设置…' : '使用此文件夹'}
          </BotButton>
        </>
      }
    >
      <p className="h-bot-host">
        <Server size={14} />
        {host}
      </p>
      <form
        className="h-bot-address"
        onSubmit={(e) => {
          e.preventDefault();
          void browse(address);
        }}
      >
        <button
          type="button"
          className="icon-btn"
          aria-label="上级目录"
          disabled={saving || busy || !online || result?.path === '/'}
          onClick={() => void browse(parentPath)}
        >
          <ArrowUp size={16} />
        </button>
        <input
          ref={input}
          aria-label="云端文件夹路径"
          value={address}
          disabled={saving}
          onChange={(e) => {
            addressRevision.current++;
            setAddress(e.target.value);
          }}
        />
        <BotButton disabled={saving || !online} onClick={() => void browse(address)}>
          前往
        </BotButton>
      </form>
      <div className="h-bot-shortcuts">
        {defaultDir ? <BotButton disabled={saving || !online} onClick={() => void browse(defaultDir)}>
          默认空间
        </BotButton> : null}
        <BotButton
          disabled={saving || !online}
          onClick={() => void browse(result?.home ?? '~')}
        >
          主目录
        </BotButton>
        {recent.slice(0, 3).map((dir) => (
          <BotButton
            key={dir}
            disabled={saving || !online}
            title={dir}
            onClick={() => void browse(dir)}
          >
            {dir.split('/').at(-1)}
          </BotButton>
        ))}
      </div>
      <div className="h-bot-folders" aria-label="云端目录列表" aria-busy={busy}>
        {busy ? (
          <p role="status">
            <RefreshCw size={16} className="h-bot-spin" />
            正在读取服务器文件夹…
          </p>
        ) : error ? (
          <div role="alert">
            <p>{error}</p>
            <BotButton disabled={!online} onClick={() => void browse(address)}>重试</BotButton>
          </div>
        ) : result?.folders.length ? (
          result.folders.map((folder) => (
            <button key={folder.path} onClick={() => void browse(folder.path)}>
              <Folder size={16} />
              <span>{folder.name}</span>
              <ChevronRight size={14} />
            </button>
          ))
        ) : (
          <p>此文件夹没有子文件夹</p>
        )}
      </div>
    </BotDialog>
  );
}
export function BotModelPicker({
  models,
  selected,
  onChange,
  disabled = false,
}: {
  models: BotModelCandidate[];
  selected: string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const panelId = useId(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const outsidePress = useRef(false);
  const chosen = models.filter(m => selected.includes(m.key));
  const filtered = models.filter(m => `${m.name} ${m.provider} ${m.key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const expanded = open && !disabled;
  useEffect(() => {
    if (!expanded) return;
    search.current?.focus();
    const press = (event: PointerEvent) => {
      outsidePress.current = event.target instanceof Node && !root.current?.contains(event.target);
    };
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
      outsidePress.current = false;
    };
    // Close after the clicked action runs; collapsing this in-flow panel on
    // pointerdown would move the import button before it receives its click.
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('click', outside);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('click', outside);
      outsidePress.current = false;
    };
  }, [expanded]);
  return (
    <div className="h-bot-model-picker" ref={root} onBlurCapture={event => {
      const next = event.relatedTarget;
      if (outsidePress.current) return;
      // On macOS, pressing a label first blurs its search input to the native
      // dialog, before the label forwards a click to its checkbox. Keep it mounted.
      if (next === event.currentTarget.closest('dialog') || next === document.body) return;
      if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
    }} onKeyDown={event => {
      if (event.key !== 'Escape' || !expanded) return;
      event.preventDefault(); event.stopPropagation();
      setOpen(false); trigger.current?.focus();
    }}>
      <span className="h-bot-model-label">本机模型</span>
      <button type="button" ref={trigger} className="h-bot-model-trigger" aria-label="选择导入模型"
        aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
        disabled={disabled || !models.length} onClick={() => {setQuery(''); setOpen(value => !value);}}>
        <span>{chosen.length ? chosen[0].name : '选择本机模型'}</span>
        {chosen.length > 1 ? <small>+{chosen.length - 1}</small> : null}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {expanded ? <div id={panelId} className="h-bot-model-panel" role="group" aria-label="本机模型">
        <div className="h-bot-model-search"><Search size={14} aria-hidden="true" /><input ref={search}
          aria-label="搜索本机模型" placeholder="搜索模型或供应商" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="h-bot-models">
      {filtered.map((m, index) => (
        <label key={m.key}>
          <input
            type="checkbox"
            aria-label={m.name}
            aria-describedby={`${panelId}-model-${index} ${panelId}-status-${index}`}
            checked={selected.includes(m.key)}
            disabled={disabled || !m.canSync}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, m.key]
                  : selected.filter((k) => k !== m.key),
              )
            }
          />
          <span>
            <strong>{m.name}</strong>
            <small id={`${panelId}-model-${index}`}>
              {m.provider} · {m.auth}
            </small>
          </span>
          <em id={`${panelId}-status-${index}`}>
            {m.reason ||
              (m.status === 'synced'
                ? '已同步'
                : m.status === 'update'
                  ? '有更新'
                  : '未同步')}
          </em>
        </label>
      ))}
        {!filtered.length ? <p className="h-bot-small">没有找到匹配的模型</p> : null}
        </div>
      </div> : null}
    </div>
  );
}
export function BotModelSetup({
  api,
  state,
  candidateId,
  busy = false,
  onDone,
  onCancel,
  onBusyChange,
}: {
  api: BotBridge;
  state: BotState;
  candidateId?: string;
  busy?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [tab, setTab] = useState<'manual' | 'import'>('manual');
  const [models, setModels] = useState<BotModelCandidate[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [saving, setSaving] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  const locked = busy || saving;
  const tabsId = useId();
  const operation = useRef('models-' + crypto.randomUUID());
  const reportBusy = useCallback((value: boolean) => { setSaving(value); onBusyChange(value); }, [onBusyChange]);
  useEffect(() => {
    if (tab !== 'import' || loaded) return;
    let alive = true;
    setError('');
    void api
      .models()
      .then((list) => {
        if (alive) {
          setModels(list);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [api, tab, loaded]);
  const services = useMemo<ManualProviderServices>(() => candidateId ? {} : ({
    testModelProfile: config => api.command('models.test', { config }),
    listRemoteModels: config => api.command('models.list', { config }),
  }), [api, candidateId]);
  async function save(provider?: ModelProviderSaveInput) {
    try {
      if (candidateId) {
        const result = await api.initialize({ candidateId, ...(provider ? { provider } : { modelKeys: selected }), requestId: operation.current });
        return { providerId: result.cache?.models.at(-1)?.providerId ?? 'bot', modelKeys: result.cache?.models.map(model => model.key) ?? [] };
      }
      const result = await api.command<{
        results: Array<{ key: string; ok: boolean; message?: string }>;
        providerId?: string;
        modelKeys?: string[];
      }>(provider ? 'models.add' : 'models.sync', { ...(provider ? { provider } : { keys: selected }), requestId: operation.current });
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length) throw new Error(failed.map(result => result.message).join('；'));
      return { providerId: result.providerId ?? 'bot', modelKeys: result.modelKeys ?? result.results.map(model => model.key) };
    } catch (e) {
      if (!['offline', 'needs-review'].includes((e as { code?: string }).code ?? '')) operation.current = 'models-' + crypto.randomUUID();
      throw e;
    }
  }
  async function importModels() {
    reportBusy(true);
    setError('');
    try { await save(); onDone(); } catch (error) {
      setError(error instanceof Error ? error.message : '导入结果待核对，请重新连接。');
    } finally {
      reportBusy(false);
    }
  }
  const directory: ModelProfilesDirectory = { version: 2, defaultModelId: null, providers: Array.from(new Map((state.cache?.models ?? []).map(model => [model.providerId, {
    id: model.providerId, name: model.name, baseUrl: model.baseUrl, api: 'openai-completions' as const,
    hasApiKey: true, keyStoredSecurely: true, updatedAt: 0, models: [],
  }])).values()) };
  const ctl: ProviderSetupController = {
    directory, readOnly: locked, saveProvider: save,
    mutate: async (_next, action) => { try { await action(directory); return null; } catch (error) { return error instanceof Error ? error.message : '添加失败，请重试。'; } },
    setStatus: () => {}, reload: async () => null, back: onCancel,
  };
  return (
    <div className="h-bot-model-setup">
      <div className="h37-seg" role="tablist" aria-label="添加模型方式">
        {(['manual', 'import'] as const).map((value, index, values) => <button type="button" role="tab" key={value}
          id={`${tabsId}-${value}-tab`} aria-controls={`${tabsId}-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
          disabled={locked} onClick={() => { setTab(value); setError(''); }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'manual' : event.key === 'End' ? 'import' : values[(index + 1) % values.length];
            setTab(next); document.getElementById(`${tabsId}-${next}-tab`)?.focus();
          }}>{value === 'manual' ? '手动添加' : '从本机导入'}</button>)}
      </div>
      <p className="h-bot-small">模型配置与 API Key 保存到 Bot，保存时由服务器验证连接。</p>
      <div role="tabpanel" id={`${tabsId}-manual`} aria-labelledby={`${tabsId}-manual-tab`} hidden={tab !== 'manual'}>
        <fieldset className="h-bot-model-form" disabled={locked}>
          <AddProviderView ctl={ctl} initial={null} embedded services={services} onAdded={onDone} onBusyChange={reportBusy}
            submitLabel={candidateId ? () => '初始化并开始使用' : undefined} />
        </fieldset>
      </div>
      <div role="tabpanel" id={`${tabsId}-import`} aria-labelledby={`${tabsId}-import-tab`} hidden={tab !== 'import'}>
      {!loaded && !error ? <p role="status">正在读取本机模型…</p> : null}
      {loaded && !models.length ? <p>暂无本机模型，可切换到“手动添加”直接配置。</p> : null}
      <BotModelPicker
        models={models}
        selected={selected}
        onChange={(keys) => {
          operation.current = 'sync-' + crypto.randomUUID();
          setSelected(keys);
        }}
        disabled={locked}
      />
      <p className="h-bot-small">
        选择本机已有的 API Key 模型导入，验证可能产生少量调用费用。
      </p>
      {error && (
        <p role="alert" className="h-bot-error">
          {error}
        </p>
      )}
      <div className="h37m-add-foot">
        <BotButton disabled={locked} onClick={onCancel}>取消</BotButton>
        <BotButton primary disabled={locked || !selected.length} onClick={() => void importModels()}>
          {saving ? '正在导入…' : candidateId ? '初始化并开始使用' : '导入到 Bot'}
        </BotButton>
      </div>
      </div>
    </div>
  );
}

export function BotAddModels({ api, state, onClose }: { api: BotBridge; state: BotState; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return <BotDialog title="添加模型" className="h-bot-model-dialog" busy={busy} onClose={onClose}>
    <BotModelSetup api={api} state={state} onDone={onClose} onCancel={onClose} onBusyChange={setBusy} />
  </BotDialog>;
}
export function BotSetup({
  api,
  state,
  onDone,
}: {
  api: BotBridge;
  state: BotState;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false),
    [step, setStep] = useState<'connect' | 'configure'>('connect'),
    [host, setHost] = useState(''),
    [password, setPassword] = useState(''),
    [remember, setRemember] = useState(false),
    [modelBusy, setModelBusy] = useState(false),
    [error, setError] = useState(''),
    [phase, setPhase] = useState('');
  const initializeRequest = useRef('initialize-' + crypto.randomUUID());
  const busy = !!state.busy || !!phase || modelBusy,
    candidate = state.candidate;
  async function connect() {
    setPhase('正在连接并检查服务器环境…');
    setError('');
    try {
      initializeRequest.current = 'initialize-' + crypto.randomUUID();
      await api.connect({
        host,
        password,
        rememberPassword: remember,
      });
      setPassword('');
      setStep('configure');
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setPhase('');
    }
  }
  async function initialize(existing = false) {
    if (!candidate) return;
    setPhase(
      existing ? '正在恢复已有 Bot…' : '正在部署、验证模型并初始化常驻服务…',
    );
    setError('');
    try {
      await api.initialize({
        candidateId: candidate.id,
        existing,
        requestId: initializeRequest.current,
      });
      setOpen(false);
      onDone();
    } catch (e) {
      if (
        !['needs-review', 'offline'].includes(
          (e as { code?: string }).code ?? '',
        )
      )
        initializeRequest.current = 'initialize-' + crypto.randomUUID();
      setError(
        (e instanceof Error ? e.message : '初始化未能确认。') +
          ' 可返回并重新检测服务器，原安装与数据会保留。',
      );
    } finally {
      setPhase('');
    }
  }
  return (
    <>
      <div className="h-bot-welcome">
        <Server size={26} />
        <h1>让 Hemi 在云端持续工作</h1>
        <p>连接 Linux 云服务器。Bot 在服务器常驻，关闭本机后也能继续工作。</p>
        <BotButton primary onClick={() => setOpen(true)}>
          创建连接
        </BotButton>
      </div>
      {open && (
        <BotDialog
          title={step === 'connect' ? '连接云服务器' : '配置云端 Bot'}
          className={step === 'configure' && !candidate?.info.bot?.configured ? 'h-bot-model-dialog' : ''}
          busy={busy}
          onClose={() => setOpen(false)}
          footer={
            <>
              {busy && step === 'configure' && (
                <BotButton
                  onClick={() =>
                    void api
                      .command('initialization.cancel')
                      .then(() =>
                        setError('已停止等待，请重新连接核对云端状态。'),
                      )
                  }
                >
                  停止等待
                </BotButton>
              )}
              {step === 'configure' && !busy && (
                <BotButton onClick={() => setStep('connect')}>返回</BotButton>
              )}
              {(step === 'connect' || candidate?.info.bot?.configured || candidate?.info.serviceError) && <BotButton
                primary
                disabled={
                  busy ||
                  (step === 'connect' && !host.trim()) ||
                  !!candidate?.info.serviceError
                }
                onClick={() =>
                  void (step === 'connect'
                    ? connect()
                    : initialize(!!candidate?.info.bot?.configured))
                }
              >
                {busy
                  ? '正在处理…'
                  : step === 'connect'
                    ? '连接并继续'
                    : candidate?.info.bot?.configured
                      ? '连接已有 Bot'
                      : '初始化并开始使用'}
              </BotButton>}
            </>
          }
        >
          {step === 'connect' ? (
            <>
              <label className="h-bot-field">
                SSH 地址
                <input
                  value={host}
                  disabled={busy}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="ubuntu@服务器地址或 SSH Host"
                />
              </label>
              <label className="h-bot-field">
                密码（可选）
                <input
                  type="password"
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="h-bot-check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                在本机记住密码
              </label>
            </>
          ) : candidate?.info.serviceError ? (
            <>
              <p role="alert">{candidate.info.serviceError}</p>
              <BotButton
                onClick={() =>
                  void api
                    .command('candidate.start')
                    .then(() => setError(''))
                    .catch((e) => setError(e.message))
                }
              >
                启动已安装服务并重新检测
              </BotButton>
            </>
          ) : candidate?.info.bot?.configured ? (
            <p>检测到服务器上已有 Bot，将恢复原会话和模型。</p>
          ) : (
            <BotModelSetup api={api} state={state} candidateId={candidate?.id} busy={!!state.busy || !!phase}
              onBusyChange={setModelBusy} onCancel={() => setStep('connect')}
              onDone={() => { setOpen(false); onDone(); }} />
          )}
          {(phase || state.busy) && (
            <p role="status">
              {(
                {
                  probe: '正在连接并检查服务器环境…',
                  deploy: '正在部署云端运行环境与 Host…',
                  models: '正在从云端验证所选模型…',
                  'verify-residency': '正在验证 SSH 断开后的常驻状态…',
                } as Record<string, string>
              )[state.busy] ?? phase}
            </p>
          )}
          {error && (
            <p role="alert" className="h-bot-error">
              {error}
            </p>
          )}
        </BotDialog>
      )}
    </>
  );
}
