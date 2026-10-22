import { useState, type ReactNode } from 'react';
import { ArrowLeft, AudioLines, Check, Cpu, Mic } from 'lucide-react';
import { BrandIcon } from '@/components/brand-icon';
import { DOUBAO_CONSOLE_API_KEY_URL, type MicrophonePermissionStatus, type OnboardingStep } from '@/shared/types';
import { AppTopBar } from './app-top-bar';
import { OnboardingModelStep } from './onboarding-model-step';
import { VisionSection } from './vision-section';
import { BrowserSection } from './browser-section';
import { ModelRoutingDialog } from './model-routing-dialog';

type SetupScreenProps = {
  step: OnboardingStep;
  permissionChoice: 'pending' | 'granted' | 'skipped';
  microphonePermission: MicrophonePermissionStatus;
  permissionBusy: boolean;
  saving: boolean;
  asrSaved: boolean;
  asrKeySuffix: string;
  asrKeyDraft: string;
  onAsrKeyChange: (next: string) => void;
  modelSaved: boolean;
  errorMessage: string;
  onRequestMicrophone: () => void;
  onAdvance: (to: OnboardingStep, permissionChoice?: 'granted' | 'skipped') => void | Promise<void>;
  onSaveAsrKey: () => void;
  onComplete: () => void;
  onOpenExternal: (url: string) => void;
  onOpenMicrophoneSettings: () => void;
};

const STEP_INDEX: Record<OnboardingStep, number> = { welcome: 1, model: 2, capabilities: 3, microphone: 3, asr: 3, done: 4 };
const BACK_TARGET: Partial<Record<OnboardingStep, OnboardingStep>> = { model: 'welcome', capabilities: 'model', microphone: 'capabilities', asr: 'microphone', done: 'capabilities' };

function StepIcon({ children }: { children: ReactNode }) {
  return <span className="h37-tile onboarding-step-icon" data-tone="g" aria-hidden="true">{children}</span>;
}

