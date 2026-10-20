import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, AudioLines, Check, Cpu, Mic, MicOff } from 'lucide-react';

import { BrandIcon } from '@/components/brand-icon';

import {
  DOUBAO_CONSOLE_API_KEY_URL,
  type MicrophonePermissionStatus,
  type ModelProviderApi,
  type ModelTestResult,
  type OnboardingStep,
} from '@/shared/types';
import { AppTopBar } from '@/windows/voice/app-top-bar';

/** 032 第 4 屏的四项（051 起含线协议选择：OpenAI 兼容 / Anthropic 原生）。 */
export type OnboardingModelDraft = {
  api: ModelProviderApi;
  baseUrl: string;
  model: string;
  apiKey: string;
};

type SetupScreenProps = {
  /** 引导快照（主进程权威；step 已按真实配置对齐）。 */
  step: OnboardingStep;
  permissionChoice: 'pending' | 'granted' | 'skipped';
  microphonePermission: MicrophonePermissionStatus;
  permissionBusy: boolean;
  /** 任一保存动作在途（禁用主操作，防双击重复提交）。 */
  saving: boolean;
  /** 语音服务密钥已持久保存（主进程判定）。 */
  asrSaved: boolean;
  /** 已存密钥的脱敏尾缀（拿不到就空串，不回显明文）。 */
  asrKeySuffix: string;
  /** 语音步的草稿 Key（跨步骤保留；由页面在保存时读取）。 */
  asrKeyDraft: string;
  onAsrKeyChange: (next: string) => void;
  /** 默认模型组三项完整且 Key 已加密保存（主进程判定）。 */
  modelSaved: boolean;
  /** 模型步草稿（进入第 4 屏时由页面按默认组预填）。 */
  modelDraft: OnboardingModelDraft;
  onModelFieldChange: (patch: Partial<OnboardingModelDraft>) => void;
  /** 正在编辑已有默认组（其已存 Key 可留空沿用）。 */
  modelEditingSavedGroup: boolean;
  /** 页面级错误（保存/前进失败的原因，就地显示）。 */
  errorMessage: string;
  onRequestMicrophone: () => void;
  /** 前进/后退（主进程校验硬门槛；失败由页面写 errorMessage）。 */
  onAdvance: (to: OnboardingStep, permissionChoice?: 'granted' | 'skipped') => void;
  onSaveAsrKey: () => void;
  onSaveModel: () => void;
  onComplete: () => void;
  /** 测试连接（页面注入真实 IPC；fixtures 注入桩）。 */
  onTestModel: (draft: OnboardingModelDraft) => Promise<ModelTestResult>;
  /** 外链与系统设置（fixtures 注入 no-op）。 */
  onOpenExternal: (url: string) => void;
  onOpenMicrophoneSettings: () => void;
};

const STEP_COUNT = 5;
const STEP_INDEX: Record<OnboardingStep, number> = {
  welcome: 1,
  microphone: 2,
  asr: 3,
  model: 4,
  done: 5,
};

/** 上一步去向（welcome 没有返回）。 */
const BACK_TARGET: Partial<Record<OnboardingStep, OnboardingStep>> = {
  microphone: 'welcome',
  asr: 'microphone',
  model: 'asr',
  done: 'model',
};

/** 037：各步顶部 48px 图标块。 */
function StepIcon({ children }: { children: ReactNode }) {
  return (
    <span className="h37-tile onboarding-step-icon" data-tone="g" aria-hidden="true">
      {children}
    </span>
  );
}

