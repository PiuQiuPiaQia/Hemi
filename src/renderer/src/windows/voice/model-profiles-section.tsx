import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, ChevronRight, ExternalLink, Globe, Lock, MoreHorizontal, Plus } from 'lucide-react';
import type {
  RoleModelSlot,
  RoleModelsView,
  ModelEntryView,
  ModelProviderApi,
  ModelProfilesDirectory,
  ModelProviderView,
  ModelTestResult,
  HemiVoiceBridge,
} from '@/shared/types';
import { SaveIndicator, useDelayed, type SaveState } from '@/components/save-indicator';
import { ModelRoutingDialog } from '@/windows/voice/model-routing-dialog';
import {
  KEYLESS_PLACEHOLDER_KEY,
  PROVIDER_PRESETS,
  draftModelEntry,
  findDefaultModel,
  guessVision,
  hostOf,
  isLocalEndpoint,
  modelUsage,
  presetById,
  providerSaveInput,
  providerTile,
  uniqueProviderName,
  type ProviderPreset,
} from '@/windows/voice/lib/provider-presets';
import { NewApiImportView, type ImportLock } from '@/windows/voice/newapi-import-section';
import { OAuthAccountSection } from '@/windows/voice/oauth-account-section';
import { copyTextViaBridge } from '@/lib/use-clipboard-copy';
import { useRemoteModels } from './lib/use-remote-models';
import { groupModelProviders } from '@shared/model-categories.mjs';
import { ModelConnectionMethods } from './model-connection-methods';
import { useSubscriptionQuota } from './lib/use-subscription-quota';
import { SubscriptionQuota, SubscriptionQuotaRefresh } from './subscription-quota-view';

/**
 * 037 模型页 v2（文本 tab）：「看图」即时保存 → 供应商摘要行 → 下钻供应商详情 / 添加供应商。
 * 数据流沿用 031 v2 IPC（listModelProfiles / saveModelProfile 整体提交 / removeModelProfile /
 * testModelProfile / setThinkingLevel）；Key 只写不读。
 * 外层 settings-screen 把本组件放在 <form> 里：按钮一律 type=button，输入框回车在根节点拦住。
 */

export type ModelView = { kind: 'overview' } | { kind: 'provider'; id: string } | { kind: 'add' };

export type ProviderStatus =
  | { state: 'testing' }
  | { state: 'ok'; latencyMs?: number }
  | { state: 'fail'; error: string };

type FixtureState = {
  view?: ModelView;
  statuses?: Record<string, ProviderStatus>;
  add?: { presetId: string; method?: 'oauth' | 'newapi' | 'manual'; apiKey?: string; status?: ProviderStatus };
  /** 056 fixtures：预置模型路由视图（截图取证用）。 */
  roleModels?: RoleModelsView;
};

let fixtureState: FixtureState | null = null;

/** fixtures 专用：预置首屏视图 / 供应商测试状态 / 添加页进度（不经 settings-screen 加 props）。 */
export function setModelProfilesFixtureState(state: FixtureState | null): void {
  fixtureState = state;
  if (state?.statuses) {
    for (const [id, status] of Object.entries(state.statuses)) statusCache.set(id, status);
  }
}

/** 供应商连通状态：每个应用会话自动测一次（缓存在模块级，切页不重测）。 */
const statusCache = new Map<string, ProviderStatus>();
const botStatusCaches = new Map<string, Map<string, ProviderStatus>>();


function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  // ipcRenderer.invoke 的错误带 "Error invoking remote method 'x': Error: " 前缀，只留中文原因。
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim() || '未知错误';
}

function testError(result: ModelTestResult): string {
  return result.error?.trim() || '连接失败';
}

/** 打开获取 Key 的页面；主进程外链白名单不放行时退回复制链接。 */
async function openKeyPage(url: string): Promise<string | null> {
  try {
    const opened = await window.hemiVoice?.openExternal?.(url);
    if (opened) return null;
  } catch {
    /* 落到复制 */
  }
  const copied = await copyTextViaBridge(url);
  return copied ? `没能直接打开，链接已复制：${url}` : `请在浏览器打开：${url}`;
}


function StatusBadge({
  status,
  provider,
  detail = false,
}: {
  status: ProviderStatus | undefined;
  provider: ModelProviderView;
  detail?: boolean;
}) {
  const slow = useDelayed(status?.state === 'testing');
  if (!provider.hasApiKey && !isLocalEndpoint(provider.baseUrl)) {
    return <span className="h37-badge" data-tone="warn">{provider.oauthProvider ? '未登录' : '未配 Key'}</span>;
  }
  if (!status) return detail ? <span className="h37-badge">未测试</span> : null;
  if (status.state === 'testing') {
    return slow ? (
      <span className="h37-badge" aria-live="polite">
        <span className="h37-spinner" aria-hidden />
        测试中
      </span>
    ) : null;
  }
  if (status.state === 'ok') {
    return (
      <span className="h37-badge" data-tone="ok">
        {detail && typeof status.latencyMs === 'number' ? `可用 · ${status.latencyMs} ms` : '可用'}
      </span>
    );
  }
  return (
    <span className="h37-badge" data-tone="warn" title={status.error}>
      连不上
    </span>
  );
}

/** 稿里的 .pick：可见的等宽值＋灰色副标题，上面叠一个透明原生 select（键盘、读屏照常）。 */
export function Pick({
  label,
  value,
  display,
  sub,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string;
  display: string;
  sub?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="h37-select h37m-pick" data-disabled={disabled ? 'true' : undefined}>
      <span className="h37m-pick-v">
        <span className="h37m-mono">{display}</span>
        {sub ? <span className="h37m-pick-sub">{sub}</span> : null}
      </span>
      <ChevronDown className="h37m-pick-chev" aria-hidden />
      <select
        className="h37m-pick-native"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </span>
  );
}

type MenuEntry =
  | {
      kind: 'item';
      label: string;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** 有值＝单选项（menuitemradio）。 */
      checked?: boolean;
      title?: string;
    }
  | { kind: 'sep' }
  | { kind: 'label'; label: string };

