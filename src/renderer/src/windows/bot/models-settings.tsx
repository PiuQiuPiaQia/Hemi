import { useId, useRef, useState } from 'react';
import { ChevronDown, Monitor, Plus, Server } from 'lucide-react';
import type { BotModel, BotState } from '@shared/bot';
import type { ModelProviderApi, ModelProviderSaveInput } from '@shared/protocol';
import { BotButton, BotDialog, BotModelSetup } from './dialogs';
import { botModelDirectory } from './bridge';

const ROLE_LABELS = { main: '主模型', explorer: '侦察', oracle: '顾问', fixer: '执行', designer: '设计', fallback: '备用模型' } as const;

export function BotModelsSettings({ state, onOpenLocalModels }: { state: BotState; onOpenLocalModels(): void }) {
  const [adding, setAdding] = useState(false), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<BotModel[] | null>(null);
  const directory = botModelDirectory(state);
  const local = directory.providers.filter(provider => provider.source !== 'cloud');
  const cloud = directory.providers.filter(provider => provider.source === 'cloud');
  const roles = state.localRoleModels ?? state.cache?.roleModels ?? {};
  const modelNames = new Map(directory.providers.flatMap(provider => provider.models.map(model => [model.modelKey, model.model] as const)));
  const modelName = (key: string | null | undefined) => key ? modelNames.get(key) ?? key : null;
  const routingSummary = roles.main ? `主：${modelName(roles.main)} · 备用：${modelName(roles.fallback) ?? '未设置'}` : '尚未设置主模型';
  return <div className="h37-enter h-bot-model-settings">
    <div className="h37-page-head"><h2>模型</h2></div>
    <section className="h37-section">
      <div className="h37-section-head"><h3><Monitor size={16} aria-hidden="true" /> 本机配置</h3><button type="button" className="h37-btn h37-btn-secondary" onClick={onOpenLocalModels}>在本机修改</button></div>
      {roles.main ? <details className="h37-group h-bot-routing">
        <summary className="h37-row h-bot-routing-summary" data-clickable="true"><b className="h37-row-title">自动路由</b><span className="h-bot-routing-preview" title={routingSummary}>{routingSummary}</span><ChevronDown size={16} aria-hidden="true" /></summary>
        <dl className="h-bot-routing-models" aria-label="自动路由模型">{Object.entries(ROLE_LABELS).map(([slot, label]) => {
          const key = roles[slot as keyof typeof ROLE_LABELS];
          return <div key={slot}><dt>{label}</dt><dd>{modelName(key) || (slot === 'fallback' ? '未设置' : '跟随主模型')}</dd></div>;
        })}</dl>
      </details> : <div className="h37-group"><div className="h37-row h-bot-routing-summary"><b className="h37-row-title">自动路由</b><span className="h-bot-routing-preview">{routingSummary}</span></div></div>}
      <div className="h37-group h-bot-sourced-models">{local.map(provider => {
        const reasons = [...new Set(provider.models.map(model => model.unavailableReason).filter(Boolean))];
        return <div className="h37-row h37-bot-settings-row" key={provider.id}>
          <Monitor size={16} aria-label="本机配置" /><span className="h37-row-text"><b>{provider.name}</b><span>{provider.models.map(model => model.model).join('、')}</span>{reasons.length ? <span>{reasons.join('；')}</span> : null}</span>
        </div>;
      })}{!local.length ? <div className="h37-row"><span className="h37-row-desc">暂无本机模型</span></div> : null}</div>
      {state.modelConfigError ? <p className="h-bot-error" role="status">{state.modelConfigError}</p> : null}
    </section>
    <section className="h37-section">
      <div className="h37-section-head"><h3><Server size={16} aria-hidden="true" /> 云端配置</h3><button type="button" className="h37-btn h37-btn-secondary" disabled={!state.online || !!state.busy} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> 添加云端模型</button></div>
      <div className="h37-group">{cloud.map(provider => <div className="h37-row h37-bot-settings-row" key={provider.id}>
        <Server size={16} aria-label="云端配置" /><span className="h37-row-text"><b>{provider.name}</b><span>{provider.models.map(model => model.model).join('、')}</span></span>
        <button type="button" className="h37-btn h37-btn-secondary" disabled={!state.online || !!state.busy} onClick={() => setEditing(state.cache!.models.filter(model => model.providerId === provider.id))}>编辑</button>
      </div>)}{!cloud.length ? <div className="h37-row"><span className="h37-row-desc">暂无云端模型</span></div> : null}</div>
    </section>
    {adding ? <BotDialog title="添加云端模型" busy={busy} onClose={() => setAdding(false)}><BotModelSetup api={window.hemiVoice.bot} state={state} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} onBusyChange={setBusy} /></BotDialog> : null}
    {editing ? <CloudModelEditor models={editing} state={state} onClose={() => setEditing(null)} /> : null}
  </div>;
}