export function SetupScreen(props: SetupScreenProps) {
  const {
    step,
    permissionChoice,
    microphonePermission,
    permissionBusy,
    saving,
    asrSaved,
    asrKeySuffix,
    asrKeyDraft,
    onAsrKeyChange,
    modelSaved,
    modelDraft,
    onModelFieldChange,
    modelEditingSavedGroup,
    errorMessage,
    onRequestMicrophone,
    onAdvance,
    onSaveAsrKey,
    onSaveModel,
    onComplete,
    onTestModel,
    onOpenExternal,
    onOpenMicrophoneSettings,
  } = props;

  // 麦克风步子状态：默认询问；「稍后开启」/请求未过/系统已拒绝 → 未开启说明。
  const [micDeferred, setMicDeferred] = useState(false);
  const micGranted = microphonePermission === 'granted' || permissionChoice === 'granted';
  const micPausedState =
    micDeferred
    || permissionChoice === 'skipped'
    || microphonePermission === 'denied'
    || microphonePermission === 'restricted';
  const micView = micGranted ? 'granted' : micPausedState ? 'paused' : 'ask';
  useEffect(() => {
    if (micGranted) setMicDeferred(false);
  }, [micGranted]);

  // 语音步子状态：已存密钥先展示脱敏卡，「更换」才回到输入。
  const [asrReplacing, setAsrReplacing] = useState(false);
  const showAsrForm = !asrSaved || asrReplacing;
  // 走到语音步但主进程说未保存（保存失败/被删）：回落输入态。
  useEffect(() => {
    if (!asrSaved) setAsrReplacing(false);
  }, [asrSaved]);

  // 模型步的测试连接：请求序号丢弃过时回执；改任一字段即失效旧结果。
  const [test, setTest] = useState<{ phase: 'idle' | 'testing' | 'ok' | 'error'; text: string }>({
    phase: 'idle',
    text: '',
  });
  const testSeqRef = useRef(0);
  useEffect(() => {
    testSeqRef.current += 1;
    setTest({ phase: 'idle', text: '' });
  }, [modelDraft.api, modelDraft.baseUrl, modelDraft.model, modelDraft.apiKey, step]);

  const runTest = async () => {
    const seq = (testSeqRef.current += 1);
    setTest({ phase: 'testing', text: '' });
    const result = await onTestModel(modelDraft);
    if (testSeqRef.current !== seq) return; // 字段已改/重复测试：丢弃过时回执
    if (result?.ok) {
      setTest({
        phase: 'ok',
        text: `连接成功 · ${result.latencyMs ?? '?'}ms${result.resolvedModel ? ` · ${result.resolvedModel}` : ''}`,
      });
    } else {
      setTest({ phase: 'error', text: result?.error ?? '测试调用失败，请重试。' });
    }
  };

  const modelFieldsFilled = Boolean(
    modelDraft.baseUrl.trim() && modelDraft.model.trim() && modelDraft.apiKey.trim(),
  );
  const modelTestReady = modelFieldsFilled || (modelEditingSavedGroup && Boolean(modelDraft.baseUrl.trim() && modelDraft.model.trim()));

  // 037：步骤切换 280ms——前进自右 24px 进入，返回反向。场景 key 变化时按序号定方向
  //（渲染期派生，避免方向在同一场景内翻转而重播动画）。
  const stepIndex = STEP_INDEX[step];
  const sceneKey =
    step === 'microphone' ? `microphone-${micView}` : step === 'asr' ? `asr-${showAsrForm ? 'form' : 'saved'}` : step;
  const [nav, setNav] = useState<{ key: string; index: number; dir: 'forward' | 'back' }>({
    key: sceneKey,
    index: stepIndex,
    dir: 'forward',
  });
  if (nav.key !== sceneKey) {
    setNav({ key: sceneKey, index: stepIndex, dir: stepIndex < nav.index ? 'back' : 'forward' });
  }
  const backTarget = BACK_TARGET[step];

  return (
    <main className="setup-shell onboarding-page min-h-dvh overflow-hidden" data-step={step}>
      <AppTopBar
        showBrand={false}
        leading={
          backTarget ? (
            <button
              type="button"
              className="h37-btn h37-btn-ghost onboarding-back"
              onClick={() => onAdvance(backTarget)}
            >
              <ArrowLeft aria-hidden="true" />
              返回
            </button>
          ) : null
        }
        actions={
          <span className="onboarding-step-count" aria-label={`引导进度 ${stepIndex} / ${STEP_COUNT}`}>
            <span className="sr-only">
              {stepIndex} / {STEP_COUNT}
            </span>
            <span className="onboarding-steps" aria-hidden="true">
              {Array.from({ length: STEP_COUNT }, (_, i) => (
                <i key={i} data-state={i + 1 < stepIndex ? 'done' : i + 1 === stepIndex ? 'now' : 'todo'} />
              ))}
            </span>
          </span>
        }
      />

      <div className="onboarding-shell">
        <section
          key={sceneKey}
          className="onboarding-scene"
          data-dir={nav.dir}
          data-center={step === 'welcome' ? 'true' : undefined}
        >
          {step === 'welcome' ? (
            <>
              <BrandIcon
                className="onboarding-brand-icon"
                width={64}
                height={64}
              />
              <h1 className="onboarding-title">你好，我是 Hemi。</h1>
              <p className="onboarding-lead">说话或打字，交给我一件事。</p>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={saving}
                  onClick={() => onAdvance('microphone')}
                >
                  开始设置
                </button>
              </div>
            </>
          ) : null}

          {step === 'microphone' && micView === 'ask' ? (
            <>
              <StepIcon>
                <Mic />
              </StepIcon>
              <h1 className="onboarding-title">开启麦克风</h1>
              <p className="onboarding-lead">说话时使用。暂时不开，也可以打字。</p>
              <div className="onboarding-preview-ask">
                <Mic aria-hidden="true" />
                <span>
                  点下面的按钮后，macOS 会弹出 <b>“Hemi 想访问麦克风”</b>，选「允许」即可。
                </span>
              </div>
              <div className="onboarding-actions" data-row="true">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={permissionBusy || saving}
                  onClick={onRequestMicrophone}
                >
                  {permissionBusy ? '检查中…' : '允许麦克风'}
                </button>
                <button
                  type="button"
                  className="h37-btn h37-btn-ghost h37-btn-lg onboarding-secondary"
                  disabled={saving}
                  onClick={() => setMicDeferred(true)}
                >
                  稍后开启
                </button>
              </div>
            </>
          ) : null}

          {step === 'microphone' && micView === 'paused' ? (
            <>
              <StepIcon>
                <MicOff />
              </StepIcon>
              <h1 className="onboarding-title">麦克风未开启</h1>
              <p className="onboarding-lead">可以继续，稍后在系统设置中开启。</p>
              {errorMessage ? <p className="onboarding-field-error">{errorMessage}</p> : null}
              <div className="onboarding-actions" data-row="true">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={saving}
                  onClick={() => onAdvance('asr', 'skipped')}
                >
                  继续
                </button>
                <button
                  type="button"
                  className="h37-btn h37-btn-ghost h37-btn-lg onboarding-link"
                  onClick={onOpenMicrophoneSettings}
                >
                  打开系统设置 ↗
                </button>
              </div>
            </>
          ) : null}

          {step === 'microphone' && micView === 'granted' ? (
            <>
              <StepIcon>
                <Mic />
              </StepIcon>
              <h1 className="onboarding-title">麦克风已允许</h1>
              <p className="onboarding-lead">Hemi 只在你主动说话或通话时使用它。</p>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={saving}
                  onClick={() => onAdvance('asr', 'granted')}
                >
                  继续
                </button>
              </div>
            </>
          ) : null}

          {step === 'asr' && !showAsrForm ? (
            <>
              <StepIcon>
                <AudioLines />
              </StepIcon>
              <h1 className="onboarding-title">语音服务已保存</h1>
              <div className="h37-group onboarding-saved">
                <span className="h37-tile onboarding-saved-icon" data-tone="g">
                  <Check className="size-4" strokeWidth={2.6} />
                </span>
                <span>
                  <strong>密钥已保存</strong>
                  {asrKeySuffix ? <small>末尾 {asrKeySuffix}</small> : null}
                </span>
                <button type="button" className="h37-btn h37-btn-ghost" onClick={() => setAsrReplacing(true)}>
                  更换
                </button>
              </div>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={saving}
                  onClick={() => onAdvance('model')}
                >
                  继续
                </button>
              </div>
            </>
          ) : null}

          {step === 'asr' && showAsrForm ? (
            <>
              <StepIcon>
                <AudioLines />
              </StepIcon>
              <h1 className="onboarding-title">连接语音服务</h1>
              <p className="onboarding-lead">粘贴火山引擎密钥，把语音变成文字。</p>
              <div className="onboarding-field">
                <div className="onboarding-field-top">
                  <label className="onboarding-field-label" htmlFor="onboarding-asr-key">
                    API Key
                  </label>
                  <button
                    type="button"
                    className="h37-link onboarding-link"
                    onClick={() => onOpenExternal(DOUBAO_CONSOLE_API_KEY_URL)}
                  >
                    获取密钥 ↗
                  </button>
                </div>
                <input
                  id="onboarding-asr-key"
                  className="h37-input h37-input-lg onboarding-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder="粘贴密钥"
                  value={asrKeyDraft}
                  onChange={(event) => onAsrKeyChange(event.target.value)}
                  data-error={Boolean(errorMessage)}
                  aria-invalid={Boolean(errorMessage) || undefined}
                />
                {errorMessage ? (
                  <p className="onboarding-field-error" role="alert">
                    {errorMessage}
                  </p>
                ) : null}
              </div>
              <p className="onboarding-privacy">密钥只保存在这台 Mac 上</p>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={saving || !asrKeyDraft.trim()}
                  onClick={onSaveAsrKey}
                >
                  保存并继续
                </button>
              </div>
            </>
          ) : null}

          {step === 'model' ? (
            <>
              <StepIcon>
                <Cpu />
              </StepIcon>
              <h1 className="onboarding-title">连接主脑模型</h1>
              <p className="onboarding-lead">选择接口协议并填写接口信息。</p>
              <div className="onboarding-openai-fields">
                <label>
                  接口协议
                  <select
                    id="onboarding-model-api"
                    className="h37-input h37-input-lg onboarding-input"
                    value={modelDraft.api}
                    onChange={(event) =>
                      onModelFieldChange({
                        api: event.target.value === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
                      })
                    }
                  >
                    <option value="openai-completions">OpenAI 兼容（chat/completions）</option>
                    <option value="anthropic-messages">Anthropic 原生（/v1/messages）</option>
                  </select>
                </label>
                <label>
                  接口地址
                  <input
                    id="onboarding-model-url"
                    className="h37-input h37-input-lg onboarding-input"
                    type="url"
                    placeholder="https://api.example.com/v1"
                    value={modelDraft.baseUrl}
                    onChange={(event) => onModelFieldChange({ baseUrl: event.target.value })}
                  />
                </label>
                <label>
                  模型名称
                  <input
                    id="onboarding-model-name"
                    className="h37-input h37-input-lg onboarding-input"
                    type="text"
                    placeholder="输入模型名称"
                    value={modelDraft.model}
                    onChange={(event) => onModelFieldChange({ model: event.target.value })}
                  />
                </label>
                <label>
                  API Key
                  <input
                    id="onboarding-model-key"
                    className="h37-input h37-input-lg onboarding-input"
                    type="password"
                    autoComplete="new-password"
                    placeholder={modelEditingSavedGroup ? '留空继续使用已保存的密钥' : '粘贴密钥'}
                    value={modelDraft.apiKey}
                    onChange={(event) => onModelFieldChange({ apiKey: event.target.value })}
                    data-error={test.phase === 'error' && test.text.includes('API Key')}
                    aria-invalid={(test.phase === 'error' && test.text.includes('API Key')) || undefined}
                  />
                </label>
              </div>
              <div className="onboarding-test-row">
                <button
                  type="button"
                  className="h37-btn h37-btn-secondary onboarding-test-button"
                  disabled={test.phase === 'testing' || !modelTestReady}
                  onClick={() => void runTest()}
                >
                  {test.phase === 'testing' ? '测试中…' : '测试连接'}
                </button>
                {test.phase !== 'idle' ? (
                  <p
                    className={test.phase === 'ok' ? 'h37-badge onboarding-test-result' : 'onboarding-test-result'}
                    data-kind={test.phase === 'ok' ? 'ok' : 'error'}
                    data-tone={test.phase === 'ok' ? 'ok' : undefined}
                    role="status"
                  >
                    {test.text}
                  </p>
                ) : null}
              </div>
              {errorMessage ? (
                <p className="onboarding-field-error" role="alert">
                  {errorMessage}
                </p>
              ) : null}
              <div className="onboarding-actions">
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary"
                  disabled={saving}
                  onClick={onSaveModel}
                >
                  保存并继续
                </button>
              </div>
            </>
          ) : null}

          {step === 'done' ? (
            <>
              <StepIcon>
                <Check />
              </StepIcon>
              <h1 className="onboarding-title">设置好了</h1>
              <p className="onboarding-lead">现在可以说话，也可以打字。</p>
              {errorMessage ? (
                <p className="onboarding-field-error" role="alert">
                  {errorMessage}
                </p>
              ) : null}
              <div className="onboarding-actions">
                <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={saving} onClick={onComplete}>
                  开始使用
                </button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
