import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Check, ExternalLink, Globe, Hand, Lock, RefreshCw, Search } from 'lucide-react';
import type {
  ModelProviderApi,
  ProviderImportPendingItem,
  ProviderImportState,
} from '@/shared/types';

/**
 * 047 New API 站点登录导入（渲染层控制面板）。
 *
 * 数据流：全部状态来自主进程协调器的安全 DTO（无 Key/账号凭据）；命令只带
 * operationId＋revision。站点页面由主进程 WebContentsView 直接叠在占位 div 上
 * （ResizeObserver＋scroll 上报 DIP bounds，窄窗/离开时隐藏，不重建会话）。
 * 两种添加方式各自保留草稿；本次导入已创建 Key 后（can.back=false）锁定方式
 * 切换，先完成或取消。
 */

const API_LABELS: Record<string, string> = {
  'openai-completions': 'OpenAI 兼容',
  'anthropic-messages': 'Anthropic 原生',
};

const VALIDATION_CODE_LABELS: Record<string, string> = {
  'not-visible': '这个 Key 看不到它（分组/限制不符）',
  auth: 'Key 没被接受',
  'endpoint-missing': '地址上没有对应接口',
  'shape-mismatch': '响应不像这个协议',
  'rate-limited': '站点限流',
  'server-error': '站点出错',
  timeout: '超时',
  network: '连不上',
};

const AUTOMATION_STEPS: Array<{ phase: string; label: string }> = [
  { phase: 'preflight', label: '创建前检查' },
  { phase: 'creating', label: '创建 Key' },
  { phase: 'reconciling', label: '核对令牌' },
  { phase: 'reading-key', label: '读取 Key' },
  { phase: 'validating', label: '验证模型' },
  { phase: 'saving', label: '保存配置' },
];

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim() || '未知错误';
}

let importFixtureState: ProviderImportState | null = null;

/** fixtures 专用：注入假导入状态（不经 IPC；场景渲染时读取一次）。 */
export function setProviderImportFixtureState(state: ProviderImportState | null): void {
  importFixtureState = state;
}

export type ImportLock = { locked: boolean; reason: string };

