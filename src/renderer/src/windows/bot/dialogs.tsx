import {DirectoryPicker} from '@hemi/conversation-flow/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Server,
  Monitor,
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
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
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
export function BotFolderPicker({host, initial, defaultDir, recent=[], load, onPick, onClose, online=true}: {
  host:string;initial:string;defaultDir?:string;recent?:string[];online?:boolean;load(path:string):Promise<BotDirectory>;onPick(path:string):Promise<void>;onClose():void;
}) {
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  return <DirectoryPicker path={initial} defaultPath={defaultDir} recent={recent} load={load} saving={saving} offline={!online} error={error} hostLabel={host} presentation="dialog" onClose={onClose} onSelect={path=>{setSaving(true);setError('');void onPick(path).then(()=>{if(alive.current)onClose();}).catch(reason=>{if(alive.current){setSaving(false);setError(reason instanceof Error?reason.message:'设置目录失败');}});}} renderSurface={({title,children,footer})=><BotDialog title={title} busy={saving} onClose={onClose} footer={footer}>{children}</BotDialog>}/>;
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
  const [tab, setTab] = useState<'manual' | 'local'>(candidateId ? 'local' : 'manual');
  const [models, setModels] = useState<BotModelCandidate[]>([]),

    [saving, setSaving] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  const locked = busy || saving;
  const tabsId = useId();
  const operation = useRef('models-' + crypto.randomUUID());
  const reportBusy = useCallback((value: boolean) => { setSaving(value); onBusyChange(value); }, [onBusyChange]);
  useEffect(() => {
    if (tab !== 'local' || loaded) return;
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
        const result = await api.initialize({ candidateId, ...(provider ? { provider } : {}), requestId: operation.current });
        return { providerId: result.cache?.models.at(-1)?.providerId ?? 'bot', modelKeys: result.cache?.models.map(model => model.key) ?? [] };
      }
      if (!provider) throw new Error('请在对话输入区直接选择本机模型。');
      const result = await api.command<{
        results: Array<{ key: string; ok: boolean; message?: string }>;
        providerId?: string;
        modelKeys?: string[];
      }>('models.add', { provider, requestId: operation.current });
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length) throw new Error(failed.map(result => result.message).join('；'));
      return { providerId: result.providerId ?? 'bot', modelKeys: result.modelKeys ?? result.results.map(model => model.key) };
    } catch (e) {
      if (!['offline', 'needs-review'].includes((e as { code?: string }).code ?? '')) operation.current = 'models-' + crypto.randomUUID();
      throw e;
    }
  }
  async function useLocalModel() {
    reportBusy(true);
    setError('');
    try { await save(); onDone(); } catch (error) {
      setError(error instanceof Error ? error.message : '模型配置未完成，请重试。');
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
      {candidateId ? <div className="h37-seg" role="tablist" aria-label="选择模型来源">
        {(['local', 'manual'] as const).map((value, index, values) => <button type="button" role="tab" key={value}
          id={`${tabsId}-${value}-tab`} aria-controls={`${tabsId}-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
          disabled={locked} onClick={() => { setTab(value); setError(''); }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'local' : event.key === 'End' ? 'manual' : values[(index + 1) % values.length];
            setTab(next); document.getElementById(`${tabsId}-${next}-tab`)?.focus();
          }}>{value === 'manual' ? '云端专用配置' : '本机模型'}</button>)}
      </div> : null}
      <p className="h-bot-small">{tab === 'local' ? '初始化时自动配置本机可用模型、主模型、角色模型与备用模型；后续本机变更自动更新。' : '此配置独立保存在 Bot，由服务器验证连接。'}</p>
      <div role={candidateId ? 'tabpanel' : undefined} id={`${tabsId}-manual`} aria-labelledby={candidateId ? `${tabsId}-manual-tab` : undefined} hidden={tab !== 'manual'}>
        <fieldset className="h-bot-model-form" disabled={locked}>
          <AddProviderView ctl={ctl} initial={null} embedded services={services} onAdded={onDone} onBusyChange={reportBusy}
            submitLabel={candidateId ? () => '初始化并开始使用' : undefined} />
        </fieldset>
      </div>
      <div role="tabpanel" id={`${tabsId}-local`} aria-labelledby={`${tabsId}-local-tab`} hidden={tab !== 'local'}>
      {!loaded && !error ? <p role="status">正在读取本机模型…</p> : null}
      {loaded && !models.length ? <p>暂无本机模型，请先在本机设置中添加，或使用云端专用配置。</p> : null}
      <div className="h-bot-models" role="list" aria-label="自动配置的本机模型">{models.map(model => <div role="listitem" className="h-bot-auto-model" key={model.key}><Monitor size={15} aria-hidden="true" /><span><strong>{model.name}</strong><small>{model.provider} · 本机</small></span><em>{model.reason || '自动配置'}</em></div>)}</div>
      <p className="h-bot-small">可用的 API Key 模型会保存到 Bot 并验证连接。云端验证可能产生少量调用费用。</p>
      {error && (
        <p role="alert" className="h-bot-error">
          {error}
        </p>
      )}
      <div className="h37m-add-foot">
        <BotButton disabled={locked} onClick={onCancel}>取消</BotButton>
        <BotButton primary disabled={locked || !models.some(model => model.canSync)} onClick={() => void useLocalModel()}>
          {saving ? '正在配置…' : '初始化并开始使用'}
        </BotButton>
      </div>
      </div>
    </div>
  );
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
