import { useEffect, useRef, useState } from 'react';
import type { BotModelSyncPreview, BotState } from '@shared/bot';
import type { OAuthProvider } from '@shared/protocol';
import { BotButton, BotDialog } from './dialogs';
import { callBot } from './bridge';

const ACTIONS = { add: '新增', update: '更新', remove: '移除' };

export function BotModelsSyncDialog({ state, onClose, onDone, onAuthorize }: { state: BotState; onClose(): void; onDone(): void; onAuthorize(provider: OAuthProvider): void }) {
  const api = useRef(window.hemiVoice.bot).current, identity = state.binding!.instanceId;
  const [preview, setPreview] = useState<BotModelSyncPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [version, setVersion] = useState(0), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPreview(null); setSelected(new Set()); setError('');
    const timer = window.setTimeout(() => {
      if (!active) return;
      active = false;
      setError('配置对比未能及时返回，请点击「重新对比」重试。');
    }, 20000);
    void callBot<BotModelSyncPreview>(api, 'models.diff', { expectedInstanceId: identity }).then(value => {
      if (!value || typeof value.id !== 'string' || !Array.isArray(value.changes)) throw new Error('未收到完整的模型对比结果，请重新对比。');
      if (active) { setPreview(value); active = false; }
    }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : '无法读取配置差异。'); active = false; } })
      .finally(() => window.clearTimeout(timer));
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, identity, version]);
  const unknown = state.syncStatus?.phase === 'unknown';
  function toggle(id: string, checked: boolean) {
    setSelected(current => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const removed = new Set(preview?.changes.filter(change => selected.has(change.id) && change.action === 'remove').map(change => change.modelKey));
  const invalid = Object.values(state.cache?.roleModels ?? {}).some(key => key && removed.has(key)) ? '要移除的模型仍被路由使用，请先在 Bot 中更换对应路由或取消移除。' : '';
  async function save() {
    if (!preview) return;
    setSaving(true); setError('');
    try {
      const result = await callBot<{ results: Array<{ ok: boolean; message?: string }> }>(api, 'models.sync', {
        expectedInstanceId: identity, previewId: preview.id, selected: [...selected], requestId: 'sync-' + crypto.randomUUID(),
      });
      const failed = result.results.filter(model => !model.ok);
      if (failed.length) throw new Error([...new Set(failed.map(model => model.message || '模型验证失败，原配置保留。'))].join('；'));
      onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '同步未完成，请重新核对。'); }
    finally { setSaving(false); }
  }
  async function reconcile() {
    setSaving(true); setError('');
    try {
      const next = await callBot<BotState>(api, 'models.reconcile', { expectedInstanceId: identity });
      if (next.syncStatus?.phase === 'confirmed' && next.syncStatus.results?.every(result => result.ok)) onDone();
      else if (next.syncStatus?.phase !== 'unknown') setVersion(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法核对同步结果。'); }
    finally { setSaving(false); }
  }
  return <BotDialog title="从本机同步" className="h-bot-sync-dialog" busy={saving} onClose={onClose} footer={<>
    <BotButton disabled={saving} onClick={() => setVersion(value => value + 1)}>重新对比</BotButton>
    <BotButton disabled={saving} onClick={onClose}>取消</BotButton>
    {unknown ? <BotButton primary disabled={saving || !state.online} onClick={() => void reconcile()}>检查同步结果</BotButton>
      : <BotButton primary disabled={saving || !state.online || !selected.size || !!invalid || !preview} onClick={() => void save()}>{saving ? '正在同步…' : `同步所选${selected.size ? `（${selected.size}）` : ''}`}</BotButton>}
  </>}>
    <p className="h-bot-small">选择要从本机同步到 Bot 的模型。Bot 的自动路由单独配置，未勾选的模型保持不变。</p>
    {!preview && !error ? <p role="status">正在读取本机配置并对比…</p> : null}
    {preview && !preview.changes.length ? <p role="status">模型已一致，无需同步。</p> : null}
    {(['account', 'model'] as const).map(kind => {
      const entries = preview?.changes.filter(change => change.kind === kind) ?? [];
      return entries.length ? <fieldset className="h-bot-sync-options" key={kind} disabled={saving || unknown}>
        <legend>{kind === 'model' ? '模型差异' : '订阅账号'}</legend>
        <div className="h37-group">{entries.map(change => kind === 'account' ? <div className="h37-row" key={change.id}>
          <span className="h37-row-text"><b>{change.title}</b><span>{change.before}</span>{change.details.map(detail => <span key={detail}>{detail}</span>)}</span>
          <BotButton disabled={saving || unknown || !state.online} onClick={() => onAuthorize(change.oauthProvider!)}>{change.action === 'update' ? '重新授权' : '为 Bot 授权'}</BotButton>
        </div> : <label className="h37-row h-bot-sync-change" key={change.id}>
          <input type="checkbox" aria-label={`${change.action === 'remove' ? '移除' : '同步'} ${change.title}`} checked={selected.has(change.id)} disabled={!change.canSync} onChange={event => toggle(change.id, event.target.checked)} />
          <span className="h37-row-text"><b>{change.title} <em>{ACTIONS[change.action]}</em></b><span>Bot：{change.before}</span><span>{change.action === 'remove' ? '同步后' : '本机'}：{change.after}</span>
            {change.details.map(detail => <span key={detail}>{detail}</span>)}{change.reason ? <span>{change.reason}</span> : null}
          </span>
        </label>)}</div>
      </fieldset> : null;
    })}
    {unknown ? <p role="status" className="h-bot-small">同步结果待确认，请先检查同步结果。</p> : null}
    {invalid || error ? <p role="alert" className="h-bot-error">{error || invalid}</p> : null}
  </BotDialog>;
}
