import { useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { BotState } from '@shared/bot';
import { ModelProfilesSection, type ModelView } from '../voice/model-profiles-section';
import { botModelDirectory, callBot } from './bridge';
import { createBotModelSettingsBridge } from './model-settings-bridge';
import { BotModelsSyncDialog } from './models-sync-dialog';
import { BotBrowserDecisionSettings } from './capabilities-settings';

export function BotModelsSettings({ state, decisionOpen = false, onToggleDecision = () => {}, onBackToBrowser }: {
  state: BotState;
  decisionOpen: boolean;
  onToggleDecision?: () => void;
  onBackToBrowser?: () => void;
}) {
  const current = useRef(state); current.current = state;
  const [view, setView] = useState<ModelView['kind']>('overview');
  const [comparing, setComparing] = useState(false), [error, setError] = useState('');
  const [openAddRequest, setOpenAddRequest] = useState(0);
  const api = window.hemiVoice.bot;
  const bridge = useMemo(() => createBotModelSettingsBridge(api, () => current.current), [api, state.binding?.instanceId, state.cache?.modelConfigRevision]);
  const directory = useMemo(() => botModelDirectory(state), [state.cache]);
  const locked = !state.online || !!state.busy || state.syncStatus?.phase === 'sending' || state.syncStatus?.phase === 'unknown';
  return <div className="h37-settings-stack h-bot-model-settings">
    <div className="h37-page-head" hidden={view !== 'overview'}><div><h2>模型与路由</h2></div></div>
    {error ? <p className="h37-error-text" role="alert">{error}</p> : null}
    {state.syncStatus?.phase === 'unknown' ? <p className="h37-help">配置结果待确认。<button type="button" className="h37-btn h37-btn-secondary" disabled={!state.online} onClick={() => void callBot(api, 'models.reconcile', { expectedInstanceId: state.binding?.instanceId }).catch(reason => setError(String(reason.message)))}>检查配置状态</button></p> : null}
    <div className="settings-form-section h37-settings-text">
      <ModelProfilesSection api={bridge} environment="bot" botInstanceId={state.binding?.instanceId} externalDirectory={directory} disabled={locked} openAddRequest={openAddRequest}
        onViewChange={setView} onSyncLocal={() => setComparing(true)} actions={<button type="button" className="h37-btn h37-btn-secondary" disabled={locked} onClick={() => setComparing(true)}><Download size={14} aria-hidden="true" /> 从本机同步</button>} />
    </div>
    {comparing ? <BotModelsSyncDialog state={state} onClose={() => setComparing(false)} onDone={() => setComparing(false)} onAuthorize={provider => {
      setComparing(false); setError('');
      void callBot(api, 'oauth.start', { provider, expectedInstanceId: state.binding?.instanceId })
        .then(() => setOpenAddRequest(value => value + 1)).catch(reason => setError(reason instanceof Error ? reason.message : '未能发起 Bot 授权。'));
    }} /> : null}
    {/* 与 PC 模型页一致：供应商下钻时隐藏决策模型区块。 */}
    {view === 'overview' ? <BotBrowserDecisionSettings state={state} open={decisionOpen} onToggle={onToggleDecision} onBack={onBackToBrowser} /> : null}
  </div>;
}
