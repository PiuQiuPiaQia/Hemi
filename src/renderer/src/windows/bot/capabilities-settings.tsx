import {useCallback, useEffect, useState} from 'react';
import type {BotHostCapabilities, BotMethod, BotState} from '@shared/bot';

export function BotCapabilitiesSettings({state, onOpenSkills}: {state: BotState; onOpenSkills: () => void}) {
  const instanceId = state.binding?.instanceId;
  const [value, setValue] = useState<BotHostCapabilities | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchKey, setSearchKey] = useState('');
  const [decisionKey, setDecisionKey] = useState('');
  const [decisionUrl, setDecisionUrl] = useState('');
  const [decisionModel, setDecisionModel] = useState('');
  const [notice, setNotice] = useState('');
  const command = useCallback(<T,>(method: BotMethod, params: Record<string, unknown> = {}) =>
    window.hemiVoice.bot.command<T>(method, {...params, expectedInstanceId: instanceId}), [instanceId]);
  useEffect(() => {
    if (!state.online) return;
    let active = true;
    void command<BotHostCapabilities>('capabilities.inspect').then(next => {
      if (!active) return;setValue(next);setDecisionUrl(next.browserActUrl);setDecisionModel(next.browserActModel);setError('');
    }).catch(cause => {if (active) setError(cause instanceof Error ? cause.message : '无法读取 Bot 能力。');});
    return () => {active = false;};
  }, [command, state.online]);
  const save = async (config: Record<string, unknown>) => {
    if (busy) return;setBusy(true);setError('');setNotice('');
    try {
      const next = await command<BotHostCapabilities>('capabilities.configure', {config});
      setValue(previous => ({...previous, ...next}));if (Object.hasOwn(config, 'searchApiKey')) setSearchKey('');if (Object.hasOwn(config, 'browserActApiKey')) setDecisionKey('');setNotice('已保存，新任务生效。');
    } catch (cause) {setError(cause instanceof Error ? cause.message : '保存失败。');}
    finally {setBusy(false);}
  };

  const disabled = !state.online || busy;
  const toggle = (name: 'browserEnabled' | 'computerUseEnabled' | 'webSearchEnabled' | 'browserActEnabled', label: string) =>
    <button type="button" role="switch" className="h37-switch" aria-label={label} aria-checked={Boolean(value?.[name])} disabled={disabled || !value} onClick={() => void save({[name]: !value?.[name]})}/>;

  return <section className="h37-section" aria-label="Bot 能力">
    <div className="h37-section-head"><h3>Bot 能力</h3></div>
    <div className="h37-group">
      <div className="h37-row"><span className="h37-row-text"><b>浏览器控制</b><span>在 Bot 主机浏览网页；扩展未连接时使用独立浏览器。</span></span>{toggle('browserEnabled', '启用 Bot 浏览器控制')}</div>
      {value?.browserEnabled && value.browser?.error ? <p className="h37-section-foot" role="status">{value.browser.error}</p> : null}
      {value?.computerUseSupported ? <div className="h37-row"><span className="h37-row-text"><b>Windows 桌面控制</b><span>{value.desktop?.available ? value.desktop.note || '桌面助手已连接。应用操作仍按应用授权。' : value.desktop?.reason || '需要 Windows 用户已登录并解锁桌面。'}</span></span>{toggle('computerUseEnabled', '启用 Bot Windows 桌面控制')}</div> : null}
      <div className="h37-row"><span className="h37-row-text"><b>联网检索</b><span>搜索与网页正文提取使用 Bot 自己的 Tavily 配置。</span></span>{toggle('webSearchEnabled', '启用 Bot 联网检索')}</div>
      {value?.webSearchEnabled ? <form className="h37-row" onSubmit={event => {event.preventDefault();void save({searchApiKey: searchKey});}}>
        <label className="h37-row-text"><b>Tavily API Key</b><input className="h37-input" type="password" autoComplete="new-password" aria-label="Bot Tavily API Key" placeholder={value.hasSearchKey ? '已保存，输入可替换' : '输入检索 API Key'} value={searchKey} disabled={disabled} onChange={event => setSearchKey(event.target.value)}/></label>
        <button type="submit" className="h37-btn h37-btn-secondary" disabled={disabled || !searchKey.trim()}>保存</button>
      </form> : null}
      <div className="h37-row"><span className="h37-row-text"><b>技能中心</b><span>安装、导入和管理 Bot 技能；各项目的技能也会自动发现。</span></span><button type="button" className="h37-btn h37-btn-secondary" disabled={disabled} onClick={onOpenSkills}>管理 Bot 技能</button></div>
      <details className="h37-row-text h-bot-capability-details"><summary>浏览器决策模型</summary>
        <form onSubmit={event => {event.preventDefault();void save({browserActUrl: decisionUrl, browserActModel: decisionModel, ...(decisionKey.trim() ? {browserActApiKey: decisionKey} : {})});}}>
          <label>接口地址<input className="h37-input" aria-label="Bot 浏览器决策接口地址" type="url" value={decisionUrl} disabled={disabled} onChange={event => setDecisionUrl(event.target.value)}/></label>
          <label>模型型号<input className="h37-input" aria-label="Bot 浏览器决策模型型号" value={decisionModel} disabled={disabled} onChange={event => setDecisionModel(event.target.value)}/></label>
          <label>API Key<input className="h37-input" aria-label="Bot 浏览器决策 API Key" type="password" autoComplete="new-password" placeholder={value?.hasBrowserActKey ? '已保存，输入可替换' : '输入 API Key'} value={decisionKey} disabled={disabled} onChange={event => setDecisionKey(event.target.value)}/></label>
          <button type="submit" className="h37-btn h37-btn-secondary" disabled={disabled || !decisionUrl.trim() || !decisionModel.trim()}>保存决策模型</button>
        </form>
        <div className="h37-row"><span>启用浏览器快速决策</span>{toggle('browserActEnabled', '启用 Bot 浏览器快速决策')}</div>
      </details>
    </div>
    {notice ? <p className="h37-section-foot" role="status">{notice}</p> : null}
    {error ? <p className="h-bot-error" role="alert">{error}</p> : null}
  </section>;
}