export function NewApiImportView({
  onExit,
  onImported,
  lockRef,
  fixtureState,
  onBusyChange,
}: {
  /** 回供应商列表（未创建 Key 时＝离开；已创建时按钮隐藏，只能完成/取消）。 */
  onExit: () => void;
  /** 导入成功后刷新目录并高亮。 */
  onImported: (providerIds: string[]) => void;
  /** 父层读它决定能否切换配置方式（R-23：创建后先处理本次令牌）。 */
  lockRef: { current: ImportLock };
  /** fixtures 注入的假状态（不经 IPC）。 */
  fixtureState?: ProviderImportState | null;
  /** 首启等外层导航不能在创建令牌/保存过程中离开。 */
  onBusyChange?: (busy: boolean) => void;
}) {
  const bridge = window.hemiVoice;
  const [initialFixtureOp] = useState<ProviderImportState | null>(() => fixtureState ?? importFixtureState ?? null);
  const [urlScheme, setUrlScheme] = useState<'https' | 'http'>('https');
  const [urlDraft, setUrlDraft] = useState('');
  const [op, setOp] = useState<ProviderImportState | null>(initialFixtureOp);
  const [pending, setPending] = useState<ProviderImportPendingItem[]>([]);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy || Boolean(op && !op.can.back));
    return () => onBusyChange?.(false);
  }, [busy, op, onBusyChange]);
  const [group, setGroup] = useState('');
  const [picked, setPicked] = useState<Record<string, ModelProviderApi>>({});
  const [modelQuery, setModelQuery] = useState('');
  const [budgetMode, setBudgetMode] = useState<'unlimited' | 'usd'>('unlimited');
  const [budgetUsd, setBudgetUsd] = useState('10');
  const [expiryMode, setExpiryMode] = useState<'never' | 'days'>('never');
  const [expiryDays, setExpiryDays] = useState('30');
  const browserRef = useRef<HTMLDivElement>(null);
  const layoutGen = useRef(0);
  const opRef = useRef<ProviderImportState | null>(op);
  opRef.current = op;

  useEffect(() => {
    lockRef.current = op
      ? {
        locked: !op.can.back,
        reason: op.can.back
          ? ''
          : '这次导入已经创建了 Key，先完成或取消，才能切换配置方式。',
      }
      : { locked: false, reason: '' };
  }, [op, lockRef]);

  /** 接回未完成操作时，把主进程的选择回填成本地草稿（切走再回来能接着选）。 */
  const adoptState = useCallback((state: ProviderImportState) => {
    setOp(state);
    if (state.selection) {
      setGroup(state.selection.group);
      setPicked(Object.fromEntries(state.selection.models.map((model) => [model.modelName, model.api])));
      setBudgetMode(state.selection.budgetMode);
      if (state.selection.budgetUsd != null) setBudgetUsd(String(state.selection.budgetUsd));
      setExpiryMode(state.selection.expiryMode);
      if (state.selection.expiryDays != null) setExpiryDays(String(state.selection.expiryDays));
    }
  }, []);

  useEffect(() => {
    if (initialFixtureOp) return;
    void bridge?.listPendingProviderImports?.().then((result) => setPending(result?.pending ?? [])).catch(() => undefined);
    void bridge?.getProviderImportState?.().then((result) => {
      const state = result?.state;
      // 已结束的操作不收养（成功/已取消/待清理没有可继续的动作，再显示就是旧数据，
      // 还会锁死方式切换——重新开始即可；未完成的才接回来续办）。
      if (!state || ['success', 'cancelled', 'cleanup-pending'].includes(state.phase)) return;
      adoptState(state);
    }).catch(() => undefined);
    const unsubscribe = bridge?.onProviderImportState?.((state) => {
      setOp(state);
    });
    return () => unsubscribe?.();
  }, [bridge, initialFixtureOp, adoptState]);

  // 占位 div 的 DIP bounds → 主进程裁剪应用（scroll 捕获设置页内部滚动）。
  const reportViewport = useCallback(
    (visible: boolean) => {
      const current = opRef.current;
      if (!current) return;
      if (!visible) {
        // 卸载清理时占位 div 可能已被 React 置空/摘除（ref 先于 effect 清理归零）：
        // 隐藏不依赖 bounds，兜底按 operationId 直接发，否则站点页悬浮在窗口上。
        layoutGen.current += 1;
        void bridge?.setProviderImportViewport?.({
          operationId: current.operationId,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false,
          layoutGeneration: layoutGen.current,
        }).catch(() => undefined);
        return;
      }
      const el = browserRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      layoutGen.current += 1;
      void bridge?.setProviderImportViewport?.({
        operationId: current.operationId,
        bounds: {
          x: Math.max(0, Math.round(rect.left)),
          y: Math.max(0, Math.round(rect.top)),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        },
        visible,
        layoutGeneration: layoutGen.current,
      }).catch(() => undefined);
    },
    [bridge],
  );

  const browserWanted = useMemo(() => {
    if (!op) return false;
    return !['success', 'cancelled', 'cleanup-pending'].includes(op.phase);
  }, [op]);

  const containerWide = useContainerWide(browserRef, browserWanted);

  useEffect(() => {
    if (!op || initialFixtureOp) return;
    const el = browserRef.current;
    if (!el) return;
    const report = () => reportViewport(browserWanted && containerWide);
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      reportViewport(false);
    };
  }, [op?.operationId, op?.revision, browserWanted, containerWide, reportViewport, op]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setCmdError(null);
    try {
      await action();
    } catch (error) {
      setCmdError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = () => run(async () => {
    const result = await bridge?.startProviderImport?.({ siteUrl: `${urlScheme}://${urlDraft.trim().replace(/^\/+/, '')}` });
    if (result?.state) setOp(result.state);
  });

  const checkLogin = () => op && run(async () => {
    const result = await bridge?.checkProviderImportLogin?.({ operationId: op.operationId, revision: op.revision });
    if (result?.state) setOp(result.state);
    if (result && result.ok === false && result.message) setCmdError(result.message);
  });

  /** 当前草稿 → 主进程白名单校验＋预览（分组一变就同步出候选；提交时再终同步一次）。 */
  const syncSelection = useCallback(async (state: ProviderImportState) => {
    if (!group) return null;
    const models = Object.entries(picked).map(([modelName, api]) => ({ modelName, api }));
    const selection = {
      group,
      budgetMode,
      ...(budgetMode === 'usd' ? { budgetUsd: Number(budgetUsd) } : {}),
      expiryMode,
      ...(expiryMode === 'days' ? { expiryDays: Number(expiryDays) } : {}),
      models,
      firstDefaultModelKey: null as string | null,
    };
    const result = await bridge?.setProviderImportSelection?.({
      operationId: state.operationId,
      revision: state.revision,
      selection,
    });
    if (result?.state) setOp(result.state);
    return result ?? null;
  }, [bridge, picked, group, budgetMode, budgetUsd, expiryMode, expiryDays]);

  // 选择一变就把草稿同步给主进程（防抖）：分组选定即回候选列表，勾选后出预览。
  const lastSyncRef = useRef('');
  useEffect(() => {
    if (!op || initialFixtureOp || op.phase !== 'selecting' || busy) return;
    const models = Object.entries(picked).map(([modelName, api]) => `${modelName}:${api}`);
    const fingerprint = JSON.stringify([group, budgetMode, budgetUsd, expiryMode, expiryDays, models]);
    if (!group || fingerprint === lastSyncRef.current) return;
    const timer = window.setTimeout(() => {
      lastSyncRef.current = fingerprint;
      void syncSelection(op).catch(() => {
        // 状态被推着走（STALE_REVISION 等）：重取一次权威状态，下轮变更会再同步。
        void bridge?.getProviderImportState?.(op.operationId).then((result) => {
          if (result?.state) setOp(result.state);
        }).catch(() => undefined);
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [op, initialFixtureOp, busy, picked, group, budgetMode, budgetUsd, expiryMode, expiryDays, syncSelection]);

  const submit = () => {
    const state = op;
    const models = Object.entries(picked).map(([modelName, api]) => ({ modelName, api }));
    if (!models.length) {
      setCmdError('至少选一个模型。');
      return;
    }
    if (!group) {
      setCmdError('先选择分组。');
      return;
    }
    run(async () => {
      // 终同步一次（防抖窗口内的最后一下），再按回执的 revision/planHash 提交。
      const synced = state ? await syncSelection(state).catch(() => null) : null;
      const latest: ProviderImportState | null = synced?.state ?? state;
      if (!latest?.preview) {
        setCmdError('先把选择同步成预览（稍等一下再点）。');
        return;
      }
      const result = await bridge?.submitProviderImport?.({
        operationId: latest.operationId,
        revision: latest.revision,
        planHash: latest.preview.planHash,
      });
      if (result?.state) setOp(result.state);
    });
  };

  const retry = () => op && run(async () => {
    const result = await bridge?.retryProviderImport?.({ operationId: op.operationId, revision: op.revision });
    if (result?.state) setOp(result.state);
  });

  const pause = () => op && run(async () => {
    const result = await bridge?.pauseProviderImport?.({ operationId: op.operationId, revision: op.revision });
    if (result?.state) setOp(result.state);
  });

  const resume = () => op && run(async () => {
    const result = await bridge?.resumeProviderImport?.({ operationId: op.operationId, revision: op.revision });
    if (result?.state) setOp(result.state);
  });

  const cancel = () => op && run(async () => {
    const result = await bridge?.cancelProviderImport?.({ operationId: op.operationId, revision: op.revision });
    if (result?.state) setOp(result.state);
  });

  const resumePending = (operationId: string) => run(async () => {
    const result = await bridge?.resumePendingProviderImport?.(operationId);
    if (result?.settled === 'already-committed') {
      setPending((prev) => prev.filter((item) => item.operationId !== operationId));
      setCmdError('上次的导入其实已经保存成功，记录已清理。');
      return;
    }
    const state = result?.state as ProviderImportState | undefined;
    if (state) setOp(state);
    setPending((prev) => prev.filter((item) => item.operationId !== operationId));
  });

  const finish = () => {
    const providerIds = op?.result?.providerIds ?? [];
    setOp(null);
    onImported(providerIds);
  };

  const candidates = op?.candidates ?? [];
  const filtered = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return query ? candidates.filter((item) => item.modelName.toLowerCase().includes(query)) : candidates;
  }, [candidates, modelQuery]);
  const pickedList = Object.entries(picked);
  const validation = op?.validation ?? null;

  return (
    <div className="h47n" data-phase={op?.phase ?? 'entry'}>
      {pending.length > 0 && !op ? (
        <section className="h37-section h47n-pending">
          <div className="h37-section-head">
            <h3>有未完成的导入</h3>
          </div>
          <div className="h37-group">
            {pending.map((item) => (
              <div key={item.operationId} className="h37-row">
                <span className="h37-row-text">
                  <b>{item.readable ? item.tokenName ?? item.siteOrigin ?? item.operationId : '无法解密的导入记录'}</b>
                  <span className="h37m-sub">
                    {item.readable
                      ? `${item.siteOrigin ?? ''} · ${item.phase}${item.apiKeyHeld ? ' · 已持有加密 Key' : ''}`
                      : '上次的导入记录在这台机器上解不开（钥匙串变了），保留现场不自动处理'}
                  </span>
                </span>
                <span className="h37-row-end">
                  {item.readable ? (
                    <button
                      type="button"
                      className="h37-btn h37-btn-secondary"
                      disabled={busy}
                      onClick={() => resumePending(item.operationId)}
                    >
                      继续处理
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!op ? (
        <section className="h37-section">
          <div className="h37-section-head">
            <h3>站点地址</h3>
          </div>
          <div className="h37-group">
            <div className="h37-row h37m-form-row">
              <label className="h37m-lbl" htmlFor="h47n-url">
                New API 站点
              </label>
              <span className="h37m-field h47n-url-field">
                <select
                  className="h37-input h47n-scheme"
                  aria-label="协议"
                  value={urlScheme}
                  onChange={(event) => setUrlScheme(event.target.value === 'http' ? 'http' : 'https')}
                >
                  <option value="https">https://</option>
                  <option value="http">http://</option>
                </select>
                <input
                  id="h47n-url"
                  className="h37-input h37m-mono"
                  value={urlDraft}
                  placeholder="比如 newapi.example.com"
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => {
                    // 粘贴完整地址时顺手续进下拉（协议跟地址走，输入框只留主机）。
                    const match = event.target.value.match(/^(https?):\/\//i);
                    if (match) {
                      setUrlScheme(match[1].toLowerCase() === 'http' ? 'http' : 'https');
                      setUrlDraft(event.target.value.slice(match[0].length));
                      return;
                    }
                    setUrlDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      start();
                    }
                  }}
                />
              </span>
            </div>
          </div>
          <div className="h37-section-foot">
            同一站点会保留登录状态；登录成功并继续后，账号密码加密保存在本机，过期时自动补齐。
            验证码和二次验证由你完成。地址按所选协议打开（http 是明文），页面路径不会当推理地址。
          </div>
          {cmdError ? (
            <div className="h37-note h37m-note-after" data-tone="danger" role="alert">
              {cmdError}
            </div>
          ) : null}
          <div className="h47n-foot">
            <button type="button" className="h37-btn h37-btn-ghost" onClick={onExit}>
              取消
            </button>
            <button type="button" className="h37-btn h37-btn-primary" disabled={busy || !urlDraft.trim()} onClick={start}>
              <Globe className="h47n-ico" aria-hidden />
              打开站点并登录
            </button>
          </div>
        </section>
      ) : (
        <div className="h47n-flow">
          <div className="h47n-browser-col">
            <div className="h47n-browser-head">
              <span className="h47m-origin h37m-mono">{op.siteOrigin.replace(/^https?:\/\//, '')}</span>
              <span className="h37-badge" data-tone={op.control === 'hemi' ? 'ok' : undefined}>
                {op.control === 'hemi' ? 'Hemi 正在操作' : op.control === 'paused' ? '已暂停，由你接手' : '由你操作'}
              </span>
            </div>
            <div
              ref={browserRef}
              className="h47n-browser"
              data-wide={containerWide ? 'true' : undefined}
              aria-label="站点页面（应用内浏览器）"
            >
              {containerWide ? null : (
                <span className="h47n-browser-note">
                  窗口太窄放不下站点页面：拉宽窗口后这里显示站点页面，控制不变。
                </span>
              )}
            </div>
          </div>

          <div className="h47n-panel">
            {op.resumeHint ? <div className="h37-note h47n-hint">{op.resumeHint}</div> : null}
            {op.loginMemoryError ? <div className="h37-note h47n-hint" data-tone="warn" role="alert">{op.loginMemoryError}</div> : null}

            {op.phase === 'login' ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>登录站点</h3>
                </div>
                <div className="h37-group">
                  <div className="h37-row">
                    <span className="h37-row-text">
                      <b>
                        <Hand className="h47n-ico" aria-hidden /> 在站点页面完成登录
                      </b>
                      <span className="h37m-sub">账号密码会加密记在本机，下次自动补齐；由你点击登录，验证码和二次验证仍由你完成。</span>
                    </span>
                  </div>
                  {op.accountLabel ? (
                    <div className="h37-row">
                      <span className="h37-row-text">
                        <b>{op.accountLabel}</b>
                        <span className="h37m-sub">已核验的账号（换账号要重新开始）</span>
                      </span>
                    </div>
                  ) : null}
                </div>
                {op.error ? (
                  <div className="h37-note h37m-note-after" data-tone="warn" role="alert">
                    {op.error.message}
                  </div>
                ) : null}
                {cmdError ? (
                  <div className="h37-note h37m-note-after" data-tone="danger" role="alert">
                    {cmdError}
                  </div>
                ) : null}
                <div className="h47n-foot">
                  <button type="button" className="h37-btn h37-btn-ghost" disabled={busy} onClick={cancel}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="h37-btn h37-btn-primary"
                    disabled={busy}
                    onClick={checkLogin}
                  >
                    我已登录，继续
                  </button>
                </div>
              </section>
            ) : null}

            {op.phase === 'selecting' ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>分组与 Key</h3>
                  <span className="h37-aside h37m-mono">{op.accountLabel}</span>
                </div>
                <div className="h37-group">
                  <div className="h37-row h37m-form-row">
                    <label className="h37m-lbl" htmlFor="h47n-group">
                      分组
                    </label>
                    <span className="h37m-field">
                      <select
                        id="h47n-group"
                        className="h37-input"
                        value={group}
                        onChange={(event) => {
                          setGroup(event.target.value);
                          setPicked({});
                        }}
                      >
                        <option value="">选择分组…</option>
                        {op.groups.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                            {item.desc ? ` · ${item.desc}` : ''}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
                  <div className="h37-row h37m-form-row">
                    <label className="h37m-lbl" htmlFor="h47n-budget">
                      额度上限
                    </label>
                    <span className="h37m-field h47n-inline">
                      <select
                        id="h47n-budget"
                        className="h37-input"
                        value={budgetMode}
                        onChange={(event) => setBudgetMode(event.target.value as 'unlimited' | 'usd')}
                      >
                        <option value="unlimited">不限（站点默认）</option>
                        <option value="usd">限额</option>
                      </select>
                      {budgetMode === 'usd' ? (
                        <>
                          <input
                            className="h37-input h37m-mono"
                            value={budgetUsd}
                            inputMode="decimal"
                            aria-label="额度（美元）"
                            onChange={(event) => setBudgetUsd(event.target.value)}
                          />
                          <span className="h37m-sub">美元</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="h37-row h37m-form-row">
                    <label className="h37m-lbl" htmlFor="h47n-expiry">
                      有效期
                    </label>
                    <span className="h37m-field h47n-inline">
                      <select
                        id="h47n-expiry"
                        className="h37-input"
                        value={expiryMode}
                        onChange={(event) => setExpiryMode(event.target.value as 'never' | 'days')}
                      >
                        <option value="never">永久（站点默认）</option>
                        <option value="days">限期</option>
                      </select>
                      {expiryMode === 'days' ? (
                        <>
                          <input
                            className="h37-input h37m-mono"
                            value={expiryDays}
                            inputMode="numeric"
                            aria-label="有效期（天）"
                            onChange={(event) => setExpiryDays(event.target.value)}
                          />
                          <span className="h37m-sub">天</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                </div>
                <div className="h37-section-foot">
                  Key 名称自动生成（{op.tokenName ? '' : '提交时'}Hemi-日期-随机），额度/期限就是这里确认的值。
                </div>
              </section>
            ) : null}

            {op.phase === 'selecting' && candidates.length > 0 ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>模型</h3>
                  <span className="h37-count">已选 {pickedList.length}</span>
                </div>
                <div className="h47n-search">
                  <Search className="h47n-ico" aria-hidden />
                  <input
                    className="h37-input h37m-mono"
                    value={modelQuery}
                    placeholder="搜型号…"
                    spellCheck={false}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                </div>
                <div className="h37m-chips">
                  {filtered.map((candidate) => {
                    const api = picked[candidate.modelName];
                    const on = Boolean(api);
                    const canPick = candidate.apis.length > 0;
                    return (
                      <button
                        key={candidate.modelName}
                        type="button"
                        className="h37-chip"
                        aria-pressed={on}
                        disabled={!canPick}
                        title={
                          canPick
                            ? candidate.apis.map((item) => API_LABELS[item] ?? item).join(' / ')
                            : `不支持的协议：${candidate.unsupported.join(' / ') || '未声明'}`
                        }
                        onClick={() => {
                          setPicked((prev) => {
                            const next = { ...prev };
                            if (next[candidate.modelName]) delete next[candidate.modelName];
                            else next[candidate.modelName] = candidate.apis[0];
                            return next;
                          });
                        }}
                      >
                        {on ? <Check aria-hidden /> : null}
                        <span className="h37m-mono">{candidate.modelName}</span>
                        {api ? <span className="h37-tag h37m-chip-tag">{API_LABELS[api] ?? api}</span> : null}
                        {!canPick ? <span className="h37-tag h37m-chip-tag">不支持</span> : null}
                      </button>
                    );
                  })}
                </div>
                <div className="h37-section-foot">
                  型号与协议来自站点声明（未验证）；提交时会用新 Key 逐个验证。同一模型有多种协议时先用默认项。
                </div>
              </section>
            ) : null}

            {op.phase === 'selecting' && op.preview && pickedList.length > 0 ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>将生成</h3>
                </div>
                <div className="h37-group">
                  {op.preview.providers.map((provider) => (
                    <div key={provider.name} className="h37-row">
                      <span className="h37-row-text">
                        <b>{provider.name}</b>
                        <span className="h37m-sub">
                          {API_LABELS[provider.api] ?? provider.api} · {provider.baseUrl.replace(/^https?:\/\//, '')} ·{' '}
                          {provider.models.length} 个模型
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="h37-section-foot">
                  {op.preview.providers.length > 1 ? '不同协议会拆成多条供应商配置，共用这次创建的 Key。' : null}
                  {group ? '推理地址默认用站点同域。' : ''}
                </div>
              </section>
            ) : null}

            {op.phase === 'selecting' ? (
              <section className="h37-section h47n-submit">
                <div className="h47n-submit-note">
                  点下去之后由 Hemi 接管：创建 Key → 核对令牌 → 读取 Key → 逐个验证模型 →
                  加密保存。中途可以暂停或取消；验证会消耗极少量模型用量。
                </div>
                {cmdError ? (
                  <div className="h37-note" data-tone="danger" role="alert">
                    {cmdError}
                  </div>
                ) : null}
                <div className="h47n-foot">
                  <button type="button" className="h37-btn h37-btn-ghost" disabled={busy} onClick={cancel}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="h37-btn h37-btn-primary"
                    disabled={busy || !group || pickedList.length === 0}
                    onClick={submit}
                  >
                    {busy ? <span className="h37-spinner" aria-hidden /> : null}
                    创建 Key 并导入（{pickedList.length} 个模型 → {op.preview?.providers.length ?? '…'} 条配置）
                  </button>
                </div>
              </section>
            ) : null}

            {['preflight', 'creating', 'reconciling', 'reading-key', 'validating', 'ready-to-save', 'saving'].includes(op.phase) ||
            op.control === 'hemi' ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>导入进度</h3>
                  {op.control === 'paused' ? <span className="h37-badge" data-tone="warn">已暂停</span> : null}
                </div>
                <div className="h47n-steps">
                  {AUTOMATION_STEPS.map((step) => {
                    const index = AUTOMATION_STEPS.findIndex((item) => item.phase === op.phase);
                    const current = AUTOMATION_STEPS.findIndex((item) => item.phase === step.phase);
                    const done = index > current || op.phase === 'success';
                    const active = index === current;
                    return (
                      <div key={step.phase} className="h47n-step" data-state={active ? 'active' : done ? 'done' : 'todo'}>
                        <span className="h47n-step-dot" aria-hidden />
                        <span>{step.label}</span>
                      </div>
                    );
                  })}
                </div>
                {validation && validation.length > 0 ? (
                  <div className="h47n-validation">
                    {validation.map((item) => (
                      <div key={`${item.modelName}:${item.api}`} className="h47n-vrow" data-ok={item.ok ? 'true' : 'false'}>
                        <span className="h37m-mono">{item.modelName}</span>
                        <span className="h37m-sub">
                          {API_LABELS[item.api] ?? item.api}
                          {item.ok ? '' : ` · ${VALIDATION_CODE_LABELS[item.code ?? ''] ?? '未通过'}`}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="h47n-foot">
                  {op.can.cancel ? (
                    <button type="button" className="h37-btn h37-btn-ghost" disabled={busy} onClick={cancel}>
                      取消
                    </button>
                  ) : null}
                  {op.control === 'paused' ? (
                    <button type="button" className="h37-btn h37-btn-primary" disabled={busy} onClick={resume}>
                      继续
                    </button>
                  ) : op.can.pause ? (
                    <button type="button" className="h37-btn h37-btn-secondary" disabled={busy} onClick={pause}>
                      暂停
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {op.phase === 'success' && op.result ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>已导入</h3>
                  <span className="h37-badge" data-tone="ok">
                    <Lock className="h47n-ico" aria-hidden /> Key 已加密保存
                  </span>
                </div>
                <div className="h37-group">
                  {op.result.providers.map((provider) => (
                    <div key={provider.id} className="h37-row">
                      <span className="h37-row-text">
                        <b>{provider.name}</b>
                        <span className="h37m-sub">
                          {API_LABELS[provider.api] ?? provider.api} · {provider.modelCount} 个模型
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="h37-section-foot">已有的默认模型和自动路由没有改动。</div>
                <div className="h47n-foot">
                  <button type="button" className="h37-btn h37-btn-primary" onClick={finish}>
                    完成
                  </button>
                </div>
              </section>
            ) : null}

            {op.phase === 'failed' ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>没完成</h3>
                </div>
                <div className="h37-note" data-tone={op.error?.code === 'VERIFY_FAILED' ? 'warn' : 'danger'} role="alert">
                  {op.error?.message ?? '导入过程出错'}
                  {op.error?.code === 'VERIFY_FAILED' ? '：没通过的型号见上；Key 已创建，重试不会新建。' : ''}
                </div>
                {validation && validation.some((item) => !item.ok) ? (
                  <div className="h47n-validation">
                    {validation.filter((item) => !item.ok).map((item) => (
                      <div key={`${item.modelName}:${item.api}`} className="h47n-vrow" data-ok="false">
                        <span className="h37m-mono">{item.modelName}</span>
                        <span className="h37m-sub">{VALIDATION_CODE_LABELS[item.code ?? ''] ?? '未通过'}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {cmdError ? (
                  <div className="h37-note h37m-note-after" data-tone="danger" role="alert">
                    {cmdError}
                  </div>
                ) : null}
                <div className="h47n-foot">
                  {op.can.cancel ? (
                    <button type="button" className="h37-btn h37-btn-ghost" disabled={busy} onClick={cancel}>
                      {op.error?.code === 'TOKEN_AMBIGUOUS'
                        ? '退出（同名令牌需到站点手动确认）'
                        : op.tokenName
                          ? '撤销这次 Key 并退出'
                          : '取消'}
                    </button>
                  ) : null}
                  {op.can.retry ? (
                    <button type="button" className="h37-btn h37-btn-primary" disabled={busy} onClick={retry}>
                      <RefreshCw className="h47n-ico" aria-hidden />
                      从断点重试
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {op.phase === 'cancelled' ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>已取消</h3>
                </div>
                <div className="h37-section-foot">
                  {op.tokenName ? '本次创建的 Key 已在站点撤销。' : '没有创建任何 Key。'}
                </div>
                <div className="h47n-foot">
                  <button type="button" className="h37-btn h37-btn-primary" onClick={onExit}>
                    完成
                  </button>
                </div>
              </section>
            ) : null}

            {op.phase === 'cleanup-pending' && op.cleanupPending ? (
              <section className="h37-section">
                <div className="h37-section-head">
                  <h3>有把钥匙没收回</h3>
                </div>
                <div className="h37-note" data-tone="warn" role="alert">
                  <AlertTriangle className="h47n-ico" aria-hidden />
                  没能撤销这次创建的 Key：到 {op.cleanupPending.siteOrigin.replace(/^https?:\/\//, '')} 的令牌管理里手动删除「
                  {op.cleanupPending.tokenName ?? 'Hemi-…'}」。这里不会假装已经清理。
                </div>
                <div className="h47n-foot">
                  <button
                    type="button"
                    className="h37-link"
                    onClick={() => void window.hemiVoice?.openExternal?.(op.cleanupPending!.siteOrigin)}
                  >
                    打开站点
                    <ExternalLink className="h37m-ext" aria-hidden />
                  </button>
                  <button type="button" className="h37-btn h37-btn-primary" onClick={onExit}>
                    完成
                  </button>
                </div>
              </section>
            ) : null}

            {cmdError && op.phase === 'selecting' ? (
              <div className="h37-note h37m-note-after" data-tone="danger" role="alert">
                {cmdError}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** 占位容器 ≥ 阈值才显示原生站点页面（窄窗隐藏，不重建会话）。 */
function useContainerWide(ref: RefObject<HTMLDivElement | null>, active: boolean, threshold = 480) {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? threshold;
      setWide(width >= threshold);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, active, threshold]);
  return wide;
}