/** 「更多」菜单：挂到 body（分组有 overflow:hidden）、fixed 定位，下方放不下就翻到上方。 */
function MoreMenu({ label, entries, disabled }: { label: string; entries: MenuEntry[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const close = useCallback((refocus: boolean) => {
    if (closeTimer.current !== null) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setClosing(false);
      setPos(null);
      if (refocus) triggerRef.current?.focus();
    }, 140);
  }, []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open || pos) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const flip = below + height > window.innerHeight - 8 && rect.top - 4 - height >= 8;
    setPos({ top: flip ? rect.top - 4 - height : below, left, origin: flip ? 'bottom right' : 'top right' });
  }, [open, pos]);

  useEffect(() => {
    if (!open || !pos) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onMove = () => close(false);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, pos, close]);

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="h37-btn h37-btn-ghost h37-btn-icon h37-btn-sm"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <MoreHorizontal aria-hidden />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={label}
              className="h37-menu h37m-menu"
              data-closing={closing ? 'true' : undefined}
              style={{
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                visibility: pos ? undefined : 'hidden',
                ['--transform-origin' as string]: pos?.origin,
              }}
              onKeyDown={onMenuKey}
            >
              {entries.map((entry, index) => {
                if (entry.kind === 'sep') return <div key={index} className="h37-menu-sep" role="separator" />;
                if (entry.kind === 'label') {
                  return (
                    <div key={index} className="h37m-menu-label" role="presentation">
                      {entry.label}
                    </div>
                  );
                }
                const radio = typeof entry.checked === 'boolean';
                return (
                  <button
                    key={index}
                    type="button"
                    role={radio ? 'menuitemradio' : 'menuitem'}
                    aria-checked={radio ? entry.checked : undefined}
                    className="h37-menu-item"
                    data-danger={entry.danger ? 'true' : undefined}
                    disabled={entry.disabled}
                    title={entry.title}
                    onClick={() => {
                      entry.onSelect();
                      close(true);
                    }}
                  >
                    <span className="h37m-menu-text">{entry.label}</span>
                    {radio && entry.checked ? <Check aria-hidden /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** 删除供应商确认：默认模型在它名下时先选替代模型（主进程同样会拒绝无替代的删除）。 */
function DeleteProviderDialog({
  provider,
  directory,
  onCancel,
  onConfirm,
}: {
  provider: ModelProviderView;
  directory: ModelProfilesDirectory;
  onCancel: () => void;
  onConfirm: (replacementModelId?: string) => Promise<string | null>;
}) {
  const current = findDefaultModel(directory);
  const holdsDefault = current?.provider.id === provider.id;
  const replacements = useMemo(
    () =>
      directory.providers
        .filter((item) => item.id !== provider.id)
        .flatMap((item) => item.models.map((model) => ({ provider: item, model }))),
    [directory, provider.id],
  );
  const [replacement, setReplacement] = useState(holdsDefault ? (replacements[0]?.model.modelKey ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const slow = useDelayed(busy);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const picked = replacements.find((item) => item.model.modelKey === replacement);
  const confirm = async () => {
    if (holdsDefault && !replacement) {
      setError('这个供应商里有默认模型：先在下面选一个替代模型，再删除。');
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onConfirm(holdsDefault ? replacement : undefined);
    if (failure) {
      setBusy(false);
      setError(failure);
    }
  };

  return createPortal(
    <div
      className="h37-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="h37-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="h37m-delete-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h3 id="h37m-delete-title">删除「{provider.name}」？</h3>
        <p>
          它的 {provider.models.length} 个型号和已存的 Key 会一起删除，不能恢复。
          {holdsDefault ? '当前主脑模型在它名下，先选一个替代：' : ''}
        </p>
        {holdsDefault ? (
          <div className="h37m-dialog-pick">
            <Pick
              label="替代的主脑模型"
              value={replacement}
              display={picked?.model.model ?? '选一个模型'}
              sub={picked?.provider.name}
              disabled={busy}
              onChange={(value) => {
                setReplacement(value);
                setError(null);
              }}
            >
              {directory.providers
                .filter((item) => item.id !== provider.id)
                .map((item) => (
                  <optgroup key={item.id} label={item.name}>
                    {item.models.map((model) => (
                      <option key={model.modelKey} value={model.modelKey}>
                        {model.model}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </Pick>
          </div>
        ) : null}
        {error ? (
          <p className="h37-error-text h37m-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="h37-dialog-foot">
          <button ref={cancelRef} type="button" className="h37-btn h37-btn-ghost" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="h37-btn h37-btn-danger-solid" disabled={busy} onClick={() => void confirm()}>
            {slow ? <span className="h37-spinner" aria-hidden /> : null}
            删除
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type SaveInput = ReturnType<typeof providerSaveInput>;
type Mutate = (
  optimistic: ((directory: ModelProfilesDirectory) => ModelProfilesDirectory) | null,
  action: (next: ModelProfilesDirectory) => Promise<void>,
) => Promise<string | null>;

/** 子视图共用的读写口（数据、即时保存队列、探活、导航）。 */
type Controller = {
  bridge?: HemiVoiceBridge;
  environment?: 'local' | 'bot';
  botInstanceId?: string;
  onSyncLocal?: () => void;
  actions?: ReactNode;
  directory: ModelProfilesDirectory;
  readOnly: boolean;
  /** External hosts currently expose viewing and adding providers only. */
  external?: boolean;
  addDisabled?: boolean;
  saveState: SaveState;
  statuses: Record<string, ProviderStatus>;
  mutate: Mutate;
  saveProvider: (input: SaveInput) => Promise<{ providerId: string; modelKeys: string[] }>;
  testProvider: (provider: ModelProviderView) => Promise<void>;
  setStatus: (providerId: string, status: ProviderStatus) => void;
  clearStatus: (providerId: string) => void;
  /** 047：站点导入成功后重读主进程目录（不经 mutate 的乐观链）。 */
  reload: () => Promise<ModelProfilesDirectory | null>;
  back: () => void;
};

function patchModel(
  directory: ModelProfilesDirectory,
  modelKey: string,
  patch: Partial<ModelEntryView>,
): ModelProfilesDirectory {
  return {
    ...directory,
    providers: directory.providers.map((provider) =>
      provider.models.some((model) => model.modelKey === modelKey)
        ? {
            ...provider,
            models: provider.models.map((model) => (model.modelKey === modelKey ? { ...model, ...patch } : model)),
          }
        : provider,
    ),
  };
}

function patchProvider(
  directory: ModelProfilesDirectory,
  providerId: string,
  patch: (provider: ModelProviderView) => ModelProviderView,
): ModelProfilesDirectory {
  return {
    ...directory,
    providers: directory.providers.map((provider) => (provider.id === providerId ? patch(provider) : provider)),
  };
}

/** 看图下拉的「不看图」哨兵值（映射回 null）。 */
const VISION_OFF = '@none';

function findModelRef(directory: ModelProfilesDirectory, modelKey: string) {
  for (const provider of directory.providers) {
    const model = provider.models.find((entry) => entry.modelKey === modelKey);
    if (model) return { provider, model };
  }
  return null;
}

function scrollParentToTop(node: HTMLElement | null) {
  let parent = node?.parentElement ?? null;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      parent.scrollTop = 0;
      return;
    }
    parent = parent.parentElement;
  }
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

export function ModelProfilesSection({
  fixtureDirectory,
  onViewChange,
  externalDirectory,
  onAddProvider,
  addDisabled,
  api,
  environment = 'local',
  botInstanceId,
  onSyncLocal,
  actions,
  disabled = false,
  openAddRequest = 0,
}: {
  fixtureDirectory?: ModelProfilesDirectory | null;
  /** Cloud directory: never load, probe or mutate local model configuration. */
  externalDirectory?: ModelProfilesDirectory;
  onAddProvider?: () => void;
  addDisabled?: boolean;
  api?: HemiVoiceBridge;
  environment?: 'local' | 'bot';
  botInstanceId?: string;
  onSyncLocal?: () => void;
  actions?: ReactNode;
  disabled?: boolean;
  /** A host action may open the shared add flow, e.g. a pending Bot authorization. */
  openAddRequest?: number;
  /** 下钻/返回时通知外壳（详情、添加页需要隐藏外层「模型」页头与「其他」组）。 */
  onViewChange?: (kind: ModelView['kind']) => void;
}) {
  const bridge = api ?? window.hemiVoice;
  const probeCache = useMemo(() => {
    if (environment !== 'bot') return statusCache;
    const identity = botInstanceId ?? 'unbound';
    let cache = botStatusCaches.get(identity);
    if (!cache) { cache = new Map(); botStatusCaches.set(identity, cache); }
    return cache;
  }, [environment, botInstanceId]);
  const [initialFixture] = useState(() => fixtureState);
  const [directory, setDirectory] = useState<ModelProfilesDirectory | null>(externalDirectory ?? fixtureDirectory ?? null);
  const directoryRef = useRef<ModelProfilesDirectory | null>(directory);
  const [loading, setLoading] = useState(!externalDirectory && !fixtureDirectory);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ModelView>(initialFixture?.view ?? { kind: 'overview' });
  const [pane, setPane] = useState<{ key: number; anim: 'forward' | 'back' | null }>({ key: 0, anim: null });
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>(() => Object.fromEntries(probeCache));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const savedTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const slowLoading = useDelayed(loading);
  const external = Boolean(externalDirectory) && !api;
  const readOnly = external || disabled || Boolean(directory?.corrupt);

  const commit = useCallback((next: ModelProfilesDirectory | null) => {
    directoryRef.current = next;
    setDirectory(next);
  }, []);

  const reload = useCallback(async () => {
    if (external || fixtureDirectory || !bridge?.listModelProfiles) return directoryRef.current;
    const next = await bridge.listModelProfiles();
    commit(next);
    return next;
  }, [external, fixtureDirectory, commit, bridge]);

  useEffect(() => {
    if (externalDirectory) {
      commit(externalDirectory);
      setLoading(false);
      return;
    }
    if (fixtureDirectory) {
      commit(fixtureDirectory);
      setLoading(false);
      return;
    }
    if (!bridge?.listModelProfiles) {
      setLoading(false);
      setLoadError('读不到模型配置（桥接不可用）。');
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge
      .listModelProfiles()
      .then((next) => {
        if (cancelled) return;
        commit(next);
        setLoadError(null);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(`读不到模型配置：${errorText(error)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [externalDirectory, fixtureDirectory, commit, bridge]);

  useEffect(() => {
    if (environment !== 'bot') return;
    let disposed = false;
    void bridge.getOAuthLoginState().then(login => { if (!disposed && login?.phase === 'login') setView({ kind: 'add' }); }).catch(() => {});
    return () => { disposed = true; };
  }, [bridge, environment]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  useEffect(() => {
    onViewChange?.(view.kind);
  }, [view.kind, onViewChange]);

  /** 即时保存：串行队列（规避主进程并发保存竞态）＋乐观更新，失败回滚并提示。 */
  const mutate = useCallback<Mutate>(
    (optimistic, action) => {
      if (external) return Promise.resolve('当前 Bot 尚不支持修改已有供应商。');
      const run = async (): Promise<string | null> => {
        const snapshot = directoryRef.current;
        if (!snapshot) return '模型配置还没读出来';
        const next = optimistic ? optimistic(snapshot) : snapshot;
        if (optimistic) commit(next);
        setSaveState('saving');
        setSaveError(null);
        try {
          await action(next);
          await reload().catch(() => undefined);
          setSaveState('saved');
          if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
          savedTimer.current = window.setTimeout(() => setSaveState('idle'), 2000);
          return null;
        } catch (error) {
          commit(snapshot);
          await reload().catch(() => undefined);
          const message = errorText(error);
          setSaveState('idle');
          setSaveError(`没保存上：${message}`);
          return message;
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result.catch(() => undefined);
      return result;
    },
    [external, commit, reload],
  );

  const saveProvider = useCallback(async (input: SaveInput) => {
    if (external) throw new Error('当前 Bot 尚不支持修改已有供应商。');
    const result = await bridge.saveModelProfile(input);
    if (!result?.ok) throw new Error('主进程没有确认保存');
    return { providerId: result.providerId, modelKeys: result.modelKeys ?? [] };
  }, [external, bridge]);

  const setStatus = useCallback((providerId: string, status: ProviderStatus) => {
    probeCache.set(providerId, status);
    setStatuses((prev) => ({ ...prev, [providerId]: status }));
  }, [probeCache]);
  const clearStatus = useCallback((providerId: string) => {
    probeCache.delete(providerId);
    setStatuses(prev => { const next = { ...prev }; delete next[providerId]; return next; });
  }, [probeCache]);

  const testProvider = useCallback(
    async (provider: ModelProviderView) => {
      const first = provider.models[0];
      if (external || !first || !bridge?.testModelProfile) return;
      setStatus(provider.id, { state: 'testing' });
      try {
        const keyless = !provider.hasApiKey && isLocalEndpoint(provider.baseUrl);
        const result = await bridge.testModelProfile({
          modelKey: first.modelKey,
          ...(keyless ? { apiKey: KEYLESS_PLACEHOLDER_KEY } : {}),
        });
        setStatus(provider.id, result.ok ? { state: 'ok', latencyMs: result.latencyMs } : { state: 'fail', error: testError(result) });
      } catch (error) {
        setStatus(provider.id, { state: 'fail', error: errorText(error) });
      }
    },
    [external, setStatus, bridge],
  );

  // 进页面自动测一遍（每个供应商每个会话一次）：「连不上的会在这里直接标出来」。
  useEffect(() => {
    if (readOnly || external || !directory || fixtureDirectory || directory.corrupt) return;
    for (const provider of directory.providers) {
      if (provider.oauthProvider || probeCache.has(provider.id) || provider.models.length === 0) continue;
      if (!provider.hasApiKey && !isLocalEndpoint(provider.baseUrl)) continue;
      void testProvider(provider);
    }
  }, [external, directory, fixtureDirectory, testProvider, readOnly, probeCache]);

  const navigate = useCallback((next: ModelView, direction: 'forward' | 'back') => {
    const doc = document as ViewTransitionDocument;
    const apply = (anim: 'forward' | 'back' | null) => {
      setView(next);
      setSaveError(null);
      setPane((prev) => ({ key: prev.key + 1, anim }));
    };
    if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
      document.documentElement.dataset.h37mVt = direction;
      const transition = doc.startViewTransition(() => {
        flushSync(() => apply(null));
        scrollParentToTop(rootRef.current);
      });
      void transition.finished.finally(() => {
        delete document.documentElement.dataset.h37mVt;
      });
    } else {
      apply(direction);
      window.requestAnimationFrame(() => scrollParentToTop(rootRef.current));
    }
  }, []);

  const back = useCallback(() => navigate({ kind: 'overview' }, 'back'), [navigate]);
  useEffect(() => {
    if (openAddRequest) navigate({ kind: 'add' }, 'forward');
  }, [openAddRequest, navigate]);

  const flash = useCallback((providerId: string) => {
    setFlashId(providerId);
    window.setTimeout(() => setFlashId((current) => (current === providerId ? null : current)), 1600);
  }, []);

  const guardEnter = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 外层是设置页 <form>：输入框回车不能触发整页提交（各输入自己处理回车）。
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') event.preventDefault();
  };

  const provider = view.kind === 'provider' ? directory?.providers.find((item) => item.id === view.id) : undefined;
  const activeView: ModelView['kind'] = view.kind === 'provider' && !provider ? 'overview' : view.kind;

  const controller: Controller | null = directory
    ? { directory, readOnly, external, addDisabled, saveState, statuses, mutate, saveProvider, testProvider, setStatus, clearStatus, reload, back,
      bridge, environment, botInstanceId, onSyncLocal, actions }
    : null;

  let body: ReactNode;
  if (!controller) {
    body = loadError ? (
      <div className="h37-note" data-tone="danger" role="alert">
        {loadError}
      </div>
    ) : slowLoading ? (
      <div className="h37-group" aria-busy="true" aria-label="正在读取模型配置">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h37-row">
            <span className="h37-tile" />
            <span className="h37-row-text">
              <span className="h37-skeleton" style={{ width: `${46 - index * 8}%` }} />
            </span>
          </div>
        ))}
      </div>
    ) : null;
  } else if (activeView === 'provider' && provider) {
    body = <ProviderView key={provider.id} ctl={controller} provider={provider} />;
  } else if (activeView === 'add') {
    body = (
      <AddProviderScreen
        ctl={controller}
        initial={initialFixture?.add ?? null}
        onAdded={(providerId) => {
          navigate({ kind: 'overview' }, 'back');
          flash(providerId);
        }}
      />
    );
  } else {
    body = (
      <OverviewView
        ctl={controller}
        flashId={flashId}
        onOpen={(id) => navigate({ kind: 'provider', id }, 'forward')}
        onAdd={external ? onAddProvider ?? (() => {}) : () => navigate({ kind: 'add' }, 'forward')}
      />
    );
  }

  return (
    <div ref={rootRef} className="h37m" data-h37-model-view={activeView} onKeyDown={guardEnter}>
      {directory?.corrupt ? (
        <div className="h37-note h37m-note" data-tone="danger" role="alert">
          配置目录损坏：下面是只读视图。修复方式——删除 userData 里的 text-model-profiles.json 后重启（会从旧配置重新迁移）。
        </div>
      ) : null}
      {directory?.envOverride ? (
        <div className="h37-note h37m-note" data-tone="warn">
          环境变量（HEMI_LLM_*）正在覆盖模型配置：实际生效以环境为准，这里的选择暂时不生效。
        </div>
      ) : null}
      {saveError ? (
        <div className="h37-note h37m-note" data-tone="danger" role="alert">
          {saveError}
        </div>
      ) : null}
      <div
        key={pane.key}
        className={`h37m-pane${pane.anim === 'forward' ? ' h37-drill' : pane.anim === 'back' ? ' h37m-drill-back' : ''}`}
      >
        {body}
      </div>
    </div>
  );
}

/**
 * 056：模型路由卡（看图与供应商之间；2026-10-14 用户裁决——普通模型配置与自动路由是
 * 两个功能）。这里只放一行摘要＋「配置…」，具体在 ModelRoutingDialog 弹窗里配（对话模型菜单
 * 的自动路由旁也能打开同一个弹窗）。
 */
function RoleModelsSection({ ctl }: { ctl: Controller }) {
  const { directory, readOnly } = ctl;
  const bridge = ctl.bridge ?? window.hemiVoice;
  const [view, setView] = useState<RoleModelsView | null>(() => fixtureState?.roleModels ?? null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    if (fixtureState?.roleModels) return;
    void bridge?.getRoleModels?.().then((next) => {
      if (next) setView(next);
    }).catch(() => {});
  }, [bridge]);
  useEffect(() => { refresh(); }, [directory, refresh]);

  const modelName = (modelKey: string | null) => {
    if (!modelKey) return null;
    for (const provider of directory.providers) {
      const model = provider.models.find((entry) => entry.modelKey === modelKey);
      if (model) return model.model;
    }
    return '（型号已不存在）';
  };
  const main = modelName(view?.slots.main.modelKey ?? null);
  const broken = view ? !view.ready && Boolean(view.slots.main.modelKey) : false;
  const summary = broken ? '角色模型已失效，请重新配置'
    : view?.ready ? '按角色选择模型；主 agent 可直接执行' : '';

  return (
    <section className="h37-section" data-role-models="true">
      <div className="h37-section-head">
        <h3>模型路由</h3>
      </div>
      <div className="h37-group">
        <div className="h37-row">
          <span className="h37-row-text">
            <b>{view?.ready ? `主 agent ${main}` : '未配置'}</b>
            {summary ? <span className={broken ? 'h56-role-warn' : 'h56-route-summary'}>{summary}</span> : null}
          </span>
          <span className="h37-row-end">
            <button type="button" className="h37-btn h37-btn-secondary" disabled={readOnly} onClick={() => setOpen(true)}>
              配置…
            </button>
          </span>
        </div>
      </div>
      {open ? (
        <ModelRoutingDialog
          api={bridge}
          onClose={() => {
            setOpen(false);
            refresh();
            void ctl.reload();
          }}
        />
      ) : null}
    </section>
  );
}

function OverviewView({
  ctl,
  flashId,
  onOpen,
  onAdd,
}: {
  ctl: Controller;
  flashId: string | null;
  onOpen: (providerId: string) => void;
  onAdd: () => void;
}) {
  const { directory, readOnly, mutate, statuses } = ctl;
  // 056（2026-10-14 用户裁决）：「正在使用」只剩看图模型——对话模型在输入区选（具体模型或
  // 自动路由），思考强度在输入区拨；看图模型单独配置（目录的 visionModelKey），不再挂在
  // 某个模型条目上。
  const visionKey = directory.visionModelKey ?? null;
  const setVision = (value: string) => {
    const next = value === VISION_OFF ? null : value;
    if (next === visionKey) return;
    void mutate(
      (dir) => ({ ...dir, visionModelKey: next }),
      async () => {
        const result = await (ctl.bridge ?? window.hemiVoice).setVisionModel(next);
        if (!result?.ok) throw new Error('主进程没有确认看图模型');
      },
    );
  };
  const visionPicked = visionKey ? findModelRef(directory, visionKey) : null;
  const quota = useSubscriptionQuota(directory.providers, { bridge: ctl.bridge ?? window.hemiVoice, external: ctl.external, environment: ctl.environment });

  return (
    <>
      {!ctl.external && ctl.environment !== 'bot' && directory.providers.length ? (
        <section className="h37-section">
          <div className="h37-section-head">
            <h3>看图</h3>
            <span className="h37-aside">
              <SaveIndicator state={ctl.saveState} />
            </span>
          </div>
          <div className="h37-group">
            <div className="h37-row h37m-use-row">
              <span className="h37-row-text">
                <b>看图模型</b>
                {visionKey && !visionPicked ? <span className="h56-role-warn">选的模型已不存在，请重选</span> : null}
              </span>
              <span className="h37-row-end">
                <Pick
                  label="看图模型"
                  value={visionPicked ? visionKey! : VISION_OFF}
                  display={visionPicked?.model.model ?? '不看图'}
                  sub={visionPicked?.provider.name}
                  disabled={readOnly}
                  onChange={setVision}
                >
                  <option value={VISION_OFF}>不看图</option>
                  {directory.providers.map((provider) => (
                    <optgroup key={provider.id} label={provider.name}>
                      {provider.models.map((model) => (
                        <option key={model.modelKey} value={model.modelKey} disabled={!provider.hasApiKey}>
                          {model.model}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Pick>
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {/* 056：模型路由摘要卡（看图之后、供应商之前；配置在弹窗里）。 */}
      {!ctl.external ? <RoleModelsSection ctl={ctl} /> : null}

      <section className="h37-section">
        <div className="h37-section-head">
          <h3>供应商</h3>
          <span className="h37-count">{directory.providers.length}</span>
          <span className="h37-aside h37m-provider-actions">
            {ctl.actions}
            <button type="button" className="h37-btn h37-btn-secondary" disabled={ctl.external ? ctl.addDisabled : readOnly} onClick={onAdd}>
              <Plus aria-hidden />
              添加供应商
            </button>
          </span>
        </div>
        <div className={directory.providers.length ? undefined : 'h37-group'}>
          {directory.providers.length === 0 ? (
            <div className="h37-row">
              <span className="h37-row-text">
                <b>还没有供应商</b>
              </span>
              <span className="h37-row-end">
                <button type="button" className="h37-btn h37-btn-primary" disabled={ctl.external ? ctl.addDisabled : readOnly} onClick={onAdd}>
                  添加供应商
                </button>
              </span>
            </div>
          ) : null}
        </div>
      </section>
      {groupModelProviders(directory.providers, ctl.environment === 'bot' || ctl.external).map(category => <section className="h37-section" key={category.id} aria-label={category.label}>
        <div className="h37-section-head"><h3>{category.label}</h3><span className="h37-count">{category.providers.length}</span>
          {category.id === 'subscription' && quota.enabled ? <SubscriptionQuotaRefresh entries={Object.values(quota.byProviderId)} loading={quota.loading} onRefresh={quota.refresh} /> : null}
        </div>
        <div className="h37-group">
          {!category.providers.length ? <div className="h37-row"><span className="h37-row-desc">{category.id === 'local' ? '还没有从本机同步的模型' : category.id === 'api' ? '暂无 API 配置' : category.id === 'newapi' ? '暂无 New API 站点' : '暂无订阅账号'}</span></div> : null}
          {category.providers.map((provider) => {
            const host = hostOf(provider.baseUrl);
            // 只有可查询的订阅（openai / bigmodel、本机、已登录）才挂额度，其余行保持原样。
            const hasQuota = category.id === 'subscription' && quota.targetIds.has(provider.id);
            const quotaEntry = hasQuota ? quota.byProviderId[provider.id] : undefined;
            return (
              <button
                key={provider.id}
                type="button"
                className={`h37-row h37m-provider-row${flashId === provider.id ? ' h37-enter h37-flash' : ''}`}
                onClick={() => onOpen(provider.id)}
              >
                <span className="h37-tile" aria-hidden>
                  {providerTile(provider.name, provider.baseUrl)}
                </span>
                <span className="h37-row-text">
                  <b>{provider.name}</b>
                  <span className="h37m-models-inline">
                    {host ? <span className="h37m-mono h37m-hide-sm">{host} · </span> : null}
                    {provider.models.length ? provider.models.map((model) => model.model).join('、') : '还没有型号'}
                  </span>
                </span>
                <span className="h37-row-end">
                  {hasQuota ? <SubscriptionQuota entry={quotaEntry} name={provider.name} /> : null}
                  {!ctl.external ? <StatusBadge status={statuses[provider.id]} provider={provider} /> : null}
                  <ChevronRight className="h37-chev" aria-hidden />
                </span>
              </button>
            );
          })}
        </div>
      </section>)}
    </>
  );
}

function ProviderView({ ctl, provider }: { ctl: Controller; provider: ModelProviderView }) {
  const { directory, readOnly, mutate, saveProvider } = ctl;
  const bridge = ctl.bridge ?? window.hemiVoice;
  const status = ctl.statuses[provider.id];
  const [nameDraft, setNameDraft] = useState(provider.name);
  const [urlDraft, setUrlDraft] = useState(provider.baseUrl);
  const [keyDraft, setKeyDraft] = useState('');
  const [fieldError, setFieldError] = useState<{ name?: string; baseUrl?: string; key?: string }>({});
  const [newModel, setNewModel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  const loadRemoteModels = useCallback(
    () => bridge.listRemoteModels({ providerId: provider.id }),
    [provider.id, provider.baseUrl, provider.hasApiKey, provider.oauthProvider, keyRevision, bridge],
  );
  const canFetchModels = !ctl.external && !readOnly && Boolean(provider.hasApiKey || isLocalEndpoint(provider.baseUrl));
  const remote = useRemoteModels(canFetchModels ? loadRemoteModels : null);
  const [modelTests, setModelTests] = useState<Record<string, ProviderStatus>>({});
  const [flashModel, setFlashModel] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => setNameDraft(provider.name), [provider.name]);
  useEffect(() => setUrlDraft(provider.baseUrl), [provider.baseUrl]);

  const saveWhole = (next: ModelProfilesDirectory, apiKey?: string) => {
    const updated = next.providers.find((item) => item.id === provider.id);
    return updated ? saveProvider(providerSaveInput(updated, { apiKey })) : Promise.resolve(null);
  };

  const commitConnection = async (patch: { name?: string; baseUrl?: string; apiKey?: string; api?: ModelProviderView['api'] }) => {
    const apply = (item: ModelProviderView): ModelProviderView => ({
      ...item,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}),
      ...(patch.api ? { api: patch.api } : {}),
      ...(patch.apiKey ? { hasApiKey: true } : {}),
    });
    const error = await mutate(
      (dir) => patchProvider(dir, provider.id, apply),
      async (next) => {
        await saveWhole(next, patch.apiKey);
      },
    );
    if (error) return error;
    if (patch.apiKey) setKeyRevision(value => value + 1);
    // 连接变了就重新测（名字/协议变不用测——协议只影响请求方言，不影响连通性）。
    if (patch.baseUrl !== undefined || patch.apiKey) void ctl.testProvider(apply(provider));
    return null;
  };

  const commitApi = async (value: string) => {
    const next = value === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    if (next === provider.api) return;
    await commitConnection({ api: next });
  };

  const commitName = async () => {
    const value = nameDraft.trim();
    if (value === provider.name) return;
    if (!value) {
      setFieldError((prev) => ({ ...prev, name: '先给这个供应商起个名字。' }));
      setNameDraft(provider.name);
      return;
    }
    setFieldError((prev) => ({ ...prev, name: undefined }));
    const error = await commitConnection({ name: value });
    if (error) setFieldError((prev) => ({ ...prev, name: error }));
  };

  const commitUrl = async () => {
    const value = urlDraft.trim();
    if (value === provider.baseUrl) return;
    if (!value) {
      setFieldError((prev) => ({ ...prev, baseUrl: '端点要填（Key 可以留空沿用已存的）。' }));
      setUrlDraft(provider.baseUrl);
      return;
    }
    setFieldError((prev) => ({ ...prev, baseUrl: undefined }));
    const error = await commitConnection({ baseUrl: value });
    if (error) setFieldError((prev) => ({ ...prev, baseUrl: error }));
  };

  const commitKey = async () => {
    const value = keyDraft.trim();
    if (!value) {
      keyRef.current?.focus();
      return;
    }
    setFieldError((prev) => ({ ...prev, key: undefined }));
    const error = await commitConnection({ apiKey: value });
    if (error) setFieldError((prev) => ({ ...prev, key: error }));
    else setKeyDraft('');
  };

  const onFieldKey = (commit: () => void) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  };

  const testModel = async (model: string, modelKey: string) => {
    setModelTests((prev) => ({ ...prev, [model]: { state: 'testing' } }));
    try {
      const keyless = !provider.hasApiKey && isLocalEndpoint(provider.baseUrl);
      const result = await bridge.testModelProfile({
        modelKey,
        model,
        ...(keyless ? { apiKey: KEYLESS_PLACEHOLDER_KEY } : {}),
      });
      setModelTests((prev) => ({
        ...prev,
        [model]: result.ok ? { state: 'ok', latencyMs: result.latencyMs } : { state: 'fail', error: testError(result) },
      }));
    } catch (error) {
      setModelTests((prev) => ({ ...prev, [model]: { state: 'fail', error: errorText(error) } }));
    }
  };

  const addModel = async (raw: string) => {
    const name = raw.trim();
    if (!name) {
      setAddError('先填型号 ID。');
      return;
    }
    if (provider.models.some((model) => model.model === name)) {
      setAddError(`「${name}」已经在列表里了。`);
      return;
    }
    const probeKey = provider.models[0]?.modelKey;
    const draft = draftModelEntry(provider.id, name, guessVision(name));
    setNewModel('');
    setAddError(null);
    const error = await mutate(
      (dir) => patchProvider(dir, provider.id, (item) => ({ ...item, models: [...item.models, draft] })),
      async (next) => {
        await saveWhole(next);
      },
    );
    if (error) {
      setNewModel(name);
      setAddError(error);
      return;
    }
    setFlashModel(name);
    window.setTimeout(() => setFlashModel((value) => (value === name ? null : value)), 1600);
    if (probeKey) void testModel(name, probeKey);
  };

  // 被改模型可能在别的供应商（跨供应商设为看图模型时改的是主脑模型条目），
  // 保存落到它所在的供应商，而不是本视图的供应商。
  const patchAndSave = (modelKey: string, patch: Partial<ModelEntryView>) =>
    void mutate(
      (dir) => patchModel(dir, modelKey, patch),
      async (next) => {
        const owner = next.providers.find((item) => item.models.some((model) => model.modelKey === modelKey));
        if (owner) await saveProvider(providerSaveInput(owner));
      },
    );

  const removeModel = (modelKey: string) =>
    void mutate(
      (dir) =>
        patchProvider(dir, provider.id, (item) => ({
          ...item,
          models: item.models.filter((model) => model.modelKey !== modelKey),
        })),
      async (next) => {
        await saveWhole(next);
      },
    );

  const usedCount = provider.models.filter((model) => modelUsage(directory, model)).length;
  const onlyProvider = directory.providers.length <= 1;
  const setVisionHere = (modelKey: string) =>
    void mutate(
      (dir) => ({ ...dir, visionModelKey: modelKey }),
      async () => {
        const result = await bridge.setVisionModel(modelKey);
        if (!result?.ok) throw new Error('主进程没有确认看图模型');
      },
    );

  const menuFor = (model: ModelEntryView, usage: 'vision' | null): MenuEntry[] => {
    // 056：看图模型单独配置（目录的 visionModelKey），这里是「正在使用」下拉之外的快捷入口。
    const entries: MenuEntry[] = [];
    if (ctl.environment !== 'bot' && model.supportsVision && usage !== 'vision') {
      entries.push({ kind: 'item', label: '设为看图模型', onSelect: () => setVisionHere(model.modelKey) });
    }
    entries.push(
      { kind: 'item', label: '测试这个型号', onSelect: () => void testModel(model.model, model.modelKey) },
      {
        kind: 'item',
        label: '删除这个型号',
        danger: true,
        disabled: Boolean(usage) || provider.models.length <= 1,
        title: usage
          ? '正在当看图模型用，先在页面顶部的「看图」里换掉'
          : provider.models.length <= 1
            ? '至少配一个模型（填型号 ID）。'
            : undefined,
        onSelect: () => removeModel(model.modelKey),
      },
    );
    return entries;
  };

  return (
    <>
      <button type="button" className="h37-back" onClick={ctl.back}>
        <ArrowLeft aria-hidden />
        模型
      </button>
      <div className="h37-page-head h37m-head">
        <span className="h37-tile h37m-tile-lg" aria-hidden>
          {providerTile(provider.name, provider.baseUrl)}
        </span>
        <div className="h37m-head-text">
          <h2>{provider.name}</h2>
          <p>
            {ctl.external ? '模型配置保存在云端' : <SaveIndicator state={ctl.saveState} idleText="修改后自动保存并重新测试" />}
          </p>
        </div>
        {!ctl.external ? <div className="h37-actions">
          <StatusBadge status={status} provider={provider} detail />
          <button
            type="button"
            className="h37-btn h37-btn-ghost"
            disabled={readOnly || status?.state === 'testing' || provider.models.length === 0}
            onClick={() => void ctl.testProvider(provider)}
          >
            重新测试
          </button>
        </div> : null}
      </div>
      {status?.state === 'fail' ? (
        <div className="h37-note h37m-note" data-tone="warn" role="status">
          连不上：{status.error}
        </div>
      ) : null}

      {ctl.external ? <section className="h37-section">
        <div className="h37-section-head"><h3>连接</h3></div>
        <div className="h37-group">
          {[
            ['名称', provider.name],
            ['接口地址', provider.baseUrl],
            ['接口协议', provider.api === 'anthropic-messages' ? 'Anthropic 原生（/v1/messages）' : 'OpenAI 兼容（chat/completions）'],
          ].map(([label, value]) => <div className="h37-row h37m-form-row" key={label}>
            <span className="h37m-lbl">{label}</span>
            <span className="h37-row-text break-all"><span>{value}</span></span>
          </div>)}
        </div>
      </section> : provider.oauthProvider ? <OAuthAccountSection api={bridge} target={ctl.environment} providers={directory.providers} onlyProvider={provider.oauthProvider} disabled={readOnly} onChanged={ctl.reload} onConnected={() => { ctl.setStatus(provider.id, { state: 'ok' }); }} /> : <section className="h37-section">
        <div className="h37-section-head">
          <h3>连接</h3>
        </div>
        <div className="h37-group">
          <div className="h37-row h37m-form-row">
            <label className="h37m-lbl" htmlFor="h37m-name">
              名称
            </label>
            <span className="h37m-field">
              <input
                id="h37m-name"
                className="h37-input"
                value={nameDraft}
                disabled={readOnly}
                aria-invalid={fieldError.name ? true : undefined}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => void commitName()}
                onKeyDown={onFieldKey(() => void commitName())}
              />
              {fieldError.name ? <span className="h37-error-text">{fieldError.name}</span> : null}
            </span>
          </div>
          <div className="h37-row h37m-form-row">
            <label className="h37m-lbl" htmlFor="h37m-key">
              API Key
            </label>
            <span className="h37m-field">
              <input
                id="h37m-key"
                ref={keyRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="h37-input h37m-mono"
                value={keyDraft}
                disabled={readOnly}
                placeholder={
                  provider.hasApiKey
                    ? `••••••••••••（已保存${provider.keyStoredSecurely ? '并已加密' : ''}，粘贴新 Key 可更换）`
                    : isLocalEndpoint(provider.baseUrl)
                      ? '本地服务不需要 Key'
                      : '粘贴 API Key'
                }
                aria-invalid={fieldError.key ? true : undefined}
                onChange={(event) => setKeyDraft(event.target.value)}
                onBlur={() => {
                  if (keyDraft.trim()) void commitKey();
                }}
                onKeyDown={onFieldKey(() => void commitKey())}
              />
              {fieldError.key ? <span className="h37-error-text">{fieldError.key}</span> : null}
            </span>
            <button type="button" className="h37-btn h37-btn-ghost" disabled={readOnly} onClick={() => void commitKey()}>
              {keyDraft.trim() ? '保存' : '更换'}
            </button>
          </div>
          <div className="h37-row h37m-form-row">
            <label className="h37m-lbl" htmlFor="h37m-url">
              接口地址
            </label>
            <span className="h37m-field">
              <input
                id="h37m-url"
                className="h37-input h37m-mono"
                value={urlDraft}
                disabled={readOnly}
                spellCheck={false}
                aria-invalid={fieldError.baseUrl ? true : undefined}
                onChange={(event) => setUrlDraft(event.target.value)}
                onBlur={() => void commitUrl()}
                onKeyDown={onFieldKey(() => void commitUrl())}
              />
              {fieldError.baseUrl ? <span className="h37-error-text">{fieldError.baseUrl}</span> : null}
            </span>
          </div>
          <div className="h37-row h37m-form-row">
            <label className="h37m-lbl" htmlFor="h37m-api">
              接口协议
            </label>
            <span className="h37m-field">
              <select
                id="h37m-api"
                className="h37-input"
                value={provider.api}
                disabled={readOnly}
                onChange={(event) => void commitApi(event.target.value)}
              >
                <option value="openai-completions">OpenAI 兼容（chat/completions）</option>
                <option value="anthropic-messages">Anthropic 原生（/v1/messages）</option>
              </select>
            </span>
          </div>
        </div>
      </section>}

      <section className="h37-section">
        <div className="h37-section-head">
          <h3>模型</h3>
          <span className="h37-count">{provider.models.length}</span>
        </div>
        <div className="h37-group">
          {provider.models.map((model) => {
            const usage = modelUsage(directory, model);
            return (
              <div
                key={model.modelKey}
                className={`h37-row h37m-model-row${flashModel === model.model ? ' h37-enter h37-flash' : ''}`}
              >
                <span className="h37-row-text">
                  <b className="h37m-mono h37m-model-name">{model.model}</b>
                  <ModelSub test={modelTests[model.model]} />
                </span>
                <span className="h37-row-end">
                  {ctl.external ? <>
                    {model.supportsVision ? <span className="h37-badge">能看图</span> : null}
                    {directory.defaultModelId === model.modelKey ? <span className="h37-badge" data-tone="ok">默认</span> : null}
                  </> : <>
                  {/* 041：模型本身的普通配置直接放行内——能看图即改即存（正在当看图模型用时锁住）。 */}
                  <span className="h37m-vision-toggle">
                    <span className="h37m-vision-lbl">能看图</span>
                    <button
                      type="button"
                      role="switch"
                      className="h37-switch"
                      aria-checked={model.supportsVision}
                      aria-label={`${model.model} 能看图`}
                      disabled={readOnly || (usage === 'vision' && model.supportsVision)}
                      title={
                        usage === 'vision' && model.supportsVision
                          ? '正在当看图模型用，先在页面顶部的「看图」里换掉'
                          : undefined
                      }
                      onClick={() => patchAndSave(model.modelKey, { supportsVision: !model.supportsVision })}
                    />
                  </span>
                  {usage ? (
                    <span className="h37-badge" data-tone="ok">
                      看图模型
                    </span>
                  ) : null}
                  <MoreMenu label={`${model.model} 的更多操作`} entries={menuFor(model, usage)} disabled={readOnly} />
                  </>}
                </span>
              </div>
            );
          })}
          {!ctl.external ? (
            <div className="h37m-model-browser">
              <div className="h37m-fetch">
                <span className="h37m-fetch-copy" role="status" aria-live="polite">
                  <b>从服务获取型号</b>
                  <span>{remote.busy ? '正在拉取可用模型…' : remote.models
                    ? `共 ${remote.models.length} 个型号，点击添加。`
                    : canFetchModels ? '可刷新模型列表，也可手动添加。' : '保存 API Key 后自动获取模型列表。'}</span>
                </span>
                <button
                  type="button"
                  className="h37-btn h37-btn-secondary"
                  disabled={!canFetchModels || remote.busy}
                  onClick={remote.refresh}
                >
                  {remote.busy ? <span className="h37-spinner" aria-hidden /> : null}
                  {remote.busy ? '拉取中…' : '刷新列表'}
                </button>
              </div>
              {remote.error ? <div className="h37-error-text" role="alert">{remote.error}</div> : null}
              {remote.models?.length ? (
                <div className="h37m-fetch-list" aria-label="服务可用型号">
                  {remote.models.map((id) => {
                    const added = provider.models.some((model) => model.model === id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className="h37-chip h37m-chip-sm"
                        title={id}
                        disabled={readOnly || ctl.saveState === 'saving' || added}
                        onClick={() => void addModel(id)}
                      >
                        {added ? <Check aria-hidden /> : <Plus aria-hidden />}
                        <span className="h37m-mono">{id}</span>
                        {added ? <span className="h37-tag h37m-chip-tag">已添加</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="h37m-add-row">
                <input
                  className="h37-input h37m-mono"
                  value={newModel}
                  placeholder="手动输入型号 ID，回车添加"
                  aria-label="新型号 ID"
                  spellCheck={false}
                  disabled={readOnly}
                  aria-invalid={addError ? true : undefined}
                  onChange={(event) => { setNewModel(event.target.value); setAddError(null); }}
                  onKeyDown={onFieldKey(() => void addModel(newModel))}
                />
                <button
                  type="button"
                  className="h37-btn h37-btn-secondary"
                  disabled={readOnly || ctl.saveState === 'saving' || !newModel.trim()}
                  onClick={() => void addModel(newModel)}
                >添加</button>
              </div>
              {addError ? <div className="h37-error-text" role="alert">{addError}</div> : null}
            </div>
          ) : null}
        </div>
        <div className="h37-section-foot">
          {ctl.external ? '在 Bot 对话中切换要使用的模型。' : ctl.environment === 'bot' ? '添加时自动测试这个型号能不能用；「能看图」在行内直接改。' : '添加时自动测试这个型号能不能用；「能看图」在行内直接改，看图模型在页面顶部的「看图」里换。'}
        </div>
      </section>

      {!ctl.external ? <section className="h37-section">
        <div className="h37-group">
          <div className="h37-row">
            <span className="h37-row-text">
              <b>删除这个供应商</b>
              <span>
                {onlyProvider
                  ? '至少保留一个供应商'
                  : usedCount
                    ? '它的模型正在当看图模型用，删除前先在「看图」里换一个'
                    : '连同它的型号和已存的 Key 一起删除'}
              </span>
            </span>
            <span className="h37-row-end">
              <button
                type="button"
                className="h37-btn h37-btn-danger"
                disabled={readOnly || onlyProvider}
                onClick={() => setDeleteOpen(true)}
              >
                删除
              </button>
            </span>
          </div>
        </div>
      </section> : null}

      {deleteOpen ? (
        <DeleteProviderDialog
          provider={provider}
          directory={directory}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async (replacementModelId) => {
            const error = await mutate(null, async () => {
              const result = await bridge.removeModelProfile({ providerId: provider.id, replacementModelId });
              if (!result?.ok) throw new Error('主进程没有确认删除');
            });
            if (error) return error;
            ctl.clearStatus(provider.id);
            setDeleteOpen(false);
            ctl.back();
            return null;
          }}
        />
      ) : null}
    </>
  );
}

function ModelSub({ test }: { test: ProviderStatus | undefined }) {
  const slow = useDelayed(test?.state === 'testing');
  // 模型列表只显示连接测试状态；请求的思考档位不是模型自身的属性。
  if (!test) return null;
  return (
    <span>
      {test.state === 'testing' && slow ? '测试中…' : null}
      {test?.state === 'ok' ? `可用${typeof test.latencyMs === 'number' ? ` ${test.latencyMs} ms` : ''}` : null}
      {test?.state === 'fail' ? <span className="h37m-sub-fail">不可用：{test.error}</span> : null}
    </span>
  );
}

/**
 * 047 添加页外框：统一入口先选配置方式（New API 站点登录 / 手动配置），
 * 两份草稿各自保留；站点方式已创建 Key 后锁定切换（先完成或取消）。
 */
export type ProviderSetupController = Omit<Controller, 'saveState' | 'statuses' | 'testProvider' | 'clearStatus'>;

export function AddProviderScreen({
  ctl,
  initial,
  onAdded,
  embedded = false,
  onBusyChange,
}: {
  ctl: ProviderSetupController;
  initial: FixtureState['add'] | null;
  onAdded: (providerId: string) => void;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [method, setMethod] = useState<'oauth' | 'newapi' | 'manual' | 'local'>(initial?.method ?? (fixtureState ? initial?.presetId ? 'manual' : 'newapi' : 'oauth'));
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const lockRef = useRef<ImportLock>({ locked: false, reason: '' });
  const [childBusy, setChildBusy] = useState(false);
  const reportBusy = useCallback((busy: boolean) => {
    setChildBusy(busy);
    onBusyChange?.(busy);
  }, [onBusyChange]);

  const choose = (next: 'oauth' | 'newapi' | 'manual' | 'local') => {
    if (next === method) return;
    if (childBusy) return;
    if (lockRef.current.locked) {
      setSwitchNote(lockRef.current.reason);
      return;
    }
    setSwitchNote(null);
    setMethod(next);
  };

  return (
    <>
      {embedded ? null : <><button
        type="button"
        className="h37-back"
        onClick={() => {
          if (childBusy) return;
          if (lockRef.current.locked) {
            setSwitchNote(lockRef.current.reason);
            return;
          }
          ctl.back();
        }}
      >
        <ArrowLeft aria-hidden />
        模型
      </button>
      <div className="h37-page-head">
        <div>
          <h2>添加供应商</h2>
          <p>选择订阅、New API 或 API 配置，添加可用模型。</p>
        </div>
      </div></>}

      <section className="h37-section">
        <ModelConnectionMethods bot={ctl.environment === 'bot'} value={method === 'oauth' ? 'subscription' : method === 'manual' ? 'api' : method} disabled={childBusy}
          onChange={value => choose(value === 'subscription' ? 'oauth' : value === 'newapi' ? 'newapi' : value === 'local' ? 'local' : 'manual')} />
        {switchNote ? (
          <div className="h37-note h37m-note-after" data-tone="warn" role="alert">
            {switchNote}
          </div>
        ) : null}
      </section>

      {method === 'oauth' ? <OAuthAccountSection api={ctl.bridge} target={ctl.environment} providers={ctl.directory.providers} disabled={ctl.readOnly} onChanged={ctl.reload} onConnected={onAdded} onBusyChange={reportBusy} /> : method === 'local' ? <section className="h37-section">
        <div className="h37-section-head"><h3>本机配置</h3></div><p className="h37-help">同步勾选的本机模型；订阅账号为 Bot 单独授权，自动路由在 Bot 中配置。</p>
        <button type="button" className="h37-btn h37-btn-secondary" disabled={ctl.readOnly} onClick={ctl.onSyncLocal}>从本机同步</button>
      </section> : method === 'manual' ? (
        <AddProviderView ctl={ctl} initial={initial} onAdded={onAdded} onBusyChange={reportBusy} embedded />
      ) : (
        <NewApiImportView
          destination={ctl.environment === 'bot' && ctl.botInstanceId ? { kind: 'bot', instanceId: ctl.botInstanceId } : undefined}
          onExit={ctl.back}
          onImported={(providerIds) => {
            void ctl.reload().catch(() => undefined);
            navigateFlash(providerIds);
          }}
          lockRef={lockRef}
          onBusyChange={reportBusy}
        />
      )}
    </>
  );

  function navigateFlash(providerIds: string[]) {
    onAdded(providerIds[0] ?? '');
  }
}

export type ManualProviderServices = Partial<Pick<HemiVoiceBridge, 'testModelProfile' | 'listRemoteModels'>>;

export function AddProviderView({
  ctl,
  initial,
  onAdded,
  embedded = false,
  onBusyChange,
  services,
  submitLabel,
}: {
  ctl: ProviderSetupController;
  initial: FixtureState['add'] | null;
  onAdded: (providerId: string) => void;
  /** 047：嵌入 AddProviderScreen 时由外框出返回/标题（方式选择页）。 */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
  services?: ManualProviderServices;
  submitLabel?: (count: number) => string;
}) {
  const { directory } = ctl;
  const formServices = services ?? ctl.bridge ?? window.hemiVoice;
  const existingNames = directory.providers.map((provider) => provider.name);
  const initialPreset = presetById(initial?.presetId);
  const [presetId, setPresetId] = useState<string | null>(initialPreset?.id ?? null);
  const [name, setName] = useState(initialPreset ? uniqueProviderName(initialPreset.name, existingNames) : '');
  const [baseUrl, setBaseUrl] = useState(initialPreset?.baseUrl ?? '');
  const [editingUrl, setEditingUrl] = useState(initialPreset?.id === 'custom');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [api, setApi] = useState<ModelProviderApi>('openai-completions');
  const [test, setTest] = useState<ProviderStatus | null>(initial?.status ?? null);
  const [extras, setExtras] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState('');
  const remoteUrl = baseUrl.trim();
  const remoteKey = apiKey.trim();
  const listRemoteModels = formServices.listRemoteModels;
  const canFetchModels = Boolean(listRemoteModels && remoteUrl && (remoteKey || isLocalEndpoint(remoteUrl)));
  const loadRemoteModels = useCallback(
    () => listRemoteModels!({ baseUrl: remoteUrl, apiKey: remoteKey }),
    [listRemoteModels, remoteUrl, remoteKey],
  );
  const remote = useRemoteModels(canFetchModels ? loadRemoteModels : null);
  const [error, setError] = useState<string | null>(null);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    onBusyChange?.(submitting || remote.busy);
    return () => onBusyChange?.(false);
  }, [submitting, remote.busy, onBusyChange]);
  const skipFirstTest = useRef(Boolean(initial?.status));
  const generation = useRef(0);
  const slowTest = useDelayed(test?.state === 'testing');
  const slowSubmit = useDelayed(submitting);

  const preset: ProviderPreset | null = presetById(presetId);
  const keyless = Boolean(preset?.keyless) || isLocalEndpoint(baseUrl);
  const allModels = [...new Set([...(remote.models ?? []), ...extras])];
  const ordered = allModels.filter((id) => picked.includes(id));
  const probeModel = ordered[0] ?? '';

  const choose = (next: ProviderPreset) => {
    setPresetId(next.id);
    setName(next.id === 'custom' ? '' : uniqueProviderName(next.name, existingNames));
    setBaseUrl(next.baseUrl);
    setEditingUrl(next.id === 'custom');
    setPicked([]);
    setExtras([]);
    setTest(null);
    setError(null);
    setLinkNote(null);
  };

  // 粘贴 Key（或换地址/首选型号）后防抖自动测试；>300ms 才出 spinner。
  useEffect(() => {
    if (!presetId) return;
    if (skipFirstTest.current) {
      skipFirstTest.current = false;
      return;
    }
    const key = apiKey.trim() || (keyless ? KEYLESS_PLACEHOLDER_KEY : '');
    const url = baseUrl.trim();
    const gen = ++generation.current;
    setTest(null);
    const testModel = formServices.testModelProfile;
    if (!key || !url || !probeModel || !testModel) return;
    const timer = window.setTimeout(() => {
      setTest({ state: 'testing' });
      testModel({ baseUrl: url, apiKey: key, model: probeModel, api })
        .then((result) => {
          if (gen !== generation.current) return;
          setTest(result.ok ? { state: 'ok', latencyMs: result.latencyMs } : { state: 'fail', error: testError(result) });
        })
        .catch((reason) => {
          if (gen === generation.current) setTest({ state: 'fail', error: errorText(reason) });
        });
    }, 600);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [presetId, apiKey, baseUrl, keyless, probeModel, api, formServices.testModelProfile]);

  const toggle = (id: string) => {
    setError(null);
    setPicked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const addOther = () => {
    const id = otherDraft.trim();
    if (!id) {
      setOtherOpen(false);
      return;
    }
    if (!allModels.includes(id)) setExtras((prev) => [...prev, id]);
    setPicked((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setOtherDraft('');
    setOtherOpen(false);
    setError(null);
  };

  const submit = async () => {
    if (!preset) return;
    const key = apiKey.trim();
    if (!name.trim()) return setError('先给这个供应商起个名字。');
    if (!baseUrl.trim()) return setError('接口地址要填。');
    if (!key && !keyless) return setError('先粘贴 API Key。');
    if (ordered.length === 0) return setError('至少配一个模型（填型号 ID）。');
    setError(null);
    setSubmitting(true);
    const models = ordered.map((id) => draftModelEntry('', id, guessVision(id)));
    const input: SaveInput = {
      ...providerSaveInput({ id: '', name, baseUrl, api, models }, { apiKey: key || KEYLESS_PLACEHOLDER_KEY }),
      id: undefined,
    };
    let providerId = '';
    const failure = await ctl.mutate(null, async () => {
      const result = await ctl.saveProvider(input);
      providerId = result.providerId;
    });
    setSubmitting(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (providerId && test?.state === 'ok') ctl.setStatus(providerId, test);
    onAdded(providerId);
  };

  return (
    <>
      {embedded ? null : (
        <>
          <button type="button" className="h37-back" onClick={ctl.back}>
            <ArrowLeft aria-hidden />
            模型
          </button>
          <div className="h37-page-head">
            <div>
              <h2>添加供应商</h2>
              <p>选一家，接口地址自动填好；粘贴 Key 后获取型号，勾选后自动测试。</p>
            </div>
          </div>
        </>
      )}

      <section className="h37-section">
        <div className="h37-section-head">
          <h3>1 · 选择供应商</h3>
        </div>
        <div className="h37m-preset-grid" role="radiogroup" aria-label="选择供应商">
          {PROVIDER_PRESETS.map((item) => {
            const on = item.id === presetId;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={on}
                className="h37m-preset"
                onClick={() => {
                  if (!on) choose(item);
                }}
              >
                <span className="h37-tile h37m-tile-sm" data-tone={on ? 'g' : undefined} aria-hidden>
                  {item.tile}
                </span>
                <span className="h37m-preset-text">
                  <b>{item.name}</b>
                  <span>{item.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {preset ? (
        <div key={preset.id} className="h37-enter h37m-steps">
          <section className="h37-section">
            <div className="h37-section-head">
              <h3>2 · {keyless ? '确认接口' : '粘贴 API Key'}</h3>
              {preset.keyUrl ? (
                <span className="h37-aside">
                  <button
                    type="button"
                    className="h37-link"
                    onClick={() => void openKeyPage(preset.keyUrl).then(setLinkNote)}
                  >
                    去{preset.keySite}获取
                    <ExternalLink className="h37m-ext" aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
            <div className="h37-group">
              <div className="h37-row h37m-form-row">
                <label className="h37m-lbl" htmlFor="h37m-add-api">接口协议</label>
                <span className="h37m-field">
                  <select id="h37m-add-api" className="h37-input" value={api} onChange={(event) => setApi(event.target.value as ModelProviderApi)}>
                    <option value="openai-completions">OpenAI 兼容</option>
                    <option value="anthropic-messages">Anthropic 原生</option>
                  </select>
                </span>
              </div>
              {preset.id === 'custom' ? (
                <div className="h37-row h37m-form-row">
                  <label className="h37m-lbl" htmlFor="h37m-add-name">
                    名称
                  </label>
                  <span className="h37m-field">
                    <input
                      id="h37m-add-name"
                      className="h37-input"
                      value={name}
                      placeholder="比如：公司网关"
                      onChange={(event) => setName(event.target.value)}
                    />
                  </span>
                </div>
              ) : null}
              <div className="h37-row h37m-form-row">
                <label className="h37m-lbl" htmlFor="h37m-add-key">
                  API Key
                </label>
                <span className="h37m-field">
                  <input
                    id="h37m-add-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="h37-input h37m-mono"
                    value={apiKey}
                    placeholder={keyless ? '本地服务不需要 Key（可留空）' : listRemoteModels ? '粘贴后自动获取模型列表' : '粘贴 API Key'}
                    autoFocus={!initial}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setError(null);
                    }}
                  />
                </span>
                <span className="h37m-test-slot" aria-live="polite">
                  {test?.state === 'testing' && slowTest ? (
                    <span className="h37-badge">
                      <span className="h37-spinner" aria-hidden />
                      测试中
                    </span>
                  ) : null}
                  {test?.state === 'ok' ? (
                    <span className="h37-badge" data-tone="ok">
                      连接成功
                    </span>
                  ) : null}
                  {test?.state === 'fail' ? (
                    <span className="h37-badge" data-tone="warn">
                      连不上
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="h37-row h37m-form-row">
                <label className="h37m-lbl" htmlFor="h37m-add-url">
                  接口地址
                </label>
                {editingUrl ? (
                  <span className="h37m-field">
                    <input
                      id="h37m-add-url"
                      className="h37-input h37m-mono"
                      value={baseUrl}
                      spellCheck={false}
                      placeholder="https://…/v1"
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </span>
                ) : (
                  <>
                    <span className="h37-row-text">
                      <span className="h37m-mono h37m-url" id="h37m-add-url">
                        {baseUrl.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    <button type="button" className="h37-btn h37-btn-ghost" onClick={() => setEditingUrl(true)}>
                      修改
                    </button>
                  </>
                )}
              </div>
            </div>
            {test?.state === 'fail' ? (
              <div className="h37-note h37m-note-after" data-tone="danger" role="alert">
                {test.error}
              </div>
            ) : null}
            {linkNote ? <div className="h37-section-foot">{linkNote}</div> : null}
          </section>

          <section className="h37-section">
            <div className="h37-section-head h37m-catalog-head">
              <h3>3 · 勾选要用的型号</h3>
              <span className="h37-actions">
                {formServices.listRemoteModels ? <button
                  type="button"
                  className="h37-btn h37-btn-secondary h37-btn-sm"
                  disabled={!canFetchModels || remote.busy || submitting}
                  onClick={remote.refresh}
                >
                  {remote.busy ? '拉取中…' : '刷新列表'}
                </button> : null}
                <span className="h37-count">已选 {ordered.length}</span>
              </span>
            </div>
            {remote.error ? (
              <div className="h37m-add-error h37-error-text" role="alert">
                {remote.error}
              </div>
            ) : null}
            <div className="h37m-chips">
              {allModels.map((id) => {
                const on = picked.includes(id);
                return (
                  <button key={id} type="button" className="h37-chip" title={id} aria-pressed={on} onClick={() => toggle(id)}>
                    {on ? <Check aria-hidden /> : null}
                    <span className="h37m-mono">{id}</span>
                    {guessVision(id) ? <span className="h37-tag h37m-chip-tag">看图</span> : null}
                  </button>
                );
              })}
              {otherOpen ? (
                <input
                  className="h37-input h37m-mono h37m-other-input"
                  value={otherDraft}
                  placeholder="型号 ID，回车加入"
                  aria-label="其他型号 ID"
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => setOtherDraft(event.target.value)}
                  onBlur={addOther}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addOther();
                    } else if (event.key === 'Escape') {
                      setOtherDraft('');
                      setOtherOpen(false);
                    }
                  }}
                />
              ) : (
                <button type="button" className="h37-chip h37m-chip-ghost" onClick={() => setOtherOpen(true)}>
                  <Plus aria-hidden />
                  其他型号
                </button>
              )}
            </div>
            <div className="h37-section-foot">
              {remote.busy ? '正在从服务获取可用型号…' : remote.models
                ? `已获取 ${remote.models.length} 个型号，勾选后自动测试连接。`
                : canFetchModels ? '可刷新列表，也可手动添加型号。' : '填好接口地址和 API Key 后自动获取型号，也可手动添加。'}
            </div>
          </section>

          {error ? (
            <div className="h37-note h37m-note-after" data-tone="danger" role="alert">
              {error}
            </div>
          ) : null}
          <div className="h37m-add-foot">
            <button type="button" className="h37-btn h37-btn-ghost" disabled={submitting} onClick={ctl.back}>
              取消
            </button>
            <button
              type="button"
              className="h37-btn h37-btn-primary"
              disabled={submitting || ordered.length === 0 || ctl.readOnly}
              onClick={() => void submit()}
            >
              {slowSubmit ? <span className="h37-spinner" aria-hidden /> : null}
              {submitLabel ? submitLabel(ordered.length) : `添加 ${ordered.length} 个模型`}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
