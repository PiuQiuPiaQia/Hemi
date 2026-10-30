import {useCallback, useEffect, useState, type ReactNode} from 'react';
import type {BotHostCapabilities, BotMethod, BotState} from '@shared/bot';

/**
 * Bot 能力设置（capabilities.inspect / capabilities.configure）。
 * 2026-10-30 与 PC 设置六分类对齐后拆为三处：操作能力与技能入口（电脑与浏览器页）、
 * 联网检索（联网搜索页）、浏览器决策模型（模型与路由页）。三者共享同一读写通道，
 * 各自挂载时独立 inspect，保存只提交本区块字段。
 *
 * 读取门：inspect 成功前（离线 / 读取中 / 读取失败）所有控件禁用，表单不预填，
 * 避免用空值或默认值覆盖 Bot 主机上的真实配置；状态行说明原因并提供重试。
 */
type LoadPhase = 'offline' | 'loading' | 'ready' | 'error';

function useBotCapabilities(state: BotState) {
  const instanceId = state.binding?.instanceId;
  const [value, setValue] = useState<BotHostCapabilities | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const command = useCallback(<T,>(method: BotMethod, params: Record<string, unknown> = {}) =>
    window.hemiVoice.bot.command<T>(method, {...params, expectedInstanceId: instanceId}), [instanceId]);
  useEffect(() => {
    if (!state.online) return;
    let active = true;
    setLoadError('');
    void command<BotHostCapabilities>('capabilities.inspect').then(next => {
      if (!active) return; setValue(next); setLoadError('');
    }).catch(cause => {if (active) setLoadError(cause instanceof Error ? cause.message : '无法读取 Bot 能力。');});
    return () => {active = false;};
  }, [command, state.online, attempt]);
  const phase: LoadPhase = !state.online ? 'offline' : value ? 'ready' : loadError ? 'error' : 'loading';
  // 只有在线且已读到真实配置时才允许写入。
  const writable = phase === 'ready' && !busy;
  const save = async (config: Record<string, unknown>) => {
    if (!writable) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await command<BotHostCapabilities>('capabilities.configure', {config});
      setValue(previous => (previous ? {...previous, ...next} : next));
      setNotice('已保存，新任务生效。');
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {value, phase, loadError, error, notice, busy, writable, save, retry: () => setAttempt(n => n + 1)};
}

/** 读取门状态行：放在分组第一行，说明控件为何不可用。ready 时不渲染。 */
function LoadStatusRow({phase, loadError, retry}: {phase: LoadPhase; loadError: string; retry: () => void}) {
  if (phase === 'ready') return null;
  const text = phase === 'offline' ? '连接已断开。重新连接后才能读取和修改这些设置。'
    : phase === 'loading' ? '正在读取 Bot 主机上的配置…'
    : `读取失败：${loadError}`;
  return <div className="h37-row h37-bot-settings-row" role={phase === 'error' ? 'alert' : 'status'}>
    <span className="h37-row-text"><span className={phase === 'error' ? 'h37-error-text' : undefined}>{text}</span></span>
    {phase === 'error' ? <span className="h37-row-end"><button type="button" className="h37-btn h37-btn-secondary h37-btn-sm" onClick={retry}>重试</button></span> : null}
  </div>;
}

function CapabilityFootnotes({notice, error}: {notice: string; error: string}) {
  return <>
    {notice ? <p className="h37-section-foot h37-settings-foot-ok" role="status">{notice}</p> : null}
    {error ? <p className="h-bot-error" role="alert">{error}</p> : null}
  </>;
}

const switchButton = (checked: boolean, disabled: boolean, label: string, onClick: () => void) =>
  <button type="button" role="switch" className="h37-switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onClick}/>;

function Row({title, description, children}: {title: ReactNode; description?: ReactNode; children?: ReactNode}) {
  return <div className="h37-row h37-bot-settings-row">
    <span className="h37-row-text"><b>{title}</b>{description ? <span>{description}</span> : null}</span>
    {children ? <span className="h37-row-end">{children}</span> : null}
  </div>;
}

const DEFAULT_DECISION_MODEL = 'typesafe-ai/jev';

/** 电脑与浏览器页：浏览器控制（含快速决策开关与决策模型跳转）与 Windows 桌面控制。
 *  技能中心自 2026-10-30 起为 Bot 设置独立分类，不再放在本页。 */
export function BotControlCapabilities({state, onConfigureDecision}: {
  state: BotState;
  /** 跳到「模型与路由 → 浏览器决策模型」并展开（与 PC 浏览器页一致）。 */
  onConfigureDecision?: () => void;
}) {
  const {value, phase, loadError, error, notice, writable, save, retry} = useBotCapabilities(state);
  const disabled = !writable;
  const decisionModel = value?.browserActModel?.trim() || DEFAULT_DECISION_MODEL;
  return <section className="h37-section" id="settings-browser" aria-label="Bot 操作能力">
    <div className="h37-section-head"><h3>操作能力</h3></div>
    <div className="h37-group">
      <LoadStatusRow phase={phase} loadError={loadError} retry={retry}/>
      <Row title="浏览器控制" description={value?.browserEnabled && value.browser?.error
        ? <span className="h37-error-text">{value.browser.error}</span>
        : '在 Bot 主机浏览网页；扩展未连接时使用独立浏览器。'}>
        {switchButton(Boolean(value?.browserEnabled), disabled, '启用 Bot 浏览器控制', () => void save({browserEnabled: !value?.browserEnabled}))}
      </Row>
      {value?.browserEnabled ? <>
        <Row title="快速决策（Jev）" description={value.hasBrowserActKey
          ? `简单的页面操作一步完成，失败时自动回退逐步操作。页面文字会发给 ${value.browserActUrl || 'Jev 服务端'}。`
          : '尚未配置决策模型，浏览器任务仍可用逐步操作。'}>
          {switchButton(Boolean(value.browserActEnabled), disabled, '启用 Bot 浏览器快速决策', () => void save({browserActEnabled: !value.browserActEnabled}))}
        </Row>
        <Row title="决策模型" description={value.hasBrowserActKey ? decisionModel : '未配置'}>
          {onConfigureDecision ? <button type="button" className="h37-link" onClick={onConfigureDecision}>配置决策模型 →</button> : null}
        </Row>
      </> : null}
      {value?.computerUseSupported ? <Row title="Windows 桌面控制" description={value.desktop?.available ? value.desktop.note || '桌面助手已连接。应用操作仍按应用授权。' : value.desktop?.reason || '需要 Windows 用户已登录并解锁桌面。'}>
        {switchButton(Boolean(value.computerUseEnabled), disabled, '启用 Bot Windows 桌面控制', () => void save({computerUseEnabled: !value.computerUseEnabled}))}
      </Row> : null}
    </div>
    <CapabilityFootnotes notice={notice} error={error}/>
  </section>;
}

/** 联网搜索页：Bot 自己的检索开关与 Tavily Key（结构同 PC 联网搜索页）。 */
export function BotWebSearchSettings({state}: {state: BotState}) {
  const {value, phase, loadError, error, notice, writable, save, retry} = useBotCapabilities(state);
  const [searchKey, setSearchKey] = useState('');
  const disabled = !writable;
  const hasKey = Boolean(value?.hasSearchKey);
  return <section className="h37-section" aria-label="Bot 联网检索">
    <div className="h37-group">
      <LoadStatusRow phase={phase} loadError={loadError} retry={retry}/>
      <Row title="允许联网搜索" description="搜索与网页正文提取使用 Bot 主机自己的 Tavily 配置。">
        {switchButton(Boolean(value?.webSearchEnabled), disabled, '启用 Bot 联网检索', () => void save({webSearchEnabled: !value?.webSearchEnabled}))}
      </Row>
      {value?.webSearchEnabled ? <form className="h37-settings-form h37-enter" onSubmit={event => {event.preventDefault(); if (!searchKey.trim()) return; void save({searchApiKey: searchKey.trim()}).then(ok => {if (ok) setSearchKey('');});}}>
        <div className="h37-field">
          <label htmlFor="bot-web-search-key">
            Tavily Key
            <span className="h37-badge h37-settings-label-badge" data-tone={hasKey ? 'ok' : 'warn'}>{hasKey ? '已配好' : '未配置'}</span>
          </label>
          <div className="h37-settings-inline">
            <input id="bot-web-search-key" className="h37-input" type="password" autoComplete="new-password" aria-label="Bot Tavily API Key"
              placeholder={hasKey ? '输入新 Key 可覆盖' : '粘贴 tvly- 开头的 Key'} value={searchKey} disabled={disabled} onChange={event => setSearchKey(event.target.value)}/>
            <button type="submit" className="h37-btn h37-btn-primary" disabled={disabled || !searchKey.trim()}>保存</button>
          </div>
          {hasKey ? null : <p className="h37-help">配好后 Bot 的新任务才能联网。</p>}
        </div>
      </form> : null}
    </div>
    <CapabilityFootnotes notice={notice} error={error}/>
  </section>;
}

/**
 * 模型与路由页：Bot 的浏览器决策模型（Jev）。与 PC 一致默认收起为一行摘要，
 * 「配置」展开地址/型号/Key；启用开关在电脑与浏览器页。远端写入用显式保存，
 * 草稿只在读到真实配置后预填一次。
 */
export function BotBrowserDecisionSettings({state, open, onToggle, onBack}: {
  state: BotState;
  open: boolean;
  onToggle: () => void;
  /** 「返回浏览器控制」（与 PC 双向定位一致）。 */
  onBack?: () => void;
}) {
  const {value, phase, loadError, error, notice, writable, save, retry} = useBotCapabilities(state);
  const [decisionKey, setDecisionKey] = useState('');
  const [decisionUrl, setDecisionUrl] = useState('');
  const [decisionModel, setDecisionModel] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (value && !loaded) {setDecisionUrl(value.browserActUrl); setDecisionModel(value.browserActModel); setLoaded(true);}
  }, [value, loaded]);
  const disabled = !writable || !loaded;
  const dirty = loaded && value != null && (decisionUrl.trim() !== value.browserActUrl || decisionModel.trim() !== value.browserActModel || Boolean(decisionKey.trim()));
  const summary = value?.browserActModel?.trim() || DEFAULT_DECISION_MODEL;
  return <section className="h37-section" id="settings-browser-decision" aria-label="Bot 浏览器决策模型">
    <div className="h37-section-head">
      <h3>浏览器决策模型（Jev）</h3>
      {value ? <span className="h37-aside"><span className="h37-badge" data-tone={value.hasBrowserActKey ? 'ok' : 'warn'}>{value.hasBrowserActKey ? '已配置' : '未配置'}</span></span> : null}
    </div>
    <div className="h37-group">
      <LoadStatusRow phase={phase} loadError={loadError} retry={retry}/>
      <div className="h37-row h37-bot-settings-row">
        <span className="h37-row-text"><b className="h37-settings-mono">{value ? summary : '—'}</b></span>
        <span className="h37-row-end">
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" aria-expanded={open} aria-controls="bot-browser-decision-form" onClick={onToggle}>{open ? '收起' : '配置'}</button>
        </span>
      </div>
      {open ? <form id="bot-browser-decision-form" className="h37-settings-form h37-enter" onSubmit={event => {
        event.preventDefault();
        if (disabled || !decisionUrl.trim() || !decisionModel.trim()) return;
        void save({browserActUrl: decisionUrl.trim(), browserActModel: decisionModel.trim(), ...(decisionKey.trim() ? {browserActApiKey: decisionKey.trim()} : {})}).then(ok => {
          if (!ok) return;
          setDecisionKey('');
        });
      }}>
        <div className="h37-fields">
          <label className="h37-field">
            <span className="h37-field-label">服务地址</span>
            <input className="h37-input" aria-label="Bot 浏览器决策接口地址" type="url" placeholder="https://api.typesafe.ai" value={decisionUrl} disabled={disabled} onChange={event => setDecisionUrl(event.target.value)}/>
          </label>
          <label className="h37-field">
            <span className="h37-field-label">模型 ID</span>
            <input className="h37-input" aria-label="Bot 浏览器决策模型型号" placeholder={DEFAULT_DECISION_MODEL} value={decisionModel} disabled={disabled} onChange={event => setDecisionModel(event.target.value)}/>
          </label>
          <label className="h37-field h37-full">
            <span className="h37-field-label">API Key{value?.hasBrowserActKey ? '（已配置）' : ''}</span>
            <input className="h37-input" aria-label="Bot 浏览器决策 API Key" type="password" autoComplete="new-password"
              placeholder={value?.hasBrowserActKey ? '留空保留当前 Key；输入新值可更换' : '粘贴 Key'} value={decisionKey} disabled={disabled} onChange={event => setDecisionKey(event.target.value)}/>
          </label>
        </div>
        <div className="h37-settings-actions">
          <span className="h37-help">配置保存在 Bot 主机上，页面文字将发送给该服务。</span>
          <span className="h37-settings-actions-end">
            <button type="submit" className="h37-btn h37-btn-primary h37-btn-sm" disabled={disabled || !dirty || !decisionUrl.trim() || !decisionModel.trim()}>保存决策模型</button>
          </span>
        </div>
        {onBack ? <p className="h37-help">
          <button type="button" className="h37-link" onClick={onBack}>← 返回浏览器控制</button>
          保存模型配置不会开启浏览器控制。
        </p> : null}
      </form> : null}
    </div>
    <CapabilityFootnotes notice={notice} error={error}/>
  </section>;
}