function CloudModelEditor({ models, state, onClose }: { models: BotModel[]; state: BotState; onClose(): void }) {
  const first = models[0], formId = useId();
  const [name, setName] = useState(first.name), [baseUrl, setBaseUrl] = useState(first.baseUrl);
  const [api, setApi] = useState(first.api as ModelProviderApi), [apiKey, setApiKey] = useState('');
  const [entries, setEntries] = useState<ModelProviderSaveInput['models']>(() => models.map(model => ({ id: model.key.split('/')[1], model: model.model, supportsVision: model.supportsVision, thinkingLevel: model.thinkingLevel ?? 'default', thinkingFormat: model.thinkingFormat })));
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const operation = useRef('models-' + crypto.randomUUID());
  async function save() {
    setSaving(true); setError('');
    try {
      const result = await window.hemiVoice.bot.command<{ results: Array<{ ok: boolean; message?: string }> }>('models.add', {
        expectedInstanceId: state.binding?.instanceId, requestId: operation.current,
        provider: { id: first.providerId, name, baseUrl, api, apiKey, models: entries },
      });
      if (result.results.some(model => !model.ok)) throw new Error(result.results.find(model => !model.ok)?.message || '验证失败，原配置保留。');
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试。');
      if (!['offline', 'needs-review'].includes((reason as {code?: string}).code ?? '')) operation.current = 'models-' + crypto.randomUUID();
    } finally { setSaving(false); }
  }
  return <BotDialog title="编辑云端模型" busy={saving} onClose={onClose} footer={<><BotButton disabled={saving} onClick={onClose}>取消</BotButton><BotButton primary form={formId} type="submit" disabled={saving || !state.online}>{saving ? '正在验证…' : '验证并保存'}</BotButton></>}>
    <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="h-bot-model-form" disabled={saving}>
        <label className="h-bot-field">供应商名称<input required value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="h-bot-field">接口地址<input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
        <label className="h-bot-field">协议<select value={api} onChange={event => setApi(event.target.value as ModelProviderApi)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
        <label className="h-bot-field">API Key<input type="password" autoComplete="new-password" placeholder="留空保留云端已保存的 Key" value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
        {entries.map((entry, index) => <div key={entry.id} className="h-bot-cloud-model-entry">
          <label className="h-bot-field">型号 {index + 1}<input required value={entry.model} onChange={event => setEntries(current => current.map((model, i) => i === index ? { ...model, model: event.target.value } : model))} /></label>
          <label className="h-bot-field">思考强度<select value={entry.thinkingLevel} onChange={event => setEntries(current => current.map((model, i) => i === index ? { ...model, thinkingLevel: event.target.value as 'default' } : model))}>{['default', 'off', 'low', 'medium', 'high'].map(level => <option key={level} value={level}>{level === 'default' ? '默认' : level}</option>)}</select></label>
          <label className="h-bot-small"><input type="checkbox" checked={entry.supportsVision === true} onChange={event => setEntries(current => current.map((model, i) => i === index ? { ...model, supportsVision: event.target.checked } : model))} /> 支持图片</label>
          {entries.length > 1 ? <BotButton onClick={() => setEntries(current => current.filter((_, i) => i !== index))}>移除此型号</BotButton> : null}
        </div>)}
        <BotButton disabled={entries.length >= 50} onClick={() => setEntries(current => [...current, { id: 'm-' + crypto.randomUUID(), model: '', thinkingLevel: 'default', supportsVision: false }])}>添加型号</BotButton>
      </fieldset>
      {error ? <p className="h-bot-error" role="alert">{error}</p> : null}
    </form>
  </BotDialog>;
}