export function SetupScreen(props: SetupScreenProps) {
  const { step, microphonePermission, permissionBusy, saving, asrSaved, asrKeySuffix, asrKeyDraft, onAsrKeyChange, modelSaved, errorMessage, onRequestMicrophone, onAdvance, onSaveAsrKey, onComplete, onOpenExternal, onOpenMicrophoneSettings } = props;
  const [modelBusy, setModelBusy] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [asrReplacing, setAsrReplacing] = useState(false);
  const micGranted = microphonePermission === 'granted';
  const micDenied = microphonePermission === 'denied' || microphonePermission === 'restricted';
  const busy = saving || permissionBusy || modelBusy;
  const index = STEP_INDEX[step];
  const backTarget = BACK_TARGET[step];
  const voiceConfigured = asrSaved && micGranted;
  const isMac = window.hemiVoice?.platform === 'darwin';

  return (
    <main className="setup-shell onboarding-page min-h-dvh overflow-hidden" data-step={step}>
      <AppTopBar showBrand={false} leading={backTarget ? (
        <button type="button" className="h37-btn h37-btn-ghost onboarding-back" disabled={busy} onClick={() => void onAdvance(backTarget)}><ArrowLeft aria-hidden="true" />返回</button>
      ) : null} actions={
        <span className="onboarding-step-count" aria-label={`引导进度 ${index} / 4`}>
          <span className="sr-only">{index} / 4</span>
          <span className="onboarding-steps" aria-hidden="true">{[1, 2, 3, 4].map(value => <i key={value} data-state={value < index ? 'done' : value === index ? 'now' : 'todo'} />)}</span>
        </span>
      } />
      <div className="onboarding-shell">
        <section key={step} className="onboarding-scene" data-center={step === 'welcome' ? 'true' : undefined} data-wide={step === 'model' ? 'true' : undefined}>
          {step === 'welcome' ? <>
            <BrandIcon className="onboarding-brand-icon" width={64} height={64} />
            <h1 className="onboarding-title">你好，我是 Hemi。</h1>
            <p className="onboarding-lead">先连接一个模型，就能用文字交给我任务。</p>
            <div className="onboarding-actions"><button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={busy} onClick={() => void onAdvance('model')}>开始设置</button></div>
          </> : null}

          {step === 'model' ? <>
            <StepIcon><Cpu /></StepIcon>
            <h1 className="onboarding-title">连接模型</h1>
            <p className="onboarding-lead">登录模型账号、连接 New API 站点，或使用自己的 API Key。</p>
            <OnboardingModelStep onContinue={async () => { await onAdvance('capabilities'); }} onBack={() => void onAdvance('welcome')} onBusyChange={setModelBusy} />
          </> : null}

          {step === 'capabilities' ? <>
            <StepIcon><Check /></StepIcon>
            <h1 className="onboarding-title">按需开启更多能力</h1>
            <p className="onboarding-lead">现在已经可以打字。下面都可以稍后在设置中配置。</p>
            <div className="onboarding-capabilities">
              <div className="h37-group">
                <div className="h37-row"><span className="h37-row-text"><b>语音交互</b><span>{voiceConfigured ? '麦克风与语音密钥已配置，使用时连接语音服务。' : '需要麦克风权限和火山引擎语音密钥。'}</span></span><button type="button" className="h37-btn h37-btn-secondary" disabled={busy} onClick={() => void onAdvance('microphone')}>{voiceConfigured ? '查看' : '配置语音'}</button></div>
              </div>
              <details className="onboarding-capability"><summary>桌面操控<span>按需授予系统权限和应用授权</span></summary><VisionSection /><p className="onboarding-field-help">操作具体应用时会请求该应用的授权；截图会发送给你配置的模型服务。</p></details>
              <details className="onboarding-capability"><summary>浏览器控制<span>安装 Chrome 扩展后使用</span></summary><BrowserSection /></details>
              <div className="h37-group"><div className="h37-row"><span className="h37-row-text"><b>自动路由与成本控制</b><span>按角色选择模型；可在接入多个模型后配置。</span></span><button type="button" className="h37-btn h37-btn-secondary" onClick={() => setRoutingOpen(true)}>配置路由</button></div></div>
              <p className="onboarding-field-help">自动记忆会在本机保存经验，用于后续模型请求。可在设置中查看、编辑、删除，并关闭任务收尾摘要。</p>
            </div>
            <div className="onboarding-actions"><button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={busy} onClick={() => void onAdvance('done')}>继续</button></div>
          </> : null}

          {step === 'microphone' ? <>
            <StepIcon><Mic /></StepIcon>
            <h1 className="onboarding-title">开启语音</h1>
            <p className="onboarding-lead">{micGranted ? '麦克风已允许，继续连接语音服务。' : micDenied ? '麦克风尚未允许，可打开系统设置后重新检查。' : '先允许使用麦克风，再连接语音服务。'}</p>
            {!micGranted ? <div className="onboarding-preview-ask"><Mic aria-hidden="true" /><span>{isMac ? '点击后 macOS 会询问麦克风权限，请选择允许。' : '请在 Windows 隐私设置中允许桌面应用使用麦克风，再重新检查。'}</span></div> : null}
            <div className="onboarding-actions" data-row="true">
              <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={busy} onClick={() => micGranted ? void onAdvance('asr', 'granted') : onRequestMicrophone()}>{permissionBusy ? '检查中…' : micGranted ? '连接语音服务' : '允许并检查麦克风'}</button>
              <button type="button" className="h37-btn h37-btn-ghost onboarding-secondary" disabled={busy} onClick={() => void onAdvance('capabilities', micGranted ? 'granted' : 'skipped')}>暂时跳过</button>
            </div>
            {!micGranted ? <button type="button" className="h37-link onboarding-mic-settings" onClick={onOpenMicrophoneSettings}>打开系统设置 ↗</button> : null}
          </> : null}

          {step === 'asr' ? <>
            <StepIcon><AudioLines /></StepIcon>
            <h1 className="onboarding-title">连接语音服务</h1>
            <p className="onboarding-lead">火山引擎密钥用于语音识别，与模型 API Key 分开配置。</p>
            {asrSaved && !asrReplacing ? <div className="h37-group onboarding-saved"><span className="h37-tile onboarding-saved-icon" data-tone="g"><Check /></span><span><strong>密钥已保存</strong>{asrKeySuffix ? <small>末尾 {asrKeySuffix}</small> : null}</span><button type="button" className="h37-btn h37-btn-ghost" onClick={() => setAsrReplacing(true)}>更换</button></div> : <div className="onboarding-field">
              <div className="onboarding-field-top"><label className="onboarding-field-label" htmlFor="onboarding-asr-key">语音 API Key</label><button type="button" className="h37-link onboarding-link" onClick={() => onOpenExternal(DOUBAO_CONSOLE_API_KEY_URL)}>获取密钥 ↗</button></div>
              <input id="onboarding-asr-key" className="h37-input h37-input-lg onboarding-input" type="password" autoComplete="new-password" placeholder="粘贴火山引擎语音密钥" value={asrKeyDraft} onChange={(event) => onAsrKeyChange(event.target.value)} disabled={busy} />
              <p className="onboarding-privacy">密钥加密保存在本机，使用语音时音频会发送给语音服务商。</p>
            </div>}
            <div className="onboarding-actions" data-row="true">
              <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={busy || ((!asrSaved || asrReplacing) && !asrKeyDraft.trim())} onClick={() => asrSaved && !asrReplacing ? void onAdvance('capabilities') : onSaveAsrKey()}>{asrSaved && !asrReplacing ? '继续' : saving ? '保存中…' : '保存并继续'}</button>
              <button type="button" className="h37-btn h37-btn-ghost onboarding-secondary" disabled={busy} onClick={() => void onAdvance('capabilities')}>暂时跳过</button>
            </div>
          </> : null}

          {step === 'done' ? <>
            <StepIcon><Check /></StepIcon>
            <h1 className="onboarding-title">可以开始了</h1>
            <p className="onboarding-lead">{modelSaved ? '模型已连接，试着输入你的第一个任务。' : '模型配置需要补充，请返回检查。'}</p>
            <p className="onboarding-field-help">{voiceConfigured ? '语音已配置，首次使用时连接服务。' : '语音尚未就绪，可以继续使用文字，稍后到设置中开启。'}</p>
            <div className="onboarding-actions"><button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={busy || !modelSaved} onClick={onComplete}>开始使用</button></div>
          </> : null}
          {errorMessage ? <p className="onboarding-field-error" role="alert">{errorMessage}</p> : null}
        </section>
      </div>
      {routingOpen ? <ModelRoutingDialog onClose={() => setRoutingOpen(false)} /> : null}
    </main>
  );
}
