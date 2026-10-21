import {confirmWorkflowLeave} from "./workflow-leave-guard";
import type { ChatTurnReceipt, ConversationDeliverableView, ConversationTurnState, SkillSelectionView } from '@shared/protocol';
import { retainedDeliverables } from './lib/retained-deliverables';
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { BrandIcon } from '@/components/brand-icon';

import { SettingsScreen } from '@/windows/voice/settings-screen';
import { BargeInController, DEFAULT_BARGE_IN_CONFIG } from '@/windows/voice/lib/barge-in';
import { InterimTranscript } from '@/windows/voice/lib/interim-guard';
import {
  historyFromTurns,
  rewindToMessage,
  supersedeTrailingErrors,
} from '@/windows/voice/lib/message-edit';
import { cleanTitleSource } from '@/windows/voice/lib/conversation-format';
import { contextWindow } from '@/windows/voice/lib/context-window';
import { createPrimarySpeakerFilter } from '@/windows/voice/lib/primary-speaker';
import { SilenceGate, rootMeanSquare } from '@/windows/voice/lib/silence-gate';
import { TtsPlayer } from '@/windows/voice/lib/tts-player';
import {
  canSendText,
  hasPendingSpeech,
  recordFinal,
  shouldAutoSpeak,
  shouldWaitForSpeech,
  type HistoryEntry,
} from '@/windows/voice/lib/turn-input';
import {
  DEFAULT_ENDPOINT,
  DURATION_RESOURCE_ID,
  TTS_DEFAULT_RESOURCE_ID,
  TTS_DEFAULT_VOICE,
  TTS_MAX_TEXT_CHARS,
  TTS_PREVIEW_TEXT,
  TTS_SAMPLE_RATE,
  type ConfigForm,
  type ConversationSession,
  type DuplexStartResult,
  type InputSource,
  type ListenMode,
  type MicrophonePermissionStatus,
  type ModelProviderView,
  type OnboardingState,
  type OnboardingStep,
  type SessionState,
  type TaskActionName,
  type TaskPermissionChoice,
  type TaskStateSnapshot,
  type TextModelConfigForm,
  type ThinkingLevel,
  type TranscriptItem,
  type TtsAudioEvent,
  type TtsConfigForm,
  type TtsStateEvent,
  type TurnPhase,
  type WorkContextAttachKind,
  type WorkContextState,
  type MessageAttachmentView,
  type MessageReferenceView,
  type ModelProfilesDirectory,
  type TurnQueueState,
  type WorkspaceState,
  type WorkspaceView,
  type UsageRecord,
  type TurnPart,
} from '@/shared/types';
import { SetupScreen } from '@/windows/voice/setup-screen';
import { createLogger } from '@/shared/log';
import { buildInputHistory } from '@/windows/voice/lib/input-history';
import { VoiceScreen } from '@/windows/voice/voice-screen';
import { useConversationFlow } from '@/windows/voice/lib/use-conversation-flow';
import { deriveModelBusy } from '@/windows/voice/lib/turn-busy';
import { createComposerDraft } from '@/windows/voice/lib/composer-draft';
import { createFlowTimelineProjector } from '@/windows/voice/lib/flow-timeline-view';
import { RemotePasswordDialog } from '@/windows/voice/remote-password-dialog';
import { MemoryNotices, memoryScopeLabel, useMemoryNotices } from '@/windows/voice/memory-notice';

/** 一次播报（回合回应或设置页试听）的跟踪句柄。 */
type ActiveSpeak = {
  turnId: number;
  kind: 'turn' | 'preview';
  /** 服务端已确认合成完成（之后不会再有音频帧）。 */
  synthDone: boolean;
  failed: boolean;
  failureMessage: string;
  receivedBytes: number;
};

function createTranscriptId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 015：会话 id（与主进程 conv-[a-z0-9-]+ 校验格式一致）。 */
function createConversationId() {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A call streams into a single provider session for as long as it stays open.
 * The provider can still close the socket (idle limits, quota, network), so we
 * rebuild only the recognition session and keep the microphone stream running.
 */
const MAX_CONTINUOUS_RECONNECTS = 5;
const CONTINUOUS_RECONNECT_BASE_DELAY_MS = 400;
const CONTINUOUS_RECONNECT_MAX_DELAY_MS = 2500;

/** 通话模式的「说完」判定：最后一句定稿后再静音这么久，这一轮才算完。 */
const TURN_END_SILENCE_MS = 1200;
/** 回应就绪后停留多久自动回待机；通话中会被下一次开口提前打断。 */
const REPLY_SETTLE_MS = 15000;

/** Frames are 4096 samples, so this is ~85 ms at 48 kHz. */
const CAPTURE_BUFFER_SIZE = 4096;

function captureFrameMs(sampleCount: number, sampleRate: number) {
  return sampleRate > 0 ? (sampleCount / sampleRate) * 1000 : 0;
}

function downsampleToPcm16(input: Float32Array, inputRate: number) {
  const outputRate = 16000;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new ArrayBuffer(outputLength * 2);
  const view = new DataView(output);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex];
    }

    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(
      outputIndex * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return output;
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 排查日志：经主进程落到终端与 userData/hemi.log（info 级）。 */
const voiceLog = createLogger('voice');

function logChain(message: string) {
  voiceLog.info(message);
}

export default function Home() {
  const [bootstrapping, setBootstrapping] = useState(true);
  // 032：首启判定以主进程引导状态为权威（phase=in_progress 才呈现引导页）；
  // 已完成的用户配置缺失/权限被收回都不再回引导，改在主界面就近修复。
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const setupRequired = onboarding?.phase === 'in_progress';
  const [setupError, setSetupError] = useState('');
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [microphonePermission, setMicrophonePermission] =
    useState<MicrophonePermissionStatus>('not-determined');
  // 可选语音服务草稿；模型接入由与设置共用的组件管理。
  const [asrKeyDraft, setAsrKeyDraft] = useState('');
  // 032：主界面就近修复条（语音服务/麦克风问题；模型缺失走输入区既有提示）。
  const [repairHint, setRepairHint] = useState<{
    key: 'asr' | 'microphone';
    title: string;
    detail: string;
    actionLabel: string;
    onAction: () => void;
  } | null>(null);
  /** 设置页直达目标（修复条/引导完成后的入口按区块定位）。
   *  041 六分类键；旧五分类键（model/computer/browser）作为别名由 SettingsScreen 映射。 */
  const [settingsTarget, setSettingsTarget] = useState<{
    page: 'general' | 'voice' | 'models' | 'control' | 'web' | 'memory' | 'model' | 'computer' | 'browser';
    /** 旧目标「模型 → 语音」子 tab 的兼容键（解析为语音与通话页）。 */
    modelTab?: 'text' | 'voice';
    /** 深层定位锚点：recognition / browser-decision / browser / invoke。 */
    section?: string;
  } | null>(null);

  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [sessionMode, setSessionMode] = useState<ListenMode | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('idle');
  const [turnError, setTurnError] = useState('');
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [voiceGateOpen, setVoiceGateOpen] = useState(false);
  const [silenceSkippedSeconds, setSilenceSkippedSeconds] = useState(0);
  const [interimText, setInterimText] = useState('');
  // 已定稿但尚未受理的语音仍是输入草稿；不能塞回 interim 冒充未完成识别。
  const [speechDraftText, setSpeechDraftText] = useState('');
  const speechAcceptedCountRef = useRef(0);
  const [speechDeliveries, setSpeechDeliveries] = useState<Array<{ inputId: string; boundary: number }>>([]);
  const speechPreviewText = [speechDraftText, interimText].filter(Boolean).join('\n');
  /**
   * 识别文本的同步镜像：ASR 事件回调里要立刻读到「正在显示的是哪句」，
   * 用分句身份处理定稿修订。所有显示写入都走 updateInterim。
   */
  const interimTextRef = useRef('');
  const interimAdmittedRef = useRef(true);
  const interimRef = useRef(new InterimTranscript());
  const updateInterim = useCallback((text: string, admitted = true) => {
    if (!text) interimRef.current.clear();
    interimTextRef.current = text;
    interimAdmittedRef.current = admitted;
    setInterimText(text);
  }, []);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const { snapshot: flowSnapshot } = useConversationFlow(conversationId);
  const flowSnapshotRef = useRef(flowSnapshot);
  flowSnapshotRef.current = flowSnapshot;
  const [archivePayload, setArchivePayload] = useState<{ conversationId: string | null; turns: TranscriptItem[] }>({ conversationId: null, turns: [] });
  const projectFlowTimeline = useMemo(() => createFlowTimelineProjector(), []);
  const projection = useMemo(() => flowSnapshot?.conversationId === conversationId
    ? projectFlowTimeline(flowSnapshot, archivePayload.conversationId === conversationId ? archivePayload.turns : [])
    : { transcripts: [], leftoverTurns: 0, source: 'flow' as const }, [flowSnapshot, conversationId, archivePayload]);
  // 062：会话交付物投影（flow.artifacts → 预览 Tab 元数据与 ＋ 菜单候选）。
  const flowDeliverables = useMemo(() => {
    if (!flowSnapshot || flowSnapshot.conversationId !== conversationId) return null;
    const items = retainedDeliverables(flowSnapshot);
    if (!items.length) return null;
    return { conversationId: flowSnapshot.conversationId, generation: flowSnapshot.generation, items };
  }, [flowSnapshot, conversationId]);
  const transcripts = projection.transcripts;
  const transcriptsRef = useRef<TranscriptItem[]>([]);
  transcriptsRef.current = transcripts;
  const activeReply = transcripts.filter((item) => item.live && item.author === 'hemi');
  const streamingReply = activeReply.map((item) => item.text).join('\n\n');
  const streamingThinking = activeReply.flatMap((item) => item.parts ?? []).find((part) => part.type === 'thinking') ?? null;
  /** 024 消息编辑：当前原位编辑中的消息 id（null＝没有在编辑）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * 024 回卷剪除键（条目 id＋任务 taskId，当前会话累计）：随每次保存传主进程
   * 并入档案 cutKeys；也用于在视图侧抑制被剪任务卡/终态交代的重插。切会话时
   * 从载入的档案重播。
   */
  const cutKeysRef = useRef<Set<string>>(new Set());
  // 编辑中的消息被清场（切会话/新建/删除）时，编辑态一并失效。
  useEffect(() => {
    setEditingId((current) =>
      current && transcripts.some((item) => item.id === current) ? current : null,
    );
  }, [transcripts]);
  /** 015 会话：当前会话 id（null＝尚未落盘的新会话，首次发言时定 id）。 */
  const conversationIdRef = useRef<string | null>(null);
  /** 024 重构：会话 id 的响应式镜像（侧栏高亮用；ref 仍是权威）。 */
  /** 024 重构：顶栏会话标题（载入用档案标题；新会话首句话起名）。 */
  const [conversationTitle, setConversationTitle] = useState('新对话');
  /** 024：Call Dock 用户静音（true＝上行压制；与播报压制共用静音门载体）。 */
  const [callMuted, setCallMuted] = useState(false);
  const callMutedRef = useRef(false);
  /** 024：Call Dock 收起（压缩状态由顶栏 chip 承担）。 */
  const [dockCollapsed, setDockCollapsed] = useState(false);
  /**
   * 026 R-10：「继续讨论」闭环——详情已在 voice-screen 侧关闭，这里把任务级
   * 追问对象带给输入区（chip 可见、可移除）、空草稿播种提示、聚焦输入框。
   * 标题缺失回落任务原文；两者都没有就不播种（调用侧已按 taskId 门控按钮）。
   * 已有草稿一律保留，不覆盖。
   */
  const handleContinueDiscuss = useCallback((snap: TaskStateSnapshot) => {
    const title = snap.delivery?.title?.trim() || snap.taskText.trim();
    if (!title) return;
    setDiscussContext({ taskId: snap.taskId ?? '', title });
    setDraft((current) => (current.trim() ? current : `关于「${title}」，我想继续讨论：`));
    setComposerFocusToken((token) => token + 1);
  }, []);
  /** 015：启动种子化完成后才允许回写，避免空对话流覆盖上次会话。 */
  const [conversationReady, setConversationReady] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillMarketOpen, setSkillMarketOpen] = useState(false);
  // 059：工作流页（与技能中心平级）；新会话/切会话时收回。
  const [workflowStudioOpen, setWorkflowStudioOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  // 013：仅响应首位说话人（默认关；仅通话模式生效）。
  // 013：仅响应首位说话人（2026-09-20 用户裁决：默认开）。
  const [primarySpeakerEnabled, setPrimarySpeakerEnabled] = useState(true);
  const primarySpeakerEnabledRef = useRef(true);
  const primaryFilterRef = useRef(createPrimarySpeakerFilter());
  const [modelForm, setModelForm] = useState<TextModelConfigForm>({
    baseUrl: '',
    model: '',
    apiKey: '',
    hasApiKey: false,
    keyStoredSecurely: false,
    thinkingLevel: 'default',
    supportsVision: true,
    visionModel: '',
  });
  const [configForm, setConfigForm] = useState<ConfigForm>({
    apiKey: '',
    resourceId: DURATION_RESOURCE_ID,
    endpoint: DEFAULT_ENDPOINT,
    hasApiKey: false,
    keyStoredSecurely: false,
  });
  const [ttsForm, setTtsForm] = useState<TtsConfigForm>({
    ttsEnabled: true,
    ttsVoice: TTS_DEFAULT_VOICE,
    ttsResourceId: TTS_DEFAULT_RESOURCE_ID,
    hasApiKey: false,
    keyStoredSecurely: false,
  });
  /** 播报中（含试听）。悬浮窗「正在说话」由它驱动。 */
  const [ttsActive, setTtsActive] = useState(false);

  const activeRef = useRef(false);
  const sessionModeRef = useRef<ListenMode | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const speakingRef = useRef(false);
  // —— 对话回合（模型那一侧）——
  // 代次号：每次提交/作废递增，迟到的旧结果一律丢弃。
  const turnIdRef = useRef(0);
  const turnCounterRef = useRef(0);
  const viewEpochRef = useRef(0);
  const navigationSeqRef = useRef(0);
  const navigationTargetRef = useRef<string | null>(null);
  const attachedRequestRef = useRef<string | null>(null);
  const turnPhaseRef = useRef<TurnPhase>('idle');
  // 尚未提交的 ASR 定稿；正式上下文从同一 flow 投影读取。
  const speechHistoryRef = useRef<HistoryEntry[]>([]);
  const lastAsrProgressRef = useRef(0);
  const lastSubmitCountRef = useRef(0);
  useEffect(() => {
    if (!speechDeliveries.length || flowSnapshot?.conversationId !== conversationId) return;
    const delivered = speechDeliveries.filter(input => flowSnapshot.timeline.some(item => item.kind === 'user' && item.id === input.inputId)
      || flowSnapshot.pending.some(item => item.inputId === input.inputId));
    if (!delivered.length) return;
    speechAcceptedCountRef.current = Math.max(speechAcceptedCountRef.current, ...delivered.map(input => input.boundary));
    setSpeechDraftText(speechHistoryRef.current.slice(speechAcceptedCountRef.current).map(entry => entry.text).join('\n'));
    setSpeechDeliveries(current => current.filter(input => !delivered.some(done => done.inputId === input.inputId)));
  }, [flowSnapshot, conversationId, speechDeliveries]);
  const lastMessagesRef = useRef<Array<{ role: string; content: string }>>([]);
  /** 024：最近一次回合的输入来源（重试沿用失败回合的来源——文字重试不出声）。 */
  const lastInputSourceRef = useRef<InputSource>('voice');
  /** 024：文字草稿（收起/设置往返保留；新建/切换/删除当前会话清空；不跨重启）。 */
  const [composerDraft] = useState(createComposerDraft);
  const [queueEdit, setQueueEdit] = useState<{ conversationId: string; inputId: string; revision: number } | null>(null);
  const queueEditRef = useRef<typeof queueEdit>(null);
  const queueEditActionRef = useRef(false);
  const [queueEditSaving, setQueueEditSaving] = useState(false);
  const draftState = useSyncExternalStore(composerDraft.subscribe, composerDraft.getSnapshot);
  const { text: draft, attachments: draftAttachments, references: draftReferences, skills: draftSkills } = draftState;
  const { setText: setDraft, setAttachments: setDraftAttachments, setReferences: setDraftReferences, setSkills: setDraftSkills } = composerDraft;
  const submittingDraftsRef = useRef(new Set<number>());
  // 030：草稿归属会话——已存会话用 conversationId，新对话用固定 draft-new 槽。
  // 2026-10-06 用户裁决：点「新建对话」＝显式丢弃该槽——旧稿跨新建复活成
  // 「默认带一段内容」的僵尸草稿（实录：10-05 的未发送购机咨询跟了一天），
  // v1「未发送内容跨新建保留」口径退役；槽只在冷启动无会话时恢复（见启动段），
  // 未发送内容不因重启丢。输入防抖落盘；切换和卸载从草稿模型同步取快照冲刷，
  // 不依赖 React effect 更新后的 ref，队列编辑层也遵循同一卸载生命周期。
  const DRAFT_NEW_KEY = 'draft-new';
  const draftKeyRef = useRef(DRAFT_NEW_KEY);
  const draftRevisionRef = useRef(0);
  const draftLoadRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    draftRevisionRef.current += 1;
    const key = draftKeyRef.current;
    const revision = draftRevisionRef.current;
    // 063：标签身份（技能＋行内引用）与正文同批落盘，重启共同恢复。
    const snapshot = composerDraft.getPersistentSnapshot();
    const timer = window.setTimeout(() => {
      void window.hemiVoice?.saveDraft({
        conversationId: key, revision, text: snapshot.text,
        skills: snapshot.skills ?? [], references: snapshot.references ?? [],
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftState]);
  const flushDraft = useCallback(() => {
    draftRevisionRef.current += 1;
    const snapshot = composerDraft.getPersistentSnapshot();
    void window.hemiVoice?.saveDraft({
      conversationId: draftKeyRef.current,
      revision: draftRevisionRef.current,
      text: snapshot.text,
      skills: snapshot.skills ?? [],
      references: snapshot.references ?? [],
    });
  }, [composerDraft]);
  const loadDraftFor = useCallback((key: string) => {
    draftKeyRef.current = key;
    const version = composerDraft.getTextRevision();
    draftLoadRef.current = window.hemiVoice
      ?.getDraft(key)
      .then((stored) => {
        if (draftKeyRef.current !== key || composerDraft.getTextRevision() !== version) return;
        draftRevisionRef.current = Math.max(draftRevisionRef.current, stored?.revision ?? 0) + 1;
        setDraft(stored?.text ?? '');
        setDraftReferences(stored?.references ?? []);
        setDraftSkills(stored?.skills ?? []);
      })
      .catch(() => {}) ?? Promise.resolve();
  }, [composerDraft, setDraft, setDraftReferences, setDraftSkills]);
  /**
   * 新建对话的槽丢弃（2026-10-06 用户裁决）：不再恢复旧稿，槽清空。清空前
   * 先读存量、把全局 revision 顶过该槽已存版本——计数器随重启归零，低于存量
   * 的空存会被主进程单调守卫当迟到写入拒掉，槽清不干净。
   */
  const clearDraftFor = useCallback((key: string) => {
    draftKeyRef.current = key;
    setDraft('');
    setDraftReferences([]);
    setDraftSkills([]);
    void window.hemiVoice?.getDraft(key).then((stored) => {
      if (draftKeyRef.current !== key) return;
      draftRevisionRef.current = Math.max(draftRevisionRef.current, stored?.revision ?? 0) + 1;
      void window.hemiVoice?.saveDraft({ conversationId: key, revision: draftRevisionRef.current, text: composerDraft.getSnapshot().text });
    }).catch(() => {});
  }, [composerDraft, setDraft, setDraftReferences, setDraftSkills]);
  const leaveQueueEdit = useCallback((cancel = true) => {
    const editing = queueEditRef.current;
    if (!editing) return;
    queueEditRef.current = null;
    setQueueEdit(null);
    composerDraft.endQueueEdit();
    if (cancel) void window.hemiVoice?.flowCommand(editing.conversationId, { type: 'finishEditInput', inputId: editing.inputId, expectedEditRevision: editing.revision, cancel: true });
  }, [composerDraft]);
  /** 026 R-10：「继续讨论」带回的任务级追问对象（输入区 chip；发送/移除清除）。 */
  const [discussContext, setDiscussContext] = useState<{ taskId: string; title: string } | null>(null);
  /** 026 R-10：聚焦输入框的信号（递增触发 TextComposer focus）。 */
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  /**
   * 2026-09-28 用户裁决：新对话默认聚焦输入框。启动落地的就是新对话态
   * （无会话绑定），主界面首帧后聚焦一次，张开嘴即可打字；仅此一次——
   * 从设置页返回不算新对话，不重复抢焦点（TextComposer 只认 token 变化）。
   */
  const startupFocusDoneRef = useRef(false);
  useEffect(() => {
    if (startupFocusDoneRef.current || bootstrapping || setupRequired) return;
    startupFocusDoneRef.current = true;
    setComposerFocusToken((token) => token + 1);
  }, [bootstrapping, setupRequired]);
  const turnSilenceTimerRef = useRef<number | null>(null);
  // 回合静音判定的真实安静度：静音门开着＝用户还在出声。定时器到点时以此
  // 为准决定提交还是继续等（2026-09-20 毕加索对话：ASR 提前切断、下一句
  // partial 未到，定时器在用户仍在说话时抢跑提交，残句成回合、回复打断用户）。
  const voiceGateOpenRef = useRef(false);
  const replySettleTimerRef = useRef<number | null>(null);
  // —— 019 duplex 后端（通话模式：采集走 duplex:cap，播放走 duplexd）——
  /** 本会话是否 duplex 模式（getUserMedia/Web Audio 全停用，后端互斥）。 */
  const duplexModeRef = useRef(false);
  /** duplexd 是否正在出声：首个分片到达置位，drained/stopPlay 清零（barge-in 的 hasAudio）。 */
  const duplexPlayingRef = useRef(false);
  // —— 采集帧共享状态（浏览器 onaudioprocess 与 duplex cap 流两路同用）——
  /** 020 验收诊断：hold 上行帧统计（松手时打点，定位「没有新定稿」）。 */
  const holdFramesRef = useRef({ count: 0, bytes: 0 });
  const probeMsRef = useRef(0);
  const probeMaxRmsRef = useRef(0);
  const lastGateStateRef = useRef<boolean | null>(null);
  const lastSkippedSecondsRef = useRef(-1);
  const lastVisualChangeRef = useRef(0);
  const modelReadyRef = useRef(false);
  // —— TTS 播报（003）——
  // 播放器惰性创建：第一次播报时建 AudioContext（真实播放），
  // 测试与离线路径可以注入假上下文。
  const ttsPlayerRef = useRef<TtsPlayer | null>(null);
  const ttsSpeakRef = useRef<ActiveSpeak | null>(null);
  // barge-in 判定器：参数与状态都在 app/barge-in.ts 里维护，这里只喂帧和执行动作。
  const bargeInRef = useRef<BargeInController | null>(null);
  const ttsDuckReleaseTimerRef = useRef<number | null>(null);
  // 播报期间不打断回合静音计时——麦克风上行在压制中，时间线不属于对话回合。
  const ttsActiveRef = useRef(false);
  // 当前采集循环里的静音门：播报期间置 muted（上行压制），是 barge-in 的载体。
  const gateRef = useRef<SilenceGate | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const muteGainRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const isActive = sessionState === 'requesting' || sessionState === 'listening';
  const isCallActive = sessionMode === 'continuous';

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const updateConfigForm = useCallback((next: Partial<ConfigForm>) => {
    setConfigForm((current) => ({ ...current, ...next }));
  }, []);

  const stopAudioCapture = useCallback(() => {
    // 019：duplex 模式的拆除——关后端进程会话即可（无浏览器音频资源要清理）。
    if (duplexModeRef.current) {
      duplexModeRef.current = false;
      duplexPlayingRef.current = false;
      void window.hemiVoice?.stopDuplex?.();
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    sourceRef.current?.disconnect();
    sourceRef.current = null;
    muteGainRef.current?.disconnect();
    muteGainRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    speakingRef.current = false;
    setIsSpeaking(false);
    setVoiceGateOpen(false);
    voiceGateOpenRef.current = false;
    setSilenceSkippedSeconds(0);
    gateRef.current = null;
  }, []);

  const clearTurnTimers = useCallback(() => {
    if (turnSilenceTimerRef.current !== null) {
      window.clearTimeout(turnSilenceTimerRef.current);
      turnSilenceTimerRef.current = null;
    }
    if (replySettleTimerRef.current !== null) {
      window.clearTimeout(replySettleTimerRef.current);
      replySettleTimerRef.current = null;
    }
  }, []);

  /** 界面脱离请求，不撤销宿主中正在运行的原会话回合。 */
  const detachTurn = useCallback(() => {
    viewEpochRef.current += 1;
    attachedRequestRef.current = null;
    turnIdRef.current = ++turnCounterRef.current;

    clearTurnTimers();
  }, [clearTurnTimers]);

  /** 显式停止/结束通话/插话才撤销当前会话请求，迟到回执不能重开聆听。 */
  const invalidateTurn = useCallback(({ reason = 'stop' as 'stop' | 'preempt' } = {}) => {
    const runId = flowSnapshotRef.current?.activeRunId;
    if (runId && conversationIdRef.current) {
      void window.hemiVoice?.flowCommand(conversationIdRef.current, { type: 'stop', targetRunId: runId, reason }).catch(() => {});
    }
    detachTurn();
  }, [detachTurn]);

  /**
   * 055 R-06：播报回合出声用的「最新 startSpeakForTurn」——它定义在本组件更后
   * 面（依赖 TTS 侧的一串回调），先落 ref 再在定义处接上，采纳逻辑不与声明
   * 顺序耦合。
   */
  const speakForAnnounceRef = useRef<(turnId: number, text: string) => unknown>(() => {});
  const spokenRequestsRef = useRef(new Set<string>());

  /** 导航/重载后从宿主接回；后台完成只更新原会话，不触发语音。 */
  const adoptConversationTurn = useCallback((snapshot: ConversationTurnState | null) => {
    if (!snapshot || snapshot.conversationId !== conversationIdRef.current) return;
    if (snapshot.status === 'running') {
      attachedRequestRef.current = snapshot.requestId;
      turnIdRef.current = snapshot.turnId;
      turnCounterRef.current = Math.max(turnCounterRef.current, snapshot.turnId);

      turnPhaseRef.current = 'thinking';
      setTurnPhase('thinking');

      setTurnError('');
      return;
    }
    if (snapshot.result?.responseId) {
      const result = snapshot.result;
      // 057 S3：接回不再落 transcripts/history——条目由 flow 时间线派生（与直发/
      // 排队/停止同一管道）；本回调只保留接回流式与播报出声。
      // 056：主进程驱动的播报回合（后台子 agent 完成后唤醒主 agent 的转述）——按让位规则
      // 出声（语音任务才播，024 口径；与任务终态播报同款互斥）。
      if (
        !spokenRequestsRef.current.has(snapshot.requestId) &&
        (snapshot.announce || attachedRequestRef.current === snapshot.requestId) &&
        shouldAutoSpeak(result.inputSource) &&
        ttsForm.ttsEnabled &&
        ttsForm.hasApiKey &&
        !ttsActiveRef.current &&
        (snapshot.announce ? turnPhaseRef.current === 'idle' || turnPhaseRef.current === 'replying' : true)
      ) {
        spokenRequestsRef.current.add(snapshot.requestId);
        taskSpeakSeqRef.current -= 1; // 负代次，避开对话 turnId 序列
        void speakForAnnounceRef.current(taskSpeakSeqRef.current, result.speechText?.trim() || result.text);
      }
    } else if (snapshot.status === 'error') {
      // 057 S3：错误条目不再自造（失败事实进 flow notice part 派生）；只更新阶段与 toast。
    }
    attachedRequestRef.current = null;

    turnPhaseRef.current = snapshot.status === 'error' ? 'error' : 'idle';
    setTurnPhase(turnPhaseRef.current);
    setTurnError(snapshot.status === 'error' ? snapshot.error || '这次没能回应，请重试。' : '');
  }, [ttsForm.ttsEnabled, ttsForm.hasApiKey]);

  useEffect(() => window.hemiVoice?.onConversationTurn?.(adoptConversationTurn), [adoptConversationTurn]);

  // 055：startSpeakForTurn 定义后接上播报回合的出声口（ref 每轮渲染刷新为最新）。
  speakForAnnounceRef.current = (turnId, text) => startSpeakForTurn(turnId, text);

  /**
   * 029 R-01/02：停止当前模型回应——只取消本回合，不隐式停任务、不结束通话。
   * 先冻结已收到的增量（作为「已停止」的 Hemi 消息原位保留，不伪装成失败），
   * 再走针对性取消（invalidateTurn 的 cancel＋代次递增让迟到分片/回执全部作废）。
   */
  const handleStopModelTurn = useCallback(() => {
    if (turnPhaseRef.current !== 'thinking' && turnPhaseRef.current !== 'replying' && !flowRunActiveRef.current) return;
    const turnId = turnIdRef.current;
    const partial = transcriptsRef.current.filter((item) => item.live).map((item) => item.text).join('\n');
    // 057 S3：停止不再自造部分回复——运行收口时已收 parts 随 flow 时间线派生
    // 原位保留（标「已停止」）；流式缓冲在派生条目落地前继续显示，不闪空档。
    invalidateTurn();
    turnPhaseRef.current = 'idle';
    setTurnPhase('idle');
    setTurnError('');
    logChain(
      `stop → 模型（turn ${turnId}${partial.trim() ? `，已收 ${partial.length} 字随运行保留` : '，尚无增量'}；草稿与任务不动）`,
    );
  }, [invalidateTurn]);

  // —— TTS 播报（003）——

  const clearDuckReleaseTimer = useCallback(() => {
    if (ttsDuckReleaseTimerRef.current !== null) {
      window.clearTimeout(ttsDuckReleaseTimerRef.current);
      ttsDuckReleaseTimerRef.current = null;
    }
  }, []);

  /**
   * 播报期间的上行压制（方案 barge-in ①）：门照常判定，闭门帧不进云端 ASR——
   * Hemi 听不见自己。开门冲刷（确认打断）不受 muted 影响，话头照常上送。
   */
  const setGateMuted = useCallback((muted: boolean) => {
    // 024：用户静音是硬覆盖——播报解除压制后，静音中的通话仍不上行。
    if (gateRef.current) gateRef.current.muted = muted || callMutedRef.current;
  }, []);

  /**
   * 019 播放控制双后端：duplex 模式命令 duplexd（主进程直推链路），否则操作
   * 本地 Web Audio 播放器。duck/恢复/停播全走这里，两条路径行为一致。
   */
  const setPlaybackVolume = useCallback((gain: number) => {
    if (duplexModeRef.current) void window.hemiVoice?.duplexVolume?.(gain);
    else ttsPlayerRef.current?.setVolume(gain);
  }, []);

  const haltPlayback = useCallback(() => {
    if (duplexModeRef.current) {
      duplexPlayingRef.current = false;
      void window.hemiVoice?.duplexStopPlay?.();
    } else {
      ttsPlayerRef.current?.stopAll();
    }
  }, []);

  /** 停掉当前播报（若有）：掐主进程合成、停播放、解除 duck、落回 replying。 */
  const stopTtsPlayback = useCallback(
    (options?: { toReplying?: boolean }) => {
      const active = ttsSpeakRef.current;
      if (active) {
        window.hemiVoice?.cancelTts(active.turnId);
        ttsSpeakRef.current = null;
        setTtsActive(false);
        ttsActiveRef.current = false;
      }
      clearDuckReleaseTimer();
      haltPlayback();
      setPlaybackVolume(1);
      setGateMuted(false);
      if (options?.toReplying && turnPhaseRef.current === 'speaking') {
        turnPhaseRef.current = 'replying';
        setTurnPhase('replying');
        replySettleTimerRef.current = window.setTimeout(() => {
          replySettleTimerRef.current = null;
          if (turnPhaseRef.current === 'replying') {
            turnPhaseRef.current = 'idle';
            setTurnPhase('idle');
          }
        }, REPLY_SETTLE_MS);
      }
    },
    [clearDuckReleaseTimer, haltPlayback, setGateMuted, setPlaybackVolume],
  );

  /** 播放/合成结束（或不可用）后的统一落点：speaking → replying，settle 计时从这里起算。 */
  const settleReply = useCallback(() => {
    ttsSpeakRef.current = null;
    setTtsActive(false);
    ttsActiveRef.current = false;
    clearDuckReleaseTimer();
    setPlaybackVolume(1);
    setGateMuted(false);
    if (turnPhaseRef.current === 'speaking') {
      turnPhaseRef.current = 'replying';
      setTurnPhase('replying');
    }
    if (replySettleTimerRef.current === null) {
      replySettleTimerRef.current = window.setTimeout(() => {
        replySettleTimerRef.current = null;
        if (turnPhaseRef.current === 'replying') {
          turnPhaseRef.current = 'idle';
          setTurnPhase('idle');
        }
      }, REPLY_SETTLE_MS);
    }
  }, [clearDuckReleaseTimer, setGateMuted, setPlaybackVolume]);

  /**
   * 播放排空（自然播完）的统一落点：Web Audio 播放器的 onDrained 与 019 duplex
   * 的 drained 事件都进这里——失败不叠加、合成未完等 finished、否则结算回 replying。
   */
  const handlePlaybackDrained = useCallback(() => {
    const active = ttsSpeakRef.current;
    if (active?.failed) {
      // 失败时已由 tts:state 落回 replying，这里不再叠加。
      ttsSpeakRef.current = null;
      setTtsActive(false);
      ttsActiveRef.current = false;
      return;
    }
    if (active) {
      if (!active.synthDone) {
        // 合成还在继续（服务端没发完）：等 tts:state finished 再结算。
        return;
      }
      logChain(`tts ${active.turnId} 播放完毕`);
    }
    settleReply();
  }, [settleReply]);

  /** 惰性创建播放器：挂在主输出上，排空（自然播完）即落回 replying（duplex 模式不创建）。 */
  const ensureTtsPlayer = useCallback(() => {
    if (ttsPlayerRef.current) return ttsPlayerRef.current;
    // Match PCM rate: resampling each short BufferSource independently can
    // introduce discontinuities at chunk boundaries.
    const player = new TtsPlayer(new AudioContext({ sampleRate: TTS_SAMPLE_RATE }), {
      sampleRate: TTS_SAMPLE_RATE,
      onUnderrun: (gapMs) => voiceLog.warn(`tts 播放断流 ${Math.round(gapMs)}ms`),
      onDrained: () => handlePlaybackDrained(),
    });
    ttsPlayerRef.current = player;
    return player;
  }, [handlePlaybackDrained]);

  /** 惰性创建 barge-in 判定器（app/barge-in.ts，纯状态机）。 */
  const ensureBargeIn = useCallback(() => {
    if (!bargeInRef.current) bargeInRef.current = new BargeInController();
    return bargeInRef.current;
  }, []);

  /** 请求主进程合成整句并接管播放；失败回退 002 形态（字幕仍在，叠加错误提示）。 */
  const startSpeakForTurn = useCallback(
    async (turnId: number, text: string) => {
      stopTtsPlayback();
      if (!ttsForm.ttsEnabled || !ttsForm.hasApiKey) {
        // 静默降级为 002 形态：不报错，只是不说话。
        settleReply();
        return;
      }
      const clipped = text.slice(0, TTS_MAX_TEXT_CHARS);
      const active: ActiveSpeak = {
        turnId,
        kind: 'turn',
        synthDone: false,
        failed: false,
        failureMessage: '',
        receivedBytes: 0,
      };
      ttsSpeakRef.current = active;
      ttsActiveRef.current = true;
      setTtsActive(true);
      turnPhaseRef.current = 'speaking';
      setTurnPhase('speaking');

      setGateMuted(true);
      ensureBargeIn().reset();
      // 019：duplex 模式音频由主进程直推 duplexd，不建 Web Audio 上下文；
      // 新一轮播报从「未出声」起算（首个分片元数据到达再置位）。
      duplexPlayingRef.current = false;
      let result;
      try {
        if (!duplexModeRef.current) await ensureTtsPlayer().resume();
        if (ttsSpeakRef.current !== active) return;
        result = await window.hemiVoice?.speakTts({ turnId, text: clipped });
      } catch (error) {
        result = { ok: false, message: messageFromError(error, '播放失败。') };
      }
      // A cancelled handshake can finish after the replacement has begun.
      if (ttsSpeakRef.current !== active) return;
      if (!result?.ok) {
        voiceLog.warn(`tts ${turnId} 不可用：${result?.message ?? '请求失败'}`);
        setTurnError(`这条没能念出来：${result?.message ?? '请求失败'}`);
        haltPlayback();
        settleReply();
        return;
      }
    },
    [ensureBargeIn, ensureTtsPlayer, haltPlayback, setGateMuted, settleReply, stopTtsPlayback, ttsForm],
  );

  // ---- 004 任务面：订阅主进程快照；终态结果入史并按通话状态播报 ----
  const [taskState, setTaskState] = useState<TaskStateSnapshot | null>(null);
  const taskStateSeqRef = useRef(0);
  const taskSpeakSeqRef = useRef(0);

  useEffect(() => {
    const apply = (snap: TaskStateSnapshot) => {
      if (!snap || typeof snap.seq !== 'number') return;
      // 顶层 stateSeq 是广播版本；seq 仅是任务身份序号。旧版本/历史 fixture
      // 没有 stateSeq 时回退到 seq，保持兼容。
      const stateSeq = typeof snap.stateSeq === 'number' ? snap.stateSeq : snap.seq;
      if (stateSeq < taskStateSeqRef.current) {
        voiceLog.debug(`丢弃旧任务快照 v${stateSeq}（当前 v${taskStateSeqRef.current}）`);
        return;
      }
      taskStateSeqRef.current = stateSeq;
      voiceLog.debug(
        `接收任务快照 v${stateSeq}：${(snap.tasks ?? [])
          .map((task) => `${task.key ?? '?'}=${task.phase}`)
          .join(',') || 'idle'}`,
      );
      setTaskState(snap);
    };
    void window.hemiVoice?.getTaskState().then(apply).catch(() => {});
    const off = window.hemiVoice?.onTaskState(apply);
    return () => off?.();
  }, []);

  const cardKeyOf = (snap: TaskStateSnapshot) => snap.taskId ?? snap.key ?? `s${snap.seq}`;
  const [frozenTasks, setFrozenTasks] = useState<Record<string, TaskStateSnapshot>>({});
  useEffect(() => {
    const bundle = taskState;
    if (!bundle?.tasks?.length) return;
    for (const snap of bundle.tasks) {
      if (snap.phase !== 'terminal') continue;
      const key = cardKeyOf(snap);
      setFrozenTasks((prev) => (prev[key] === snap ? prev : { ...prev, [key]: snap }));
    }
  }, [taskState]);

  /** 对话流任务卡用的快照表：活跃任务实时、历史任务冻结。 */
  const taskSnaps = useMemo(() => {
    const merged = { ...frozenTasks };
    for (const snap of taskState?.tasks ?? []) {
      if (snap.key) merged[cardKeyOf(snap)] = snap;
    }
    return merged;
  }, [frozenTasks, taskState]);

  const applyConversationProfile = useCallback((profileId: string | null | undefined) => {
    const next = typeof profileId === 'string' && profileId ? profileId : null;
    conversationProfileRef.current = next;
    setConversationProfileId(next);
    // 057 S3-2d：会话选择的模型元数据随变更轻保存（专用通道只动元数据——
    // 旧 saveConversation 的 turns 是权威整表语义，空表会把档案清空）。
    const conversationId = conversationIdRef.current;
    if (conversationId) {
      void window.hemiVoice?.flowSaveMetadata({ conversationId, profileId: next }).catch(() => {});
    }
  }, []);

  /**
   * 2026-10-08 用户反馈：每次新建对话，模型选择都被重置回默认（DeepSeek 等），
   * 想要「优先用上次的配置」。这里把上次选择（模型键或 'auto'）记进模型目录
   * 文件（主进程校验失效即清空）；旧档 null＝从未选过，不清掉既有记录。
   * 同步并进目录 ref 镜像——恢复逻辑不等落盘回执，选完立刻新建也要能读到。
   */
  const rememberLastConversationModel = useCallback((profileId: string | null | undefined) => {
    if (!profileId) return;
    if (modelProfilesRef.current) {
      modelProfilesRef.current = { ...modelProfilesRef.current, lastConversationModelKey: profileId };
    }
    // dev 热更新窗口可能新渲染层配旧 preload（缺这个方法）——取不到回执就跳过。
    const receipt = window.hemiVoice?.setLastConversationModel?.(profileId);
    if (receipt) void receipt.catch(() => {});
  }, []);

  // ---- 033 工作区：登记状态与会话绑定 ----
  /** 登记状态（默认工作区 + 项目列表；主进程实时探测可用性）。 */
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  /** 同步镜像：发送守卫在回调里要立刻读到当前视图（不等渲染帧）。 */
  const workspaceStateRef = useRef<WorkspaceState | null>(null);
  // 016→037：对话内记忆提示（R-14，可见不播报）——「记住了：…」/「已忘记：…」+ 查看 / 撤销，
  // 由 MemoryChangedEvent 驱动；新回合开始或切会话时清掉。
  const memoryNotices = useMemoryNotices({
    scopeLabelOf: (scopeKey) => memoryScopeLabel(scopeKey, workspaceStateRef.current),
    onOpenMemoryPage: async () => {
      if(!await confirmWorkflowLeave())return;
      setSettingsTarget({ page: 'memory' });
      setSettingsOpen(true);
    },
    currentConversationId: () => conversationIdRef.current,
  });
  const clearMemoryNotices = memoryNotices.clear;
  useEffect(() => {
    clearMemoryNotices();
  }, [conversationId, clearMemoryNotices]);
  /**
   * 当前会话绑定的工作区身份：'default' / 'ws-…'；null＝旧会话（033 前建档，
   * 任务继续按家目录语义执行）。ref 权威，state 是侧栏/上下文栏的镜像。
   * 初值 'default'：启动落在新对话态（R-01），载入会话时再被真实绑定覆盖。
   */
  const conversationWorkspaceRef = useRef<string | null>('default');
  const [conversationWorkspaceId, setConversationWorkspaceId] = useState<string | null>('default');

  const refreshWorkspaceState = useCallback(async () => {
    try {
      const next = (await window.hemiVoice?.getWorkspaceState()) ?? null;
      workspaceStateRef.current = next;
      setWorkspaceState(next);
    } catch {
      /* 登记暂不可读时保留现状（上下文栏只读展示） */
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaceState();
    // 窗口重新聚焦时对齐一次可用性（外接盘挂载状态可能变化，不逐条订阅）。
    const reloadOnFocus = () => void refreshWorkspaceState();
    window.addEventListener('focus', reloadOnFocus);
    return () => window.removeEventListener('focus', reloadOnFocus);
  }, [refreshWorkspaceState]);

  const applyConversationWorkspace = useCallback((workspaceId: string | null) => {
    const next = typeof workspaceId === 'string' && workspaceId ? workspaceId : null;
    conversationWorkspaceRef.current = next;
    setConversationWorkspaceId(next);
  }, []);

  /**
   * 当前绑定对应的视图（上下文栏与发送守卫共用）：'default'／项目 id 命中
   * 登记表；null＝旧会话（家目录语义，由调用方按 legacy 展示）。
   */
  const workspaceCurrentView = useMemo(() => {
    const id = conversationWorkspaceId;
    if (!id || !workspaceState) return null;
    if (id === workspaceState.default.id) return workspaceState.default;
    return workspaceState.projects.find((item) => item.id === id) ?? null;
  }, [conversationWorkspaceId, workspaceState]);

  /** R-07：绑定的目录不可用 → 禁发（旧会话 null 不拦，家目录语义不受影响）。 */
  const workspaceMissing = Boolean(conversationWorkspaceId) && workspaceCurrentView?.status === 'missing';
  const workspaceMissingRef = useRef(false);
  useEffect(() => {
    workspaceMissingRef.current = workspaceMissing;
  }, [workspaceMissing]);

  const bindWorkspace = useCallback(
    (id: string | null) => {
      applyConversationWorkspace(id);
      // 已落盘的会话立即持久化（不等防抖）；纯草稿随首回合的 payload 冻结。
      const conversationId = conversationIdRef.current;
      if (conversationId) {
        void window.hemiVoice
          ?.flowSaveMetadata({ conversationId, workspaceId: id })
          .catch(() => {});
      }
    },
    [applyConversationWorkspace],
  );

  /**
   * 033 R-02（2026-10-01 用户裁决：已有会话也支持原地绑定）：选工作区＝改绑
   * 当前会话，草稿与对话流不动；只影响接下来的任务——已受理任务按受理时冻结的
   * 快照执行（R-03），不因改绑改道。
   * 049：选中远端项目时主动探测一次连接（技术方案：选中/发送前/重试时探测），
   * 结果落状态缓存——连不上时芯片立即标警示、发送被禁（R-09）。
   */
  const handleWorkspaceSelect = useCallback(
    (id: string) => {
      bindWorkspace(id);
      logChain(`工作区切换 → ${id}（本会话接下来的任务生效）`);
      const view = workspaceStateRef.current?.projects.find((item) => item.id === id);
      if (view?.host) {
        void window.hemiVoice
          ?.probeRemoteWorkspace?.(id)
          .then((result) => {
            if (result?.state) {
              workspaceStateRef.current = result.state;
              setWorkspaceState(result.state);
            }
          })
          .catch(() => {});
      }
    },
    [bindWorkspace],
  );

  const handleWorkspaceClear = useCallback(() => {
    bindWorkspace('default');
    logChain('撤销项目指定，回到默认空间');
  }, [bindWorkspace]);

  /** 049 R-09：「重试连接」——重新探测登记的远端项目并刷新状态（恢复即可发送）。 */
  /**
   * 049 R-09：「重试连接」——重新探测登记的远端项目并刷新状态（恢复即可发送）。
   * 认证失败（本机无免密密钥/密码失效）→ 弹密码重输，带密码再探（2026-10-12
   * 用户裁决支持密码登录；密码只进主进程内存，不落盘）。
   */
  const [remotePasswordFor, setRemotePasswordFor] = useState<{ id: string; host: string } | null>(null);
  const [remotePasswordBusy, setRemotePasswordBusy] = useState(false);
  const handleWorkspaceRetryRemote = useCallback(async (id: string, password?: string, remember?: boolean) => {
    try {
      const result = await window.hemiVoice?.probeRemoteWorkspace?.(id, password, remember);
      if (result?.state) {
        workspaceStateRef.current = result.state;
        setWorkspaceState(result.state);
      }
      logChain(result?.ok ? `连接恢复：${result.state?.projects.find((item) => item.id === id)?.host ?? id}` : `仍连不上：${result?.message ?? '未知原因'}`);
      if (!result?.ok && result?.kind === 'auth' && result.canPassword && !password) {
        const host = result.state?.projects.find((item) => item.id === id)?.host
          ?? workspaceStateRef.current?.projects.find((item) => item.id === id)?.host
          ?? '服务器';
        setRemotePasswordFor({ id, host });
      }
      return result;
    } catch {
      /* 探测失败保留现状（提示条仍在，可再重试） */
      return null;
    }
  }, []);
  const submitRemotePassword = useCallback(async (password: string, remember: boolean) => {
    const target = remotePasswordFor;
    if (!target) return;
    setRemotePasswordBusy(true);
    try {
      const result = await handleWorkspaceRetryRemote(target.id, password, remember);
      if (result?.ok) setRemotePasswordFor(null);
    } finally {
      setRemotePasswordBusy(false);
    }
  }, [remotePasswordFor, handleWorkspaceRetryRemote]);

  const handleWorkspacePickFolder = useCallback(async () => {
    const result = await window.hemiVoice?.addWorkspaceFolder();
    if (!result) return;
    if (result.state) {
      workspaceStateRef.current = result.state;
      setWorkspaceState(result.state);
    }
    if (!result.ok) {
      if (!result.cancelled) logChain(`项目目录添加失败：${result.reason ?? '未知原因'}`);
      return;
    }
    const added = result.workspace;
    if (added) {
      bindWorkspace(added.id);
      logChain(`项目已指定 → ${added.name}（本会话接下来的任务生效）`);
    }
  }, [bindWorkspace]);

  /**
   * 049：「服务器上的文件夹…」添加成功——先落主进程随登记返回的最新状态再绑定。
   * 此前只递 workspace 丢掉 state，页面旧列表查不到新 id，芯片落「已移除的项目」
   * 兜底、发送被禁（2026-10-12 用户真机钓出）；对齐 handleWorkspacePickFolder
   * 的形状。刚 probe 通过才登记，这里无需再探测。
   */
  const handleRemoteAdded = useCallback(
    (workspace: WorkspaceView, state: WorkspaceState | null) => {
      if (state) {
        workspaceStateRef.current = state;
        setWorkspaceState(state);
      }
      bindWorkspace(workspace.id);
      logChain(
        `项目已指定 → ${workspace.name}${workspace.host ? ` · ${workspace.host}` : ''}（本会话接下来的任务生效）`,
      );
    },
    [bindWorkspace],
  );

  const handleWorkspaceRemove = useCallback(
    async (id: string) => {
      const result = await window.hemiVoice?.removeWorkspace(id);
      if (result?.state) {
        workspaceStateRef.current = result.state;
        setWorkspaceState(result.state);
      }
      // 移除的是当前绑定 → 回默认工作区（不静默改道到别的项目，R-02/R-07）。
      if (conversationWorkspaceRef.current === id) bindWorkspace('default');
    },
    [bindWorkspace],
  );

  /**
   * 015：把会话全文铺回对话流（启动种子化与历史列表载入共用）——
   * 任务卡按 taskSnap 重建冻结快照，LLM 上下文从 turns 重建（D-7 续聊不断档）。
   */
  const applyConversationSession = useCallback((session: ConversationSession) => {
    leaveQueueEdit();
    const raw = Array.isArray(session.turns) ? session.turns : [];
    conversationIdRef.current = session.id;
    // 048：切到目标会话就重取它的用量账本（任务执行部分主进程现场汇总）。
    setUsageRecords([]);
    void window.hemiVoice?.getUsageLedger(session.id)
      .then((view) => {
        if (conversationIdRef.current === session.id) setUsageRecords(view?.records ?? []);
      })
      .catch(() => { /* 账本读取失败不阻断对话，入口保持旧值 */ });
    setConversationId(session.id);
    setConversationTitle(session.title || '已载入会话');
    // 031：会话重开仍显示自己的模型选择（旧档无选择＝默认组）。
    applyConversationProfile(session.profileId);
    // 2026-10-08：打开/继续的会话就算「上次使用的配置」——紧跟着新建对话
    // 沿用它，而不是被打回默认模型。
    rememberLastConversationModel(session.profileId);
    // 033：会话重开恢复自己的工作区绑定（旧档 null＝家目录语义，只读展示）。
    applyConversationWorkspace(session.workspaceId ?? null);
    // 030 R-01：切走前冲刷旧会话草稿，目标会话恢复自己的未发送草稿。
    flushDraft();
    loadDraftFor(session.id);
    // 028 R-01：切换会话清空草稿附件（不静默携带到目标会话）；已发送附件的
    // 元数据随会话 turns 回流（历史 chip 仍可预览）。
    setDraftAttachments([]);
    // 卡身份：taskId（2026-09-23 唯一标识收敛）；载入旧会话后允许接收当前主进程
    // 的状态版本（stateSeq 归零只用于解除旧渲染状态的门槛）。存量档案在旧 bug
    // 期间可能存了重复卡（渲染层重载后整批重插）——按 taskId 去重，留第一张。
    // 024 回卷：档案 cutKeys 一并重播——被剪任务卡不重插、其终态交代不回视图。
    const frozen: Record<string, TaskStateSnapshot> = {};
    const keys = new Set<string>();
    const seenTaskIds = new Set<string>();
    cutKeysRef.current = new Set(
      (Array.isArray(session.cutKeys) ? session.cutKeys : []).filter((key) => typeof key === 'string' && key),
    );
    for (const key of cutKeysRef.current) keys.add(key);
    const turns: TranscriptItem[] = [];
    for (const item of raw) {
      if (item?.kind === 'task' && typeof item.taskSeq === 'number') {
        if (item.taskFrozen) { turns.push(item); continue; }
        const id = item.taskId ?? item.taskSnap?.taskId ?? item.taskKey ?? item.taskSnap?.key ?? `s${item.taskSeq}`;
        if (seenTaskIds.has(id)) continue;
        seenTaskIds.add(id);
        keys.add(id);
        if (item.taskSnap) frozen[id] = item.taskSnap;
      }
      turns.push(item);
    }
    taskStateSeqRef.current = 0;
    setFrozenTasks(frozen);
    // 057 S3-2：对话流骨架切 flow 时间线——turns 只作载荷源（附件 chips／任务卡
    // 全量快照／思考时长／用量／可编辑 ID 按序 zip 进来），首帧投影在 flow 快照
    // 到达时落地；加载投影完成前不触发空轮保存。
    setArchivePayload({ conversationId: session.id, turns });
    speechHistoryRef.current = [];
    lastSubmitCountRef.current = 0;
    speechAcceptedCountRef.current = 0;
    setSpeechDraftText('');
    setSpeechDeliveries([]);
    lastMessagesRef.current = [];
    const epoch = viewEpochRef.current;
    void window.hemiVoice?.getConversationTurn?.(session.id).then((snapshot) => {
      if (epoch === viewEpochRef.current && conversationIdRef.current === session.id) adoptConversationTurn(snapshot);
    }).catch(() => {});
  }, [adoptConversationTurn, applyConversationProfile, applyConversationWorkspace, flushDraft, loadDraftFor, rememberLastConversationModel, leaveQueueEdit]);

  // 057 S3-2d：周期性全量 turns 保存退役——用户轮（宿主 input-delivered 落档）、
  // 回复轮（persistReply）、任务轮（task.ipc 快照广播落档）都已是宿主事实；渲染层
  // 只保留提交时保存（新会话建档＋profile/workspace 持久化＋024 回卷 cutKeys 通路）。
  // transcripts/taskSnaps 的中间态不再整表回写（不再覆盖宿主事实）。

  const handleTaskAction = useCallback(
    (action: TaskActionName, payload?: { choice?: TaskPermissionChoice; taskId?: string; taskKey?: string }) => {
      void window.hemiVoice?.taskAction(action, payload);
    },
    [],
  );

  // ---- 008 当前工作上下文：来源条状态与附加/刷新/移除 ----
  const [contextState, setContextState] = useState<WorkContextState>({ objects: [] });
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState('');
  const contextErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 028 本条消息附件：草稿登记与提交冻结 ----
  // 草稿附件只属于当前会话（切换/新建/载入即清空准备区）；发送时冻结进
  // TranscriptItem（历史回看与重试共用同一 attachmentId 身份），主进程
  // markSent 后登记列表不再返回它们。
  const flashAttachError = useCallback((message: string) => {
    setAttachError(message);
    if (attachErrorTimerRef.current) clearTimeout(attachErrorTimerRef.current);
    attachErrorTimerRef.current = setTimeout(() => setAttachError(''), 6000);
  }, []);

  const [attachError, setAttachError] = useState('');
  const attachErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最近一次提交携带的附件（失败重试按原身份重发）。 */
  const lastAttachmentIdsRef = useRef<string[]>([]);
  /** 057 S3-2：同一份冻结视图（重试随消息进 flow 用户项）。 */
  const lastAttachmentViewsRef = useRef<MessageAttachmentView[]>([]);
  // 028 二批：`@` 引用芯片（草稿态；发送冻结进消息）。

  const lastReferencesRef = useRef<MessageReferenceView[]>([]);

  // 063：显式技能标签（草稿态；发送随消息冻结，派发时主进程校验可用性）。

  const lastSkillsRef = useRef<SkillSelectionView[]>([]);

  const handleAddReference = useCallback((candidate: MessageReferenceView) => {
    setDraftReferences((current) =>
      current.some((item) => item.key === candidate.key) ? current : [...current, candidate],
    );
  }, []);

  const handleRemoveReference = useCallback((key: string) => {
    setDraftReferences((current) => current.filter((item) => item.key !== key));
  }, []);

  // 029 P2／056 修订／057 S2：待发送队列改从 flow 快照派生（单一事实源，
  // queue:push 事件翻译层退役）；动作（入队/编辑/撤回/并入/恢复）仍走 queue:*
  // 命令——主进程那边已是控制器命令。
  // bug#12 防御层：busy 以 flow 运行事实兜底（主进程发起的回合不再依赖单次广播采纳）。
  const modelBusy = deriveModelBusy({ turnPhase, flowPhase: flowSnapshot?.phase ?? null });
  const flowRunActiveRef = useRef(false);
  // flow 相位的同步镜像：提交入口（文字/语音定稿）的入队判定要在回调里读到
  // 最新相位，不等下一次渲染（2026-10-16 会话审计 A1）。
  const flowPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    flowRunActiveRef.current = flowSnapshot?.phase === 'preparing' || flowSnapshot?.phase === 'running' || flowSnapshot?.phase === 'stopping';
    flowPhaseRef.current = flowSnapshot?.phase ?? null;
  }, [flowSnapshot?.phase]);
  // 060 S1：待发送区（flow.pending）是未派发输入的唯一展示位——乐观上屏机制退役
  //（060 技术方案「必须退役或改写的规则」：未派发消息先写 transcripts／history、
  //  再由乐观 ID 隐藏队列）。

  const queueState: TurnQueueState = useMemo(() => ({
    paused: flowSnapshot?.queuePaused ?? false,
    // 060 R-04：待发送区＝未派发普通输入的唯一展示位（pending 与待核对全量显示；
    // 派发提交时按同一 inputId 转正进正式流，见投影分支）。
    items: (flowSnapshot?.pending ?? [])
      .filter((input) => input.state === 'pending' || input.state === 'needs-review' || input.state === 'editing')
      .map((input) => ({
        queueItemId: input.inputId,
        readOnly:Boolean(input.workflow),
        conversationId: conversationId ?? '',
        text: input.text,
        revision: (input.editRevision ?? 0) + 1,
        dispatchState: input.state === 'editing' ? 'editing' as const : input.promoteAt != null ? 'promoting' as const : 'pending' as const,
        error: input.state === 'needs-review' ? '投递结果不明，待核对' : '',
        attachmentIds: input.attachmentIds ?? [],
        references: (input as { references?: MessageReferenceView[] }).references ?? [],
        skills: (input as { skills?: SkillSelectionView[] }).skills ?? [],
        inputSource: input.inputSource ?? 'text',
        createdAt: input.createdAt ?? 0,
      })),
  }), [flowSnapshot, conversationId]);

  // 2026-10-18 用户裁决：手动停止后没有新任务（收口且队列为空）＝输入框上方
  // 只放一个「继续任务」按钮，不出「待发送消息（0）」空托盘。
  const queueStoppedIdle = (flowSnapshot?.phase ?? 'idle') === 'idle'
    && (flowSnapshot?.queuePaused ?? false)
    && (flowSnapshot?.pending ?? []).length === 0;

  const handleEditQueued = useCallback(async (inputId: string) => {
    const cid = conversationIdRef.current;
    if (!cid || queueEditRef.current || queueEditActionRef.current) return;
    queueEditActionRef.current = true;
    try {
      await draftLoadRef.current;
      if (conversationIdRef.current !== cid) return;
      const result = await window.hemiVoice?.flowCommand(cid, { type: 'beginEditInput', inputId });
      if (!result?.ok || !result.input) throw new Error('这条消息已经开始发送，或暂时无法编辑。');
      const input = result.input;
      if (conversationIdRef.current !== cid) {
        void window.hemiVoice?.flowCommand(cid, { type: 'finishEditInput', inputId, cancel: true });
        return;
      }
      const saved = input.editDraft ?? input;
      const refs = (saved.references ?? []).map((ref: MessageReferenceView, index: number) => ({ ...ref, key: ref.key ?? `retained-${index}`, name: ref.name ?? '保留的引用', subtitle: ref.subtitle ?? '' }));
      const skillTags = (saved.skills ?? []).map((skill: SkillSelectionView) => ({ ...skill, token: skill.token || skill.name }));
      composerDraft.beginQueueEdit({ text: saved.text, attachments: saved.attachmentViews ?? [], references: refs, skills: skillTags }, input.editDraftRevision ?? 0);
      const editing = { conversationId: cid, inputId, revision: input.editRevision };
      queueEditRef.current = editing;
      setQueueEdit(editing);
      setComposerFocusToken((value) => value + 1);
    } catch (error) { flashAttachError(error instanceof Error ? error.message : String(error)); }
    finally { queueEditActionRef.current = false; }
  }, [composerDraft, flashAttachError]);

  const flushQueueEditDraft = useCallback(() => {
    const editing = queueEditRef.current;
    if (!editing) return;
    const current = composerDraft.getSnapshot();
    void window.hemiVoice?.flowCommand(editing.conversationId, {
      type: 'saveInputEditDraft', inputId: editing.inputId, draftRevision: current.revision,
      patch: { text: current.text, attachmentIds: current.attachments.map((item) => item.attachmentId), attachmentViews: current.attachments, references: current.references, skills: current.skills },
    }).then((result) => {
      if (!result.ok && queueEditRef.current === editing) flashAttachError('编辑草稿暂未保存，请重试保存修改。');
    }).catch(() => {});
  }, [composerDraft, flashAttachError]);

  useEffect(() => {
    if (!queueEdit || queueEditSaving) return;
    const timer = window.setTimeout(flushQueueEditDraft, 300);
    return () => window.clearTimeout(timer);
  }, [draftState, queueEdit, queueEditSaving, flushQueueEditDraft]);

  useEffect(() => {
    const flushBeforeUnload = () => { flushDraft(); flushQueueEditDraft(); };
    window.addEventListener('beforeunload', flushBeforeUnload);
    return () => window.removeEventListener('beforeunload', flushBeforeUnload);
  }, [flushDraft, flushQueueEditDraft]);

  const saveQueueEdit = useCallback(async () => {
    const editing = queueEditRef.current;
    if (!editing || queueEditActionRef.current) return;
    queueEditActionRef.current = true;
    setQueueEditSaving(true);
    const current = composerDraft.getSnapshot();
    try {
      const result = await window.hemiVoice?.flowCommand(editing.conversationId, {
        type: 'finishEditInput', inputId: editing.inputId, expectedEditRevision: editing.revision,
        patch: { text: current.text, attachmentIds: current.attachments.map((item) => item.attachmentId), attachmentViews: current.attachments, references: current.references, skills: current.skills },
      });
      if (!result?.ok) throw new Error(result?.message ?? '修改没有保存，请重试。');
      if (queueEditRef.current === editing) leaveQueueEdit(false);
    } catch (error) { flashAttachError(error instanceof Error ? error.message : String(error)); }
    finally { queueEditActionRef.current = false; setQueueEditSaving(false); }
  }, [composerDraft, leaveQueueEdit, flashAttachError]);

  /** 056 修订：撤回排队条目——排队消息不在对话流里，队列行消失（queue:state
   *  广播）即反馈，对话流无需改动。 */
  /** 060 R-21：显式插队——让该条优先（宿主保存优先关系后停止旧目标，确认后优先派发）。 */
  const handlePromoteQueued = useCallback(async (queueItemId: string) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId || !window.hemiVoice) return;
    try {
      const result = await window.hemiVoice.promoteTurnQueueItem({ conversationId, queueItemId });
      if (!result?.ok) { flashAttachError(result?.message ?? '优先处理失败'); return; }
      logChain(`优先处理 ${queueItemId}（${result.disposition ?? '?'}）`);
    } catch (error) {
      flashAttachError(error instanceof Error ? error.message : String(error));
    }
  }, [flashAttachError]);

  const handleReorderQueued = useCallback(async (inputId: string, overInputId: string, expectedInputIds: string[]) => {
    const cid = conversationIdRef.current;
    if (!cid || !window.hemiVoice) return;
    try {
      const result = await window.hemiVoice.flowCommand(cid, { type: 'reorderInput', inputId, overInputId, expectedInputIds });
      if (!result.ok) {
        const message = result.code === 'storage-failed' ? '顺序已调整，但暂未保存，请重试。'
          : result.code === 'locked' ? '编辑或等待交接的消息不能被移过。' : '队列已变化，请按当前顺序重新拖动。';
        flashAttachError(message);
      }
    } catch (error) { flashAttachError(error instanceof Error ? error.message : String(error)); }
  }, [flashAttachError]);

  const handleWithdrawQueued = useCallback(async (queueItemId: string) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId || !window.hemiVoice) return;
    try {
      const result = await window.hemiVoice.withdrawTurnQueueItem({ conversationId, queueItemId });
      if (!result?.ok) { flashAttachError(result?.message ?? '没有撤回成功'); return; }
      // 060 R-06：撤回只操作该身份——待发送区行消失（flow 快照驱动），正式流无需改动。
      logChain(`撤回排队 ${queueItemId}`);
    } catch (error) {
      flashAttachError(error instanceof Error ? error.message : String(error));
    }
  }, [flashAttachError]);

  // ---- 031 多组模型配置：目录与当前会话选择 ----
  const [modelProfiles, setModelProfiles] = useState<ModelProfilesDirectory | null>(null);
  /** 同步镜像：新建对话的恢复逻辑在回调里要立刻读到当前目录（不等渲染帧）。 */
  const modelProfilesRef = useRef<ModelProfilesDirectory | null>(null);
  /** 当前会话选中的配置组（null＝默认组；随会话存档持久化）。 */
  const [conversationProfileId, setConversationProfileId] = useState<string | null>(null);
  const conversationProfileRef = useRef<string | null>(null);

  const reloadModelProfiles = useCallback(async () => {
    try {
      const next = await window.hemiVoice?.listModelProfiles();
      if (next) {
        modelProfilesRef.current = next;
        setModelProfiles(next);
      }
    } catch {
      /* 目录暂不可读时保留空态，选择器隐藏 */
    }
  }, []);

  useEffect(() => {
    void reloadModelProfiles();
  }, [reloadModelProfiles]);
  /** 032：设置关闭后回读真实状态——模型就绪/ASR 修复提示按实际情况收敛。 */
  const refreshReadinessAfterSettings = useCallback(async () => {
    const bridge = window.hemiVoice;
    if (!bridge) return;
    try {
      const modelConfig = await bridge.getTextModelConfig();
      setModelForm({
        baseUrl: modelConfig.baseUrl,
        model: modelConfig.model,
        apiKey: '',
        hasApiKey: Boolean(modelConfig.hasApiKey),
        keyStoredSecurely: Boolean(modelConfig.keyStoredSecurely),
        thinkingLevel: modelConfig.thinkingLevel ?? 'default',
        supportsVision: modelConfig.supportsVision !== false,
        visionModel: modelConfig.visionModel ?? '',
      });
      modelReadyRef.current = Boolean(modelConfig.hasApiKey && modelConfig.model.trim());
      const [config, permission] = await Promise.all([
        bridge.getConfig(),
        bridge.getMicrophonePermissionStatus(),
      ]);
      setMicrophonePermission(permission);
      setRepairHint((current) => {
        if (current?.key === 'asr' && config.hasApiKey) return null;
        if (current?.key === 'microphone' && permission === 'granted') return null;
        return current;
      });
    } catch {
      /* 读取失败保留现状 */
    }
  }, []);

  // 设置页关回主界面时刷新目录（组可能被编辑/增删）与就绪状态（032：解耦后
  // 模型组由 031 区块独立保存，这里回读默认组决定输入区就绪与修复条去留）。
  useEffect(() => {
    if (!settingsOpen) {
      void reloadModelProfiles();
      void refreshReadinessAfterSettings();
    }
  }, [settingsOpen, reloadModelProfiles, refreshReadinessAfterSettings]);

  /**
   * 新建对话要恢复的选择：目录里记的上次选择仍可用才返回它——模型在场且
   * 供应商有 Key（与选择菜单的可选口径一致）；「自动（角色路由）」须路由配了
   * 主 agent 且无环境覆盖。否则返回 null＝回落默认模型（031 原口径兜底）。
   */
  const lastUsedProfileForNewConversation = useCallback((): string | null => {
    const directory = modelProfilesRef.current;
    const value = directory?.lastConversationModelKey;
    if (!value) return null;
    if (value === 'auto') {
      return 'auto'; // 保留用户的显式选择；无效策略由菜单和受理错误引导修复，不暗换默认模型。
    }
    for (const provider of directory?.providers ?? []) {
      if (provider.hasApiKey && provider.models.some((model) => model.modelKey === value)) {
        return value;
      }
    }
    return null;
  }, []);

  /** 063：/model 本地切换的轻量反馈（输入区短暂提示；不伪造对话消息）。 */
  const [modelNotice, setModelNotice] = useState('');
  useEffect(() => {
    if (!modelNotice) return;
    const timer = window.setTimeout(() => setModelNotice(''), 2800);
    return () => window.clearTimeout(timer);
  }, [modelNotice]);

  const handleSelectModelProfile = useCallback(
    (profileId: string) => {
      applyConversationProfile(profileId);
      rememberLastConversationModel(profileId);
      // 立刻随会话存档落一笔（不等防抖——选择切换即持久化，重载后仍可见）。
      const conversationId = conversationIdRef.current;
      if (conversationId) {
        void window.hemiVoice
          ?.flowSaveMetadata({ conversationId, profileId })
          .catch(() => {});
      }
      const label = profileId === 'auto'
        ? '自动路由'
        : modelProfiles?.providers.flatMap((provider) => provider.models).find((model) => model.modelKey === profileId)?.model ?? profileId;
      setModelNotice(`已选择 ${label}，后续新提交使用`);
      logChain(`会话模型切换 → ${profileId}（下一回合生效）`);
    },
    [applyConversationProfile, rememberLastConversationModel, modelProfiles],
  );

  /**
   * 2026-10-08：无会话冷启动落在新对话态——目录到达后同样恢复上次选择
   * （一次性；之后目录刷新不再回灌，避免盖掉用户在新对话里的手动选择）。
   * 已载入会话或用户已自行选择时不插手。
   */
  const initialProfileRestoreDoneRef = useRef(false);
  useEffect(() => {
    if (initialProfileRestoreDoneRef.current || !modelProfiles) return;
    initialProfileRestoreDoneRef.current = true;
    if (conversationIdRef.current || conversationProfileRef.current) return;
    applyConversationProfile(lastUsedProfileForNewConversation());
  }, [modelProfiles, applyConversationProfile, lastUsedProfileForNewConversation]);

  useEffect(
    () => () => {
      if (attachErrorTimerRef.current) clearTimeout(attachErrorTimerRef.current);
    },
    [],
  );

  /** 附件归属需要会话身份：附加即视为「要在这段对话里说话」，提前定 id（与 runTurn 首回合同源）。 */
  const ensureConversationForAttachment = useCallback(() => {
    if (!conversationIdRef.current) {
      conversationIdRef.current = createConversationId();
      setConversationId(conversationIdRef.current);
    }
    return conversationIdRef.current;
  }, []);

  const handleAttachDrop = useCallback(
    async (filePath: string) => {
      const bridge = window.hemiVoice;
      if (!bridge || !filePath) return;
      const conversationId = ensureConversationForAttachment();
      try {
        const result = await bridge.attachFile({ conversationId, filePath, source: 'drop' });
        if (result.attachments) setDraftAttachments(result.attachments);
      } catch (error) {
        flashAttachError(messageFromError(error, '附件没有加上'));
      }
    },
    [ensureConversationForAttachment, flashAttachError],
  );

  const handleAttachPaste = useCallback(
    async (dataUrl: string) => {
      const bridge = window.hemiVoice;
      if (!bridge || !dataUrl) return;
      const conversationId = ensureConversationForAttachment();
      try {
        const result = await bridge.attachPasteImage({ conversationId, dataUrl });
        if (result.attachment) {
          logChain(`粘贴图片登记为附件 ${result.attachment.attachmentId}`);
        }
        if (result.attachments) setDraftAttachments(result.attachments);
      } catch (error) {
        flashAttachError(messageFromError(error, '图片没有加上'));
      }
    },
    [ensureConversationForAttachment, flashAttachError],
  );

  const handleRemoveAttachment = useCallback(async (attachmentId: string) => {
    const bridge = window.hemiVoice;
    const conversationId = conversationIdRef.current;
    if (!bridge || !conversationId) return;
    try {
      const result = await bridge.removeAttachment({ conversationId, attachmentId });
      if (result.attachments) setDraftAttachments(result.attachments);
    } catch (error) {
      flashAttachError(messageFromError(error, '没有移除成功'));
    }
  }, [flashAttachError]);

  /** 030 R-04：当前会话的已发送用户输入（最新在前，相邻去重）。 */
  const inputHistory = useMemo(() => buildInputHistory(transcripts), [transcripts]);

  /** 预览/＋菜单用的元数据：草稿＋历史消息里冻结的已发送附件（按身份去重）。 */
  const attachmentViews = useMemo(() => {
    const byId = new Map<string, MessageAttachmentView>();
    for (const item of draftAttachments) byId.set(item.attachmentId, item);
    for (const item of transcripts) {
      for (const attachment of item.attachments ?? []) {
        if (!byId.has(attachment.attachmentId)) byId.set(attachment.attachmentId, attachment);
      }
    }
    return [...byId.values()];
  }, [draftAttachments, transcripts]);

  useEffect(() => {
    void window.hemiVoice
      ?.getContextState()
      .then(setContextState)
      .catch(() => {});
    const off = window.hemiVoice?.onContextState(setContextState);
    return () => off?.();
  }, []);

  useEffect(
    () => () => {
      if (contextErrorTimerRef.current) clearTimeout(contextErrorTimerRef.current);
    },
    [],
  );

  const flashContextError = useCallback((message: string) => {
    setContextError(message);
    if (contextErrorTimerRef.current) clearTimeout(contextErrorTimerRef.current);
    contextErrorTimerRef.current = setTimeout(() => setContextError(''), 6000);
  }, []);

  const handleAttachContext = useCallback(
    async (kind: WorkContextAttachKind) => {
      const bridge = window.hemiVoice;
      if (!bridge || contextBusy) return;
      setContextBusy(true);
      try {
        const result = await bridge.attachContext(kind);
        setContextState(result.state);
      } catch (error) {
        flashContextError(messageFromError(error, '附加失败，请再试一次。'));
      } finally {
        setContextBusy(false);
      }
    },
    [contextBusy, flashContextError],
  );

  const handleRefreshContext = useCallback(
    async (id: string) => {
      const bridge = window.hemiVoice;
      if (!bridge || contextBusy) return;
      setContextBusy(true);
      try {
        const result = await bridge.refreshContext(id);
        setContextState(result.state);
      } catch (error) {
        flashContextError(messageFromError(error, '刷新失败，请再试一次。'));
      } finally {
        setContextBusy(false);
      }
    },
    [contextBusy, flashContextError],
  );

  const handleRemoveContext = useCallback(
    async (id: string) => {
      const bridge = window.hemiVoice;
      if (!bridge) return;
      try {
        const result = await bridge.removeContext(id);
        setContextState(result.state);
      } catch (error) {
        flashContextError(messageFromError(error, '移除失败，请再试一次。'));
      }
    },
    [flashContextError],
  );

  /** 012：产物打开/定位；失败与定位提示经同一瞬态错误位反馈（R-03 准确反馈）。 */
  const handleOpenArtifact = useCallback(
    async (taskId: string, artifactId: string, intent: 'open' | 'reveal') => {
      const bridge = window.hemiVoice;
      if (!bridge) return;
      try {
        const result = await bridge.openArtifact(taskId, artifactId, intent);
        if (!result.ok) {
          flashContextError(result.message || '打开失败');
        } else if (result.message) {
          flashContextError(result.message);
        }
      } catch (error) {
        flashContextError(messageFromError(error, '打开失败，请再试一次。'));
      }
    },
    [flashContextError],
  );

  /**
   * 005 阶段性成果播报（用户裁决：大结果出声、小步骤只视觉）——模型按【阶段】
   * 协议只在里程碑输出一行，适配器抽取后经快照到达这里。让位规则与任务结果一致
   * （正在播报/模型回合在途时让位，文字走任务卡与字幕）；按内容去重，每条只念一次。
   * 017：按任务去重（并行任务各报各的）；阶段变化同时追加一条对话气泡（017 交互稿
   * §4——中间结果「卡上静默更新为主、阶段变化多说一句」），不打断用户。
   */
  const stageAnnouncedRef = useRef(new Set<string>());
  useEffect(() => {
    const bundle = taskState;
    if (!bundle?.tasks?.length) return;
    for (const snap of bundle.tasks) {
      const stage = snap.stageText;
      if (!stage || snap.phase === 'terminal') continue;
      // 024 回卷：被剪任务的阶段简报不再回到对话流（终态交代同款剪除守卫）。
      if (cutKeysRef.current.has(cardKeyOf(snap))) {
        stageAnnouncedRef.current.add(`${cardKeyOf(snap)}:${stage}`);
        continue;
      }
      // 021 定稿：阶段简报同终态交代——只进本会话；按阶段键记入已播，切回不连播。
      const currentConv = conversationIdRef.current;
      if (!currentConv || (snap.conversationId ?? null) !== currentConv) {
        stageAnnouncedRef.current.add(`${cardKeyOf(snap)}:${stage}`);
        continue;
      }
      const key = `${cardKeyOf(snap)}:${stage}`;
      if (stageAnnouncedRef.current.has(key)) continue;
      stageAnnouncedRef.current.add(key);

      // 阶段简报气泡（017 R-05）：入史即成为对话上下文；语音让位规则与终态交代一致。
      // 024：文字任务的阶段不合成、不补播（去重已登记，卡片与正文照常）。
      if (!shouldAutoSpeak(snap.inputSource)) continue;
      if (ttsActiveRef.current || !ttsForm.ttsEnabled || !ttsForm.hasApiKey) continue;
      if (turnPhaseRef.current !== 'idle' && turnPhaseRef.current !== 'replying') continue;
      taskSpeakSeqRef.current -= 1;
      void startSpeakForTurn(taskSpeakSeqRef.current, stage);
    }
  }, [taskState, startSpeakForTurn, ttsForm.ttsEnabled, ttsForm.hasApiKey]);

  /**
   * 005 R-08：确认请求出现时语音报一声，人不看主窗口也知道有卡在等；
   * 正在播报则不抢占（R-16），只靠字幕的授权提示行。每个授权请求只报一次。
   *
   * 播报边界（2026-09-19 用户裁决「中间命令不播报」）：任务执行期间出声的只有
   * 三样——对话回应（ack／最终结果）、这句授权提醒、以及超时兜底；中间命令、
   * 进度、URL 明细是视觉信息，只进确认卡与字幕，绝不上语音。
   */
  const permissionAnnouncedRef = useRef(new Set<string>());
  useEffect(() => {
    const bundle = taskState;
    // 056：主 agent 自己的确认（agentPermissions）同样报一声。
    const waiting = [
      ...(bundle?.agentPermissions ?? []).map((entry) => ({ permission: entry.permission, conversationId: entry.conversationId, inputSource: entry.inputSource })),
      ...(bundle?.tasks ?? []),
    ];
    if (!waiting.length) return;
    for (const snap of waiting) {
      const permission = snap.permission;
      if (!permission?.id) continue;
      // 021 定稿：授权提醒只属于任务自己的会话——别的会话的等待不出声
      // （任务照常等授权、按超时兜底收场），确认卡在原会话里处理。
      const currentConv = conversationIdRef.current;
      if (!currentConv || (snap.conversationId ?? null) !== currentConv) {
        permissionAnnouncedRef.current.add(permission.id);
        continue;
      }
      if (permissionAnnouncedRef.current.has(permission.id)) continue;
      permissionAnnouncedRef.current.add(permission.id);
      // 024：文字任务的授权提醒不出声（提醒已登记去重，权限卡照常等待）。
      if (!shouldAutoSpeak(snap.inputSource)) continue;
      if (ttsActiveRef.current || !ttsForm.ttsEnabled || !ttsForm.hasApiKey) continue;
      const kindLabel =
        permission.tool === 'bash'
          ? '执行一条命令'
          : permission.tool === 'write' || permission.tool === 'edit'
            ? '写入一个文件'
            : '执行一步操作';
      // 018：语音带上具体动作摘要（点击哪里、打开哪个页面），不再只说「一步操作」；
      // bash 摘要嵌整条命令不上语音，维持短句。摘要缺失回退旧标签。
      const spokenAction =
        permission.tool === 'bash'
          ? kindLabel
          : permission.summary
            ? permission.summary.slice(0, 30)
            : kindLabel;
      taskSpeakSeqRef.current -= 1;
      void startSpeakForTurn(taskSpeakSeqRef.current, `我想${spokenAction}，需要你允许一下，请在主窗口确认`);
    }
  }, [taskState, startSpeakForTurn, ttsForm.ttsEnabled, ttsForm.hasApiKey]);

  /**
   * 主进程推来的 PCM 分片：旧代次丢弃，其余按序入播放器。
   * 019 duplex 模式：分片由主进程直推 duplexd，这里只到 bytes 元数据——
   * 计 receivedBytes（hasAudio/进度判定），不进 Web Audio 播放器。
   */
  const handleTtsAudioEvent = useCallback((event: TtsAudioEvent) => {
    const active = ttsSpeakRef.current;
    if (!active || event.turnId !== active.turnId) return;
    active.receivedBytes += event.audio?.byteLength ?? event.bytes ?? 0;
    if (event.audio) ensureTtsPlayer().enqueue(event.audio);
    // duplex 元数据形态：分片已由主进程直推 duplexd——标记正在出声。
    else if (duplexModeRef.current) duplexPlayingRef.current = true;
  }, [ensureTtsPlayer]);

  /** 合成收尾：finished 只代表服务端发完，排空回调（onDrained/drained 事件）才切 replying。 */
  const handleTtsStateEvent = useCallback(
    (event: TtsStateEvent) => {
      const active = ttsSpeakRef.current;
      if (!active || event.turnId !== active.turnId) return;

      /** 播放侧是否已无事可等（双后端）：duplex 看「正在出声」，浏览器看播放器排空。 */
      const playbackIdle = duplexModeRef.current
        ? !duplexPlayingRef.current
        : !ttsPlayerRef.current || ttsPlayerRef.current.isEmpty;

      if (event.phase === 'finished') {
        active.synthDone = true;
        if (!active.receivedBytes) {
          const message = '语音服务没有返回音频，请重试。';
          if (active.kind === 'preview') setErrorMessage(message);
          else setTurnError(message);
        }
        // duplex 模式播放器恒为 null——不看 duplexd 是否仍在出声就结算，
        // 会在播报刚开始时提前结束回合、解除 barge-in 武装（2026-09-21 实测）。
        if (playbackIdle) settleReply();
        return;
      }

      active.failed = true;
      active.failureMessage = event.message || '语音合成失败。';
      voiceLog.warn(`tts ${active.turnId} 失败：${active.failureMessage}`);
      if (active.kind === 'preview') {
        // 试听失败走设置弹窗的提示通路，不动回合状态；已排程的声音停掉。
        setErrorMessage(`试听失败：${active.failureMessage}`);
        haltPlayback();
        settleReply();
        return;
      }
      // TTS 失败不是回合失败：字幕上的回应仍在（非语音兜底），只叠加错误提示。
      // 停播后无条件结算：duplex 的 stopPlay 会压制 drained，不能等排空事件。
      setTurnError(`这条没能念出来：${active.failureMessage}`);
      haltPlayback();
      settleReply();
    },
    [haltPlayback, settleReply],
  );

  /**
   * barge-in 判定（播报期间，通话模式）：状态机在 lib/barge-in.ts，
   * 这里只喂帧和执行副作用。四重确认——Hemi 已实际出声（不是收到字节）、
   * 门先「关」后「开」、第一帧过阈先压低（duck）、压低态下继续过阈满 340ms
   * ——回声扛不住压低会自动解除，人声扛得住才确认打断并停播、把预缓冲
   * 话头交还上行。判定门限带播报保护余量（019，playbackMarginDb）。
   */
  const armBargeIn = useCallback(
    (gate: SilenceGate, frameMs: number) => {
      const controller = bargeInRef.current;
      if (!controller) return;

      const status = gate.status;
      const decision = controller.feed({
        gateOpen: status.open,
        levelDb: status.levelDb,
        thresholdDb: status.thresholdDb,
        // 「正在出声」双后端：duplex＝分片已推给 duplexd 且未排空/停播；
        // 浏览器＝播放时间线越过排程起点（120ms 提前量内算握手期）。
        hasAudio: duplexModeRef.current
          ? duplexPlayingRef.current
          : (ttsSpeakRef.current?.receivedBytes ?? 0) > 0 &&
            (ttsPlayerRef.current?.isAudible ?? false),
        frameMs,
      });

      if (decision.action === 'duck') {
        setPlaybackVolume(controller.duckVolume);
        logChain('barge-in ①压低播报音量');
        voiceLog.debug(
          `barge-in duck：电平 ${status.levelDb.toFixed(1)} dBFS / 门限 ${status.thresholdDb.toFixed(1)} / 播报余量 ${DEFAULT_BARGE_IN_CONFIG.playbackMarginDb}`,
        );
      }
      if (decision.quiet) {
        if (controller.isDucked && ttsDuckReleaseTimerRef.current === null) {
          // 滞回复原：安静够久才恢复音量，防抖动。
          ttsDuckReleaseTimerRef.current = window.setTimeout(() => {
            ttsDuckReleaseTimerRef.current = null;
            if (bargeInRef.current?.releaseDuck() === 'duck-release') {
              setPlaybackVolume(1);
              logChain('barge-in 解除压低');
            }
          }, DEFAULT_BARGE_IN_CONFIG.duckReleaseMs);
        }
      } else {
        clearDuckReleaseTimer();
      }

      if (decision.action === 'interrupt') {
        logChain('barge-in ②确认打断：停播，预缓冲话头上送');
        // 先解除压制再停播：开门冲刷帧要原样上送，门回到正常聆听。
        const buffered = gate.releaseInterruption();
        for (const frame of buffered) window.hemiVoice.sendAudio(frame);
        stopTtsPlayback({ toReplying: false });
        turnPhaseRef.current = 'listening';
        setTurnPhase('listening');
        setTurnError('');
      }
    },
    [clearDuckReleaseTimer, setGateMuted, setPlaybackVolume, stopTtsPlayback],
  );

  /** 一轮对话：提交 → thinking → 流式打字机 → 回应入列 → speaking（播报）→ replying。
   *  024：inputSource='text' 的回合跳过 TTS——回应入列后直接落 replying 停留。 */
  /** 060：此函数只提交并等待受理；模型结果由 flow／turnState 订阅接收。 */
  const runTurn = useCallback(async (
    messages: Array<{ role: string; content: string }>, inputSource: InputSource = 'voice',
    attachmentIds: string[] = [], opts: { voiceMode?: ListenMode; onAccepted?: (receipt: Extract<ChatTurnReceipt, { ok: true }>) => void; onRejected?: () => void } = {},
  ) => {
    const bridge = window.hemiVoice;
    if (!bridge || workspaceMissingRef.current) { opts.onRejected?.(); return; }
    const turnId = ++turnCounterRef.current;
    const requestId = `request-${createTranscriptId()}`;
    const epoch = viewEpochRef.current;
    lastInputSourceRef.current = inputSource;
    if (!conversationIdRef.current) {
      conversationIdRef.current = createConversationId();
      setConversationId(conversationIdRef.current);
      draftKeyRef.current = conversationIdRef.current;
      const title = cleanTitleSource(messages.at(-1)?.content ?? '').trim();
      if (title) setConversationTitle(title.slice(0, 24));
    }
    const id = conversationIdRef.current;
    // 063：引用视图整份随载荷（身份＋展示快照）——主进程 sanitize 有界净化；
    // 只送身份字段会让行内标签的 token 匹配与队列/历史回显丢名称。
    const references = lastReferencesRef.current.map((item) => ({ ...item }));
    try {
      const receipt = await bridge.submitChatTurn({
        turnId, requestId, messages, conversationId: id, inputSource, attachmentIds,
        attachmentViews: lastAttachmentViewsRef.current, references,
        skills: lastSkillsRef.current,
        profileId: conversationProfileRef.current, workspaceId: conversationWorkspaceRef.current,
        ...(inputSource === 'voice' && opts.voiceMode ? { voiceMode: opts.voiceMode } : {}),
      });
      if (epoch !== viewEpochRef.current || id !== conversationIdRef.current) return;
      if (!receipt.ok) throw new Error(receipt.message);
      opts.onAccepted?.(receipt);
      clearMemoryNotices();
      setTurnError('');
      logChain(`受理 ${receipt.inputId} · ${receipt.disposition}`);
      // 受理后由订阅推进状态；补取失败也不能再报告“未受理”，诱导用户重复发送。
      try {
        const current = await bridge.getConversationTurn(id);
        if (epoch === viewEpochRef.current && id === conversationIdRef.current) adoptConversationTurn(current);
      } catch (error) {
        voiceLog.warn(`受理后状态补取失败：${messageFromError(error, '等待订阅恢复')}`);
      }
    } catch (error) {
      if (epoch !== viewEpochRef.current || id !== conversationIdRef.current) return;
      opts.onRejected?.();
      setTurnError(messageFromError(error, '本轮没有受理，请重试。'));
      flashAttachError(messageFromError(error, '本轮没有受理，请重试。'));
    }
  }, [adoptConversationTurn, clearMemoryNotices, flashAttachError]);

  /** 用户新说完一轮：有新定稿才提交，上下文取最近若干回合。 */
  const submitTurn = useCallback(() => {
    if (!window.hemiVoice || !modelReadyRef.current) return;
    const unsent = speechHistoryRef.current.slice(lastSubmitCountRef.current).filter((entry) => entry.author === 'user');
    if (!unsent.length) return;
    const start = lastSubmitCountRef.current;
    const boundary = speechHistoryRef.current.length;
    const messages = contextWindow(historyFromTurns(transcriptsRef.current)).map((entry) => ({
      role: entry.author === 'hemi' ? 'assistant' : 'user', content: entry.text,
    }));
    messages.push({ role: 'user', content: unsent.map((entry) => entry.text).join('\n') });
    lastMessagesRef.current = messages;
    lastSubmitCountRef.current = boundary;
    lastAttachmentViewsRef.current = [];
    lastReferencesRef.current = [];
    lastSkillsRef.current = [];
    void runTurn(messages, 'voice', [], {
      voiceMode: sessionModeRef.current === 'continuous' ? 'continuous' : 'hold',
      onAccepted: receipt => {
        if (receipt.disposition === 'preempting') {
          // 停止旧目标只表示已受理；同一 inputId 正式派发前继续保留可见草稿。
          setSpeechDeliveries(current => [...current, { inputId: receipt.inputId, boundary }]);
          return;
        }
        speechAcceptedCountRef.current = Math.max(speechAcceptedCountRef.current, boundary);
        setSpeechDraftText(speechHistoryRef.current.slice(speechAcceptedCountRef.current).map(entry => entry.text).join('\n'));
        // 不清下一句 partial：受理回执可能晚于新识别结果到达。
      },
      onRejected: () => {
        if (lastSubmitCountRef.current === boundary) lastSubmitCountRef.current = start;
      },
    });
  }, [runTurn]);

  /**
   * 2026-10-18 裁决二读：「继续任务」＝真续跑——停止后没有新任务时，按普通文字
   * 回合补一条「继续」，模型从停止处接着干；不再只是解除暂停位（用户实测反馈
   * 「点了并没有继续」）。走既有受理/派发/落档链路，主进程旧实例上同样生效。
   */
  const handleContinueStoppedTask = useCallback(() => {
    const bridge = window.hemiVoice;
    const cid = conversationIdRef.current;
    if (!bridge || !cid || workspaceMissingRef.current) return;
    if ((flowPhaseRef.current ?? 'idle') !== 'idle') return;
    // 先解除停止暂停（旧主进程没有「直发即解除」；新主进程两道都通）。
    bridge.resumeTurnQueue(cid).catch(() => {});
    const messages = contextWindow(historyFromTurns(transcriptsRef.current)).map((entry) => ({
      role: entry.author === 'hemi' ? 'assistant' : 'user', content: entry.text,
    }));
    messages.push({ role: 'user', content: '继续' });
    lastMessagesRef.current = messages;
    lastAttachmentViewsRef.current = [];
    lastReferencesRef.current = [];
    lastSkillsRef.current = [];
    logChain('继续任务 → 补「继续」回合');
    void runTurn(messages, 'text', []);
  }, [runTurn]);

  const handleRetryTurn = useCallback(() => {
    if (!window.hemiVoice || !modelReadyRef.current) return;
    if (!lastMessagesRef.current.length) return;
    // 重试替代旧失败留痕：结尾 error 回合收走（剪除键随重试自己的存档传主进程，
    // 防宿主回写复活），新失败另留新痕——一次交互只保一条最新错误。
    const superseded = supersedeTrailingErrors(transcriptsRef.current);
    if (superseded) {
      for (const key of superseded.cutKeys) cutKeysRef.current.add(key);

      logChain(`retry 收走旧失败留痕 ${superseded.cutCount} 条`);
    }
    logChain('retry → 模型');
    // 028：失败重试按原身份重发同一批附件（主进程已冻结归属，不重复登记）。
    void runTurn(lastMessagesRef.current, lastInputSourceRef.current, lastAttachmentIdsRef.current);
  }, [runTurn]);

  /**
   * 024：文字发送——不经过 ASR 定稿入口，直接汇入同一模型回合；同步校验与
   * 占用在第一个 await 之前完成。待提交语音期间禁发（不合并半句话），
   * 通话保持（不关麦克风）；停在 replying/error 的旧状态由 runTurn 统一收口。
   */
  const handleSubmitText = useCallback(() => {
    if (!window.hemiVoice) return;
    const text = draft.trim();
    if (queueEditRef.current) { void saveQueueEdit(); return; }
    // 028：仅附件无文字也可发送（AC-03）；两者都空才拦。
    if (!text && !draftAttachments.length) return;
    // 未就绪附件不能被误认为已发送（R-03）。
    if (draftAttachments.some((item) => item.status !== 'ready')) {
      logChain('text submit 跳过：附件未就绪');
      return;
    }
    const pending = hasPendingSpeech({
      holdActive: activeRef.current && sessionModeRef.current === 'hold',
      interim: interimTextRef.current,
      unsubmittedUserCount: speechHistoryRef.current
        .slice(lastSubmitCountRef.current)
        .filter((entry) => entry.author === 'user').length,
    });
    if (
      !canSendText({
        modelReady: modelReadyRef.current,
        modelInFlight: false,
        pendingSpeech: pending,
      })
    ) {
      // 两类原因分开记：排查时按日志即可分辨（2026-10-07 conv-muy9y8gu 排查实录）。
      logChain(`text submit 跳过：${modelReadyRef.current ? '待提交语音' : '模型未配置'}`);
      return;
    }
    // 033 R-07：工作区目录失效 → 禁发（草稿保留在输入区，重新选择后可发）。
    if (workspaceMissingRef.current) {
      turnPhaseRef.current = 'error';
      setTurnPhase('error');
      setTurnError('工作区目录不可用，发送已暂停；在输入框上方重新选择后可继续。');
      logChain('text submit 跳过：工作区目录不可用');
      return;
    }
    // 播放中的语音回复让位（只停声音，不动通话与麦克风）。
    stopTtsPlayback();
    // 028 R-04：正文和附件作为同一条用户消息受理——冻结附件快照进对话流，
    // 历史回看与重试共用同一 attachmentId；受理在主进程 markSent 后撤下草稿区。
    const sentAttachments = draftAttachments;
    const attachmentIds = sentAttachments.map((item) => item.attachmentId);
    lastAttachmentIdsRef.current = attachmentIds;
    lastAttachmentViewsRef.current = sentAttachments;
    const sentReferences = draftReferences;
    lastReferencesRef.current = sentReferences;
    const sentSkills = draftSkills;
    lastSkillsRef.current = sentSkills;
    const version = composerDraft.getSnapshot().revision;
    if (submittingDraftsRef.current.has(version)) return;
    submittingDraftsRef.current.add(version);
    const messages = contextWindow(historyFromTurns(transcriptsRef.current)).map((entry) => ({
      role: entry.author === 'hemi' ? 'assistant' : 'user', content: entry.text,
    }));
    messages.push({ role: 'user', content: text });
    lastMessagesRef.current = messages;
    void runTurn(messages, 'text', attachmentIds, {
      onAccepted: () => { if (composerDraft.accept(version)) setDiscussContext(null); },
    }).finally(() => submittingDraftsRef.current.delete(version));
  }, [draft, draftAttachments, draftReferences, draftSkills, runTurn, stopTtsPlayback, composerDraft, saveQueueEdit]);

  // —— 024 消息编辑（纯逻辑在 lib/message-edit.ts）——
  // 2026-10-10 语义改版（仿 zcode 回卷）：「重新发送」＝保存新文本＋把这条
  // 之后的内容整段撤下（含任务卡与终态交代），再从这条重新发起模型回合。
  // 被撤下内容从对话流删除，剪除键随存档传主进程拒绝宿主回写复活。

  const handleStartEdit = useCallback((id: string) => {
    setEditingId(id);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleEditResend = useCallback(
    (id: string, nextText: string) => {
      const text = nextText.trim();
      if (!text || !window.hemiVoice) return;
      const rewind = rewindToMessage(transcriptsRef.current, id, text, Date.now());
      if (!rewind) return;
      setEditingId(null);
      stopTtsPlayback();
      // 仿 zcode（editUserQuery preempts active turn）：编辑优先，在途回合直接
      // 作废——不静默拒绝。作废先于新回合：代次递增后迟到分片/回执全废。
      if (turnPhaseRef.current === 'thinking' || turnPhaseRef.current === 'replying') {
        const preemptedTurn = turnIdRef.current;
        invalidateTurn({ reason: 'preempt' });
        logChain(`edit rewind 抢占在途回合（turn ${preemptedTurn}）`);
      }
      for (const key of rewind.cutKeys) cutKeysRef.current.add(key);

      const history = historyFromTurns(rewind.turns);

      const messages = contextWindow(history).map((entry) => ({
        role: entry.author === 'hemi' ? 'assistant' : 'user',
        content: entry.text,
      }));
      lastMessagesRef.current = messages;
      logChain(`edit rewind → 模型「${text.slice(0, 24)}」（撤回 ${rewind.cutCount} 条）`);
      // 剪除先于新回合落档（2026-10-14 真机钓出）：回卷存档走防抖 effect 时，
      // chat 会先于剪除到达主进程——主 agent 跑在旧档上、迟到的剪再把它整回合杀掉
      // （任务连带被叫停）。这里显式等存档落地（主进程应用剪除、作废旧主 agent）
      // 再发起回合，新回合才建在回卷后的档案上。
      void (async () => {
        const conversationId = conversationIdRef.current;
        if (conversationId) {
          // 057 S3-2d：回卷走宿主（档案剪除＋flow 时间线裁剪＋主 agent 作废）——
          // 渲染层不再整表回写；等宿主落地再起新回合（新回合建在回卷后的档案上）。
          const rewound = await window.hemiVoice
            ?.flowRewind({
              conversationId,
              targetInputId: id,
              // 被编辑轮本身也要剪（旧通路靠权威整表替换删它；宿主是追加式）。
              removedTurnKeys: [...new Set([...cutKeysRef.current, id])],
            })
            .catch(() => null);
          if (!rewound?.ok) {
            const message = rewound?.message ?? '历史回卷失败，请重试编辑。';
            logChain(`回卷失败：${message}`);
            flashAttachError('历史回卷失败，修改尚未发送。请重试编辑。');
            return;
          }
        }
        await runTurn(messages, 'text');
      })();
    },
    [flashAttachError, invalidateTurn, runTurn, stopTtsPlayback],
  );

  const stopSession = useCallback(
    async (options?: { submit?: boolean }) => {
      // 单句松手：定稿要等 stop 的最终回应 flush，先记住模式，收完再提交。
      const wasHold = sessionModeRef.current === 'hold';
      if (wasHold) {
        const { count, bytes } = holdFramesRef.current;
        logChain(`hold 上行统计：${count} 帧 / ${Math.round(bytes / 1024)} KB（16k PCM）`);
        holdFramesRef.current = { count: 0, bytes: 0 };
      }
      activeRef.current = false;
      sessionModeRef.current = null;
      setSessionMode(null);
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
      stopAudioCapture();
      stopTtsPlayback();
      // 不提前清临时文本：尾句定稿要等 stopAsr flush 才落地（主进程 8s 硬上限），
      // 提前清空会让活区/字幕在空窗里回退显示上一轮旧文本——松手闪旧文本
      // （2026-09-23 实录）。临时文本冻结到定稿的 finalize 自清，或 stop 完成
      // 后的兜底清理；期间 partial 已被 !activeRef 守卫丢弃，不会继续变化。
      setSessionState('idle');
      await window.hemiVoice?.stopAsr();
      // stopAsr 会等待最后一批识别结果；收完仍须清理（即使 ended 未送达）。
      if (!activeRef.current) updateInterim('');
      if (options?.submit && wasHold) {
        logChain('hold 松手 → 停会话完成，提交这一轮');
        submitTurn();
      }
    },
    [clearReconnectTimer, stopAudioCapture, stopTtsPlayback, submitTurn, updateInterim],
  );

  /**
   * Rebuilds only the recognition socket, so a call survives a provider-side
   * close without dropping the microphone or losing the elapsed time.
   */
  const scheduleContinuousReconnect = useCallback(() => {
    if (!activeRef.current || sessionModeRef.current !== 'continuous') return;
    if (reconnectTimerRef.current !== null) return;

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;

    if (attempt > MAX_CONTINUOUS_RECONNECTS) {
      activeRef.current = false;
      sessionModeRef.current = null;
      setSessionMode(null);
      reconnectAttemptRef.current = 0;
      stopAudioCapture();
      updateInterim('');
      setErrorMessage('断线重连了好几次都没接上，通话先结束了；网络或 API Key 恢复后再叫我。');
      setSessionState('error');
      void window.hemiVoice?.stopAsr();
      return;
    }

    setSessionState('requesting');

    const delay = Math.min(
      CONTINUOUS_RECONNECT_BASE_DELAY_MS * attempt,
      CONTINUOUS_RECONNECT_MAX_DELAY_MS,
    );

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;

      const bridge = window.hemiVoice;
      if (!bridge) return;
      if (!activeRef.current || sessionModeRef.current !== 'continuous') return;

      void (async () => {
        const result = await bridge.startAsr('continuous');

        if (!activeRef.current || sessionModeRef.current !== 'continuous') {
          await bridge.stopAsr();
          return;
        }

        if (!result.ok) {
          setErrorMessage(result.message || '重连语音识别失败。');
          scheduleContinuousReconnect();
          return;
        }

        reconnectAttemptRef.current = 0;
        // 019 重连风暴第二道保险：清掉悬挂的重连定时器——它的触发只会健康地
        // 顶掉刚建好的会话，制造下一轮「假断线」。
        clearReconnectTimer();
        setErrorMessage('');
        setSessionState('listening');
        if (turnPhaseRef.current === 'idle') {
          turnPhaseRef.current = 'listening';
          setTurnPhase('listening');
        }
      })();
    }, delay);
  }, [clearReconnectTimer, stopAudioCapture]);

  /**
   * 019：电平 → 「正在说话」态（110ms 防抖）。浏览器路径由 rAF analyser 驱动，
   * duplex 路径由 cap 事件驱动——公式一致，「正在说话」不分后端（悬浮字幕/球
   * 经 publishUiState 消费）。
   */
  const updateOrbFromRms = useCallback((rms: number) => {
    const level = Math.min(1, Math.max(0, (rms - 0.012) * 8.5));
    const nowSpeaking = level > 0.09;
    const now = performance.now();
    if (nowSpeaking !== speakingRef.current && now - lastVisualChangeRef.current > 110) {
      speakingRef.current = nowSpeaking;
      setIsSpeaking(nowSpeaking);
      lastVisualChangeRef.current = now;
    }
  }, []);

  /**
   * 采集帧的共享处理（浏览器 onaudioprocess 与 duplex cap 流两路同用）：
   * 接通试音 → （长按直送）静音门 → 上送 → 播报期 barge-in → 门态日志与计数。
   * pcm 是 16k 单声道 int16；rms/frameMs 由调用方按各自源计算。
   */
  const handleCaptureFrame = useCallback(
    (gate: SilenceGate, pcm: ArrayBuffer, rms: number, frameMs: number) => {
      // Probe the same frames we upload. Testing the microphone must not
      // consume the first 1.2 seconds of the user's utterance.
      if (probeMsRef.current < 1200) {
        probeMaxRmsRef.current = Math.max(probeMaxRmsRef.current, rms);
        probeMsRef.current += frameMs;
        if (probeMsRef.current >= 1200) {
          logChain(`接通试音完成（同步上传）：RMS=${probeMaxRmsRef.current.toFixed(4)}`);
          if (probeMaxRmsRef.current < 0.0002) {
            setErrorMessage('我这边一点声音都没收到，请到 系统设置 → 声音 → 输入 检查麦克风。');
          }
        }
      }

      // Push-to-talk streams everything: those sessions last seconds and the
      // user is deliberately holding the control, so there is nothing to save.
      // Only a call, which can stay open for minutes, is worth gating.
      if (sessionModeRef.current !== 'continuous') {
        holdFramesRef.current.count += 1;
        holdFramesRef.current.bytes += pcm.byteLength;
        window.hemiVoice.sendAudio(pcm);
        return;
      }

      const frames = gate.process(pcm, rms, frameMs, performance.now());
      for (const frame of frames) window.hemiVoice.sendAudio(frame);

      // 播报期间的两级打断判定：判定全在本地（门即打断），上行仍被压制。
      if (ttsActiveRef.current && ttsSpeakRef.current) armBargeIn(gate, frameMs);

      // True while audio is actually flowing upstream, which includes the
      // calibration window at the start of a call.
      const listening = gate.isListening;
      if (listening !== lastGateStateRef.current) {
        lastGateStateRef.current = listening;
        const gateStatus = gate.status;
        voiceLog.debug(
          `静音门 ${listening ? '开' : '关'}：电平 ${gateStatus.levelDb.toFixed(1)} dBFS / 平滑 ${gateStatus.smoothedDb.toFixed(1)} dBFS / 底噪 ${gateStatus.noiseFloorDb.toFixed(1)} dBFS / 门限 ${gateStatus.thresholdDb.toFixed(1)} dBFS`,
        );
        setVoiceGateOpen(listening);
        voiceGateOpenRef.current = listening;
      }

      const skippedSeconds = Math.floor(gate.status.skippedMs / 1000);
      if (skippedSeconds !== lastSkippedSecondsRef.current) {
        lastSkippedSecondsRef.current = skippedSeconds;
        setSilenceSkippedSeconds(skippedSeconds);
      }
    },
    [armBargeIn],
  );

  const startAudioCapture = useCallback((stream: MediaStream) => {
    const startedAt = performance.now();
    const mark = (stage: string) => voiceLog.info(`采集启动：${stage}（${Math.round(performance.now() - startedAt)}ms）`);
    mark('创建 AudioContext');
    const audioContext = new AudioContext();
    mark('AudioContext 就绪；创建 analyser');
    const analyser = audioContext.createAnalyser();
    mark('创建麦克风源');
    const source = audioContext.createMediaStreamSource(stream);
    mark('创建采集处理器');
    const processor = audioContext.createScriptProcessor(
      CAPTURE_BUFFER_SIZE,
      1,
      1,
    );
    const muteGain = audioContext.createGain();
    const samples = new Uint8Array(256);
    const gate = new SilenceGate();
    gateRef.current = gate;
    // 024：新建门要继承用户静音态（静音中开麦的通话不该漏上行）。
    gate.muted = callMutedRef.current;
    // 共享帧处理的状态复位（refs 见组件顶部；duplex 路径同款复位）。
    lastGateStateRef.current = null;
    lastSkippedSecondsRef.current = -1;
    probeMsRef.current = 0;
    probeMaxRmsRef.current = 0;
    lastVisualChangeRef.current = 0;

    // Tuning hook: thresholds are derived from the live noise floor, so being
    // able to read the numbers back is how they get adjusted for a new room or
    // a new microphone.
    (window as unknown as { __hemiSilenceGate?: unknown }).__hemiSilenceGate =
      () => gate.status;

    // 019 R-08：接通即记录音频环境（版本、请求与实际约束、采样率/帧宽）。
    // 后端生效与否（系统 AEC 是否真的走 VoiceProcessingIO）浏览器侧拿不到
    // 直接证据，只有这里的请求/上报差异 + 主进程日志可对照——如实记录，不
    // 宣称「回声已消除」。
    const captureTrack = stream.getAudioTracks()[0];
    mark('读取麦克风 settings');
    const trackSettings = captureTrack?.getSettings?.() ?? {};
    mark('读取麦克风 capabilities');
    const trackCapabilities = captureTrack?.getCapabilities?.() ?? {};
    mark('音频节点与设备信息已就绪');
    const chromiumVersion =
      /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '未知';
    const audioDiagnostics = {
      chromium: chromiumVersion,
      requested: { echoCancellation: true, autoGainControl: true, noiseSuppression: true },
      settings: {
        echoCancellation: trackSettings.echoCancellation ?? null,
        autoGainControl: trackSettings.autoGainControl ?? null,
        noiseSuppression: trackSettings.noiseSuppression ?? null,
        sampleRate: trackSettings.sampleRate ?? null,
      },
      capabilities: {
        echoCancellation: trackCapabilities.echoCancellation ?? null,
      },
      capture: {
        sampleRate: audioContext.sampleRate,
        bufferSize: CAPTURE_BUFFER_SIZE,
        frameMs: Math.round((CAPTURE_BUFFER_SIZE / audioContext.sampleRate) * 1000),
      },
      playback: { sampleRate: TTS_SAMPLE_RATE },
      userAgent: navigator.userAgent,
    };
    voiceLog.info(
      `音频环境：Chromium ${chromiumVersion}；AEC 请求=${audioDiagnostics.requested.echoCancellation} 实报=${audioDiagnostics.settings.echoCancellation} 能力=${JSON.stringify(audioDiagnostics.capabilities.echoCancellation)}；AGC 实报=${audioDiagnostics.settings.autoGainControl}；采集 ${audioDiagnostics.capture.sampleRate}Hz/${audioDiagnostics.capture.frameMs}ms；播放 ${TTS_SAMPLE_RATE}Hz`,
    );
    (window as unknown as { __hemiAudioDiagnostics?: unknown }).__hemiAudioDiagnostics =
      () => audioDiagnostics;

    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    source.connect(processor);
    muteGain.gain.value = 0;
    processor.connect(muteGain);
    muteGain.connect(audioContext.destination);

    processor.onaudioprocess = (event) => {
      if (!activeRef.current) return;
      const input = event.inputBuffer.getChannelData(0);
      if (!input.length) return;
      handleCaptureFrame(
        gate,
        downsampleToPcm16(input, audioContext.sampleRate),
        rootMeanSquare(input),
        captureFrameMs(input.length, audioContext.sampleRate),
      );
    };

    audioContextRef.current = audioContext;
    sourceRef.current = source;
    processorRef.current = processor;
    muteGainRef.current = muteGain;

    const renderLevel = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;

      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }

      updateOrbFromRms(Math.sqrt(sum / samples.length));
      animationFrameRef.current = requestAnimationFrame(renderLevel);
    };

    void audioContext.resume();
    renderLevel();
  }, [handleCaptureFrame, updateOrbFromRms]);

  /**
   * 019：duplex 模式的采集启动——没有 getUserMedia/AudioContext，只有静音门与
   * 共享帧处理的状态复位；帧来自 onDuplexCap 事件（16k 消回声后 PCM）。
   */
  const startDuplexCapture = useCallback(() => {
    const gate = new SilenceGate();
    gateRef.current = gate;
    // 024：同浏览器路径——新建门继承用户静音态。
    gate.muted = callMutedRef.current;
    lastGateStateRef.current = null;
    lastSkippedSecondsRef.current = -1;
    probeMsRef.current = 0;
    probeMaxRmsRef.current = 0;
    lastVisualChangeRef.current = 0;
    (window as unknown as { __hemiSilenceGate?: unknown }).__hemiSilenceGate =
      () => gate.status;
    (window as unknown as { __hemiAudioDiagnostics?: unknown }).__hemiAudioDiagnostics =
      () => ({
        backend: 'duplexd',
        capture: { sampleRate: 16000, channels: 1, frameMs: 'engine-io（约 106ms）' },
        playback: { sampleRate: 24000, gainPiecesMs: 20 },
      });
    voiceLog.info('音频环境：duplex 后端（duplexd · VPIO 消回声后 PCM 16k/单声道；TTS 24k 直推）');
  }, []);

  const startSession = useCallback(async (mode: ListenMode) => {
    if (!window.hemiVoice) {
      setErrorMessage('请从 Hemi 客户端中启动。');
      setSessionState('error');
      activeRef.current = false;
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('当前系统无法访问麦克风。');
      setSessionState('error');
      activeRef.current = false;
      return;
    }

    setSessionState('requesting');
    setErrorMessage('');
    setElapsedSeconds(0);

    try {
      logChain('接通①：读配置与权限');
      const [config, permission] = await Promise.all([
        window.hemiVoice.getConfig(),
        window.hemiVoice.getMicrophonePermissionStatus(),
      ]);
      logChain(`接通②：配置 ok=${Boolean(config.hasApiKey)} 权限=${permission}`);

      updateConfigForm({
        resourceId: config.resourceId,
        endpoint: config.endpoint,
        hasApiKey: Boolean(config.hasApiKey),
        keyStoredSecurely: Boolean(config.keyStoredSecurely),
      });
      setMicrophonePermission(permission);

      if (!config.hasApiKey || permission !== 'granted') {
        // 032：已完成引导的用户留在主界面就近修复——不再整页打回引导。
        activeRef.current = false;
        setSessionState('idle');
        if (!config.hasApiKey) {
          setRepairHint({
            key: 'asr',
            title: '语音服务密钥未配置',
            detail: '语音暂不可用，文字对话仍可继续。',
            actionLabel: '去设置',
            onAction: () => {
              setSettingsTarget({ page: 'voice', section: 'recognition' });
              setSettingsOpen(true);
            },
          });
        } else {
          setRepairHint({
            key: 'microphone',
            title: '麦克风权限未开启',
            detail: '在系统设置中允许后即可使用语音。',
            actionLabel: '打开系统设置',
            onAction: () => {
              void window.hemiVoice?.openMicrophoneSettings();
            },
          });
        }
        window.hemiVoice.showMainWindow();
        return;
      }

      // 019：通话模式先试原生双工后端（duplexd：VPIO 消回声 + TTS 直推）。
      // 拉不起（二进制缺失/引擎故障/超时）就地回退浏览器链路，不打断接通流程。
      duplexModeRef.current = false;
      if (mode === 'continuous') {
        logChain('接通③：尝试 duplex 后端');
        const duplex: DuplexStartResult = await window.hemiVoice
          .startDuplex?.()
          .catch((): DuplexStartResult => ({ ok: false, reason: 'invoke-failed' }));
        if (!activeRef.current) {
          if (duplex?.ok) await window.hemiVoice.stopDuplex?.();
          return;
        }
        if (duplex?.ok) {
          duplexModeRef.current = true;
          logChain(`接通③′：duplex 就绪（输入 ${duplex.inFormat ?? '?'} / 输出 ${duplex.outFormat ?? '?'}）`);
        } else {
          voiceLog.warn(`duplex 后端不可用（${duplex?.reason ?? '未知'}），回退浏览器链路`);
        }
      }

      // getUserMedia 在音频设备坏死后会无限等待（真机实测：前一次会话音频已死、
      // 下一次通话永远停在「正在接通」）——10s 拿不到麦就明确报错退出，绝不悬着。
      // duplex 模式采集走 duplexd，跳过浏览器麦克风。
      let stream: MediaStream | null = null;
      if (!duplexModeRef.current) {
        logChain('接通③″：请求麦克风');
        stream = await new Promise<MediaStream>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error('获取麦克风超时（10s）——音频设备可能被占用或已失效，重启应用或拔插设备后重试。')),
            10000,
          );
          navigator.mediaDevices
            .getUserMedia({
              audio: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true,
              },
            })
            .then((stream) => {
              window.clearTimeout(timer);
              resolve(stream);
            })
            .catch((error) => {
              window.clearTimeout(timer);
              reject(error);
            });
        });
        logChain('接通④：麦克风已就绪');
      }

      if (!activeRef.current) {
        stream?.getTracks().forEach((track) => track.stop());
        if (duplexModeRef.current) {
          duplexModeRef.current = false;
          await window.hemiVoice.stopDuplex?.();
        }
        return;
      }

      const result = await window.hemiVoice.startAsr(mode);
      logChain(`接通⑤：收到语音服务启动回执 ok=${result.ok}`);
      if (!result.ok) {
        stream?.getTracks().forEach((track) => track.stop());
        if (duplexModeRef.current) {
          duplexModeRef.current = false;
          await window.hemiVoice.stopDuplex?.();
        }
        activeRef.current = false;
        setErrorMessage(result.message || '无法连接语音识别服务。');
        setSessionState('error');
        // 032：缺配置/鉴权失败走主界面修复条，不再打回引导（AC-7）。
        if (result.code === 'CONFIG_REQUIRED' || /鉴权失败/.test(result.message ?? '')) {
          setRepairHint({
            key: 'asr',
            title: result.code === 'CONFIG_REQUIRED' ? '语音服务密钥未配置' : '语音服务密钥需要更新',
            detail: '语音暂不可用，文字对话仍可继续。',
            actionLabel: '去设置',
            onAction: () => {
              setSettingsTarget({ page: 'voice', section: 'recognition' });
              setSettingsOpen(true);
            },
          });
        }
        window.hemiVoice.showMainWindow();
        return;
      }

      if (!activeRef.current) {
        stream?.getTracks().forEach((track) => track.stop());
        if (duplexModeRef.current) {
          duplexModeRef.current = false;
          await window.hemiVoice.stopDuplex?.();
        }
        await window.hemiVoice.stopAsr();
        return;
      }

      sessionModeRef.current = mode;
      setSessionMode(mode);
      reconnectAttemptRef.current = 0;
      if (duplexModeRef.current) {
        startDuplexCapture();
      } else {
        streamRef.current = stream;
        startAudioCapture(stream!);
      }
      setSessionState('listening');
      // 通话模式的回合静音判定只在 turnPhase 'listening' 时武装：
      // 接通后必须先把回合置进聆听态，说完停顿才会触发提交。
      if (mode === 'continuous' && turnPhaseRef.current === 'idle') {
        turnPhaseRef.current = 'listening';
        setTurnPhase('listening');
      }
    } catch (error) {
      activeRef.current = false;
      stopAudioCapture();
      await window.hemiVoice.stopAsr();
      const isPermissionError =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'SecurityError');

      setErrorMessage(
        isPermissionError
          ? '麦克风权限已关闭。'
          : messageFromError(error, '没有检测到可用的麦克风。'),
      );
      if (isPermissionError) {
        // 032：权限被收回的就近修复入口（AC-7）。
        setRepairHint({
          key: 'microphone',
          title: '麦克风权限未开启',
          detail: '在系统设置中允许后即可使用语音。',
          actionLabel: '打开系统设置',
          onAction: () => {
            void window.hemiVoice?.openMicrophoneSettings();
          },
        });
      }
      setSessionState('error');
      window.hemiVoice.showMainWindow();
    }
  }, [startAudioCapture, startDuplexCapture, stopAudioCapture, updateConfigForm]);

  const handleHoldStart = useCallback(() => {
    // A call owns the microphone; push-to-talk must not hijack it.
    if (sessionModeRef.current === 'continuous') return;
    if (activeRef.current) return;
    // 032（AC-2）：首启跳过麦克风的用户，首次按住语音入口时就近提示如何
    // 开启——先查实时权限，未授权不出聆听态、不打回引导。
    if (microphonePermission !== 'granted') {
      void window.hemiVoice
        ?.getMicrophonePermissionStatus()
        .then((status) => {
          setMicrophonePermission(status);
          if (status !== 'granted') {
            setRepairHint({
              key: 'microphone',
              title: '麦克风权限未开启',
              detail: '在系统设置中允许后，就能按住 ⌥ 直接说话。',
              actionLabel: '打开系统设置',
              onAction: () => {
                void window.hemiVoice?.openMicrophoneSettings();
              },
            });
            window.hemiVoice?.showMainWindow();
            logChain('hold 跳过：麦克风未授权（就近提示开启）');
          } else {
            handleHoldStart();
          }
        })
        .catch(() => {});
      return;
    }
    // 新一轮聆听隐含打断：正在播报就停掉。
    stopTtsPlayback();
    // 回应就绪或上次失败后再开口，进入新一轮聆听。
    if (turnPhaseRef.current !== 'idle' && turnPhaseRef.current !== 'listening') {
      turnPhaseRef.current = 'listening';
      setTurnPhase('listening');
    }
    activeRef.current = true;
    void startSession('hold');
  }, [microphonePermission, startSession, stopTtsPlayback]);

  const handleHoldEnd = useCallback(() => {
    if (sessionModeRef.current === 'continuous') return;
    if (activeRef.current) void stopSession({ submit: true });
  }, [stopSession]);

  /** 失焦 / pointercancel：单句作废，不隐式提交。 */
  const handleHoldCancel = useCallback(() => {
    if (sessionModeRef.current === 'continuous') return;
    if (activeRef.current) void stopSession({ submit: false });
  }, [stopSession]);

  const handleToggleCall = useCallback(() => {
    if (sessionModeRef.current === 'continuous') {
      // 结束通话：作废在途请求与定时器（旧计时器不得重新唤醒通话），
      // 停掉播报，但不清对话——「结束不是清空」。
      logChain('call 结束');
      invalidateTurn();
      stopTtsPlayback();
      turnPhaseRef.current = 'idle';
      setTurnPhase('idle');
      setTurnError('');
      // 024：静音与 Dock 收起都是通话态，结束时一并复位。
      setCallMuted(false);
      callMutedRef.current = false;
      setDockCollapsed(false);
      primaryFilterRef.current.reset();
      void stopSession();
      return;
    }
    if (activeRef.current) return;

    // Claim continuous mode up front so the controls switch to the call state
    // while the socket is still connecting. The effect below releases it again
    // if the call never comes up and we fall back to idle/error.
    logChain('call 开始（continuous）');
    sessionModeRef.current = 'continuous';
    setSessionMode('continuous');
    activeRef.current = true;
    // 024：新通话从展开的 Dock、非静音起步。
    setCallMuted(false);
    callMutedRef.current = false;
    setDockCollapsed(false);
    // 013：新通话重新锁定（R-06）。状态牌已按用户裁决去掉（2026-09-20）——
    // 锁定状态不再上屏，锁错人的恢复路径就是结束通话重开（这里会重置过滤器）。
    primaryFilterRef.current.reset();
    void startSession('continuous');
  }, [invalidateTurn, startSession, stopSession, stopTtsPlayback]);

  // —— 024 Call Dock：静音与收起 ——
  // 静音＝用户显式关麦：与播报压制共用静音门载体（闭门帧不进云端 ASR），
  // 解除后立即恢复上行；跨渲染帧的判定走 ref。
  const handleToggleCallMute = useCallback(() => {
    setCallMuted((prev) => {
      const next = !prev;
      callMutedRef.current = next;
      if (gateRef.current) gateRef.current.muted = next || ttsActiveRef.current;
      return next;
    });
  }, []);
  const handleExpandDock = useCallback(() => setDockCollapsed(false), []);
  // 顶栏「通话中」按钮在 Dock 展开态点击＝收起（结束通话仍在 Dock 内）。
  const handleCollapseDock = useCallback(() => setDockCollapsed(true), []);

  const handleClearTranscripts = useCallback(() => {
    speechHistoryRef.current = [];
    lastSubmitCountRef.current = 0;
    speechAcceptedCountRef.current = 0;
    setSpeechDraftText('');
    setSpeechDeliveries([]);
    lastMessagesRef.current = [];
    detachTurn();
    stopTtsPlayback();
    turnPhaseRef.current = 'idle';
    setTurnPhase('idle');
    setTurnError('');
    setArchivePayload({ conversationId: null, turns: [] });
    leaveQueueEdit();
    // 024：清场即清草稿（新建/删除当前会话共用此路径）；回卷剪除键随会话作废。
    setDraft('');

    cutKeysRef.current.clear();
    setFrozenTasks({});
  }, [detachTurn, stopTtsPlayback, leaveQueueEdit]);

  /**
   * 2026-10-07 用户裁决：每个新会话的思考档都从「自动」起步。041 的全局档
   * 机制保留（档位仍写默认模型条目、会话中随时可拨），只是进入新对话态时
   * 重置回 default——否则上个会话拨过的档会一直粘到后续所有新会话。
   * 档位本就是 default 时主进程跳过落盘（见 llm.ipc set-thinking-level）。
   */
  const resetThinkingLevelForNewConversation = useCallback(async () => {
    const receipt = await window.hemiVoice
      ?.setThinkingLevel('default')
      .catch(() => null);
    setModelForm((current) => ({
      ...current,
      thinkingLevel: receipt?.thinkingLevel ?? 'default',
    }));
  }, []);

  /**
   * 015 R-02：新建对话——清空对话流并解除会话绑定（首次发言时定新 id）；
   * 旧会话已由防抖自动存档，不受影响。聚焦输入框：用户点「新建对话」的
   * 下一步就是说要说什么，光标直接落位可立即打字（2026-09-28 用户裁决）。
   * 2026-10-06 用户裁决：新对话就是新会话——新对话草稿槽一并丢弃（021 同款
   * 口径；「继续讨论」播种等来源的旧稿不再借新建复活）。
   */
  const handleNewConversation = useCallback(async () => {
    if(!await confirmWorkflowLeave())return;
    navigationSeqRef.current += 1;
    navigationTargetRef.current = null;
    setWorkflowStudioOpen(false); // 059：切回对话页
    flushDraft(); // 030：切走前冲刷已存会话自己的草稿（随会话保留）。
    handleClearTranscripts();
    conversationIdRef.current = null;
    setConversationId(null);
    setConversationTitle('新对话');
    // 048：新会话没有用量——不清会把上一会话的账本（如 6.3M tokens）挂在新对话入口上（2026-10-09 实测）。
    setUsageRecords([]);
    setDraftAttachments([]); // 028：新会话不带旧会话的未发送附件
    setDraftReferences([]);
    // 2026-10-08：模型选择优先恢复上次使用的（取不到/已失效回落默认组）。
    applyConversationProfile(lastUsedProfileForNewConversation());
    applyConversationWorkspace('default'); // 033 R-01：每次新建对话都从默认工作区开始
    void resetThinkingLevelForNewConversation(); // 2026-10-07：新会话思考档重置回「自动」
    clearDraftFor(DRAFT_NEW_KEY); // 2026-10-06：新建＝丢弃新对话草稿槽
    setComposerFocusToken((token) => token + 1);
  }, [applyConversationProfile, applyConversationWorkspace, clearDraftFor, flushDraft, handleClearTranscripts, lastUsedProfileForNewConversation, resetThinkingLevelForNewConversation]);

  /** 015 R-03：从历史列表载入会话——覆盖对话流并接回上下文（点行＝继续聊/回看）。 */
  const handleOpenConversation = useCallback(
    async (id: string) => {
      if(!await confirmWorkflowLeave())return;
      if (!window.hemiVoice) {
        voiceLog.warn('切换会话跳过：hemiVoice 桥不存在');
        return;
      }
      setWorkflowStudioOpen(false); // 059：切回对话页
      // 024：只有实际切到别的会话才清草稿；重复打开当前会话不误清。
      const switching = conversationIdRef.current !== id;
      if (!switching && !navigationTargetRef.current) return;
      const navigation = ++navigationSeqRef.current;
      navigationTargetRef.current = id;
      detachTurn();
      stopTtsPlayback();
      turnPhaseRef.current = 'idle';
      setTurnPhase('idle');
      logChain(`切换会话 → ${id}`);
      try {
        const session = await window.hemiVoice.openConversation(id);
        if (navigation !== navigationSeqRef.current) return;
        // 只复位界面；旧会话请求留在宿主继续运行。
        stopTtsPlayback();
        turnPhaseRef.current = 'idle';
        setTurnPhase('idle');
        setTurnError('');
        applyConversationSession(session);
        navigationTargetRef.current = null;
        if (switching) setDraft('');
        logChain(`载入会话「${session.title}」（${session.turns.length} 条）`);
      } catch (error) {
        // 021 实录：失败只弹提示不留日志，排查时彻底失明——失败必须入日志。
        // 024：读取失败不清草稿。
        if (navigation !== navigationSeqRef.current) return;
        navigationTargetRef.current = null;
        const message = messageFromError(error, '会话读取失败。');
        voiceLog.warn(`切换会话失败（${id}）：${message}`);
        setErrorMessage(message);
      }
    },
    [applyConversationSession, detachTurn, stopTtsPlayback],
  );

  /**
   * 015 D-6：删掉当前打开的会话时解除绑定。
   * 021（2026-09-21 用户重申「新会话就是新会话」）：对话流一并清场——若保留，
   * 防抖存档会把旧任务卡整批写进一个新会话借尸还魂（2026-09-21 实录：携程等
   * 4 张卡复活成「新的对话」，用户误以为应用在跑别的会话的任务）。
   */
  const handleConversationRemoved = useCallback((id: string) => {
    if (conversationIdRef.current !== id) return;
    navigationSeqRef.current += 1;
    navigationTargetRef.current = null;
    invalidateTurn();
    handleClearTranscripts();
    conversationIdRef.current = null;
    setConversationId(null);
    setConversationTitle('新对话');
    setUsageRecords([]); // 048：落回新对话态，旧会话用量不留
    setDraftAttachments([]); // 028：会话删除后准备区一并清空
    setDraftReferences([]);
    // 2026-10-08：同新建对话——优先恢复上次使用的模型选择，失效回落默认组。
    applyConversationProfile(lastUsedProfileForNewConversation());
    applyConversationWorkspace('default'); // 033：删除后落回新对话态（默认工作区）
    void resetThinkingLevelForNewConversation(); // 2026-10-07：落回新对话态，思考档重置回「自动」
  }, [applyConversationProfile, applyConversationWorkspace, handleClearTranscripts, invalidateTurn, lastUsedProfileForNewConversation, resetThinkingLevelForNewConversation]);

  /** 024：侧栏双击重命名落盘后同步顶栏标题（只动当前会话）。 */
  const handleConversationRenamed = useCallback((id: string, title: string) => {
    if (conversationIdRef.current !== id) return;
    setConversationTitle(title);
  }, []);

  /** P1：主进程自动起名落盘后，当前会话的顶栏标题跟着换（侧栏自己订阅重读）。 */
  useEffect(() => {
    const off = window.hemiVoice?.onConversationsChanged?.((event) => {
      if (event?.kind !== 'title' || !event.session) return;
      if (conversationIdRef.current === event.session.id) setConversationTitle(event.session.title);
    });
    return () => off?.();
  }, []);

  /** 032 麦克风步：用户点击才请求系统权限；未过就停在「未开启」说明态。 */
  const handleRequestMicrophone = useCallback(async () => {
    if (!window.hemiVoice) {
      setSetupError('请在 Hemi 客户端中完成权限设置。');
      return;
    }

    setPermissionBusy(true);
    setSetupError('');

    try {
      const granted = await window.hemiVoice.requestMicrophonePermission();
      const status = await window.hemiVoice.getMicrophonePermissionStatus();
      setMicrophonePermission(granted ? 'granted' : status);
    } catch (error) {
      setSetupError(messageFromError(error, '无法检查麦克风权限。'));
    } finally {
      setPermissionBusy(false);
    }
  }, []);

  /** 032 前进/后退：主进程按步骤校验硬门槛，失败原因就地展示。 */
  const handleOnboardingAdvance = useCallback(
    async (to: OnboardingStep, permissionChoice?: 'granted' | 'skipped') => {
      const bridge = window.hemiVoice;
      if (!bridge) return;
      setSavingConfig(true);
      setSetupError('');
      try {
        const result = await bridge.advanceOnboarding({ to, permissionChoice });
        if (!result?.ok) {
          setSetupError(result?.message ?? '这一步没能继续，请重试。');
          return;
        }
        setOnboarding(result.state);
      } catch (error) {
        setSetupError(messageFromError(error, '这一步没能继续，请重试。'));
      } finally {
        setSavingConfig(false);
      }
    },
    [],
  );

  /** 可选语音页：保存密钥并回读核验，然后返回能力页。 */
  const handleSaveAsrKey = useCallback(async () => {
    const bridge = window.hemiVoice;
    const key = asrKeyDraft.trim();
    if (!bridge || !key) return;
    setSavingConfig(true);
    setSetupError('');
    try {
      const saved = await bridge.saveConfig({
        ...configForm,
        apiKey: key,
        resourceId: configForm.resourceId.trim() || DURATION_RESOURCE_ID,
      });
      if (!saved.hasApiKey) {
        setSetupError('密钥没有保存成功，请重新输入。');
        return;
      }
      if (!saved.keyStoredSecurely) {
        setSetupError('本机暂时无法加密保存密钥（系统钥匙串不可用），请稍后重试。');
        return;
      }
      updateConfigForm({
        apiKey: '',
        resourceId: saved.resourceId,
        endpoint: saved.endpoint,
        hasApiKey: true,
        keyStoredSecurely: true,
      });
      const advanced = await bridge.advanceOnboarding({ to: 'capabilities' });
      if (!advanced?.ok) {
        setSetupError(advanced?.message ?? '密钥已保存，但没能返回能力设置，请重试。');
        return;
      }
      setOnboarding(advanced.state);
      setAsrKeyDraft('');
    } catch (error) {
      setSetupError(messageFromError(error, '密钥保存失败，请重试。'));
    } finally {
      setSavingConfig(false);
    }
  }, [asrKeyDraft, configForm, updateConfigForm]);

  /** 完成屏「开始使用」：主进程复核默认模型后写完成版本并刷新主界面。 */
  const handleCompleteOnboarding = useCallback(async () => {
    const bridge = window.hemiVoice;
    if (!bridge) return;
    setSavingConfig(true);
    setSetupError('');
    try {
      const result = await bridge.completeOnboarding();
      if (!result?.ok) {
        setSetupError(result?.message ?? '还没能完成设置，请检查前面的步骤。');
        return;
      }
      setOnboarding(result.state);
      // 完成即刷新模型就绪目录（新会话默认组已就位；语音入口由主进程恢复）。
      await reloadModelProfiles();
      const modelConfig = await bridge.getTextModelConfig();
      setModelForm({
        baseUrl: modelConfig.baseUrl,
        model: modelConfig.model,
        apiKey: '',
        hasApiKey: Boolean(modelConfig.hasApiKey),
        keyStoredSecurely: Boolean(modelConfig.keyStoredSecurely),
        thinkingLevel: modelConfig.thinkingLevel ?? 'default',
        supportsVision: modelConfig.supportsVision !== false,
        visionModel: modelConfig.visionModel ?? '',
      });
      modelReadyRef.current = Boolean(modelConfig.hasApiKey && modelConfig.model.trim());
      setSessionState('idle');
    } catch (error) {
      setSetupError(messageFromError(error, '完成设置失败，请重试。'));
    } finally {
      setSavingConfig(false);
    }
  }, [reloadModelProfiles]);

  /**
   * 032 设置保存解耦：模型组由 031 ModelProfilesSection 独立保存，这里的
   * 总保存只负责语音识别与 TTS；模型就绪在设置关闭后按默认组回读刷新。
   */
  /**
   * P2 设置页自动保存（取代「修改后需保存」＋底部「保存语音设置」——那颗按钮保存后还会
   * 把设置页整个关掉）。两件各存各的、存完不离开设置页；失败抛给设置页就地显示。
   * - 语音播报：开关 / 音色即改即存（saveTtsConfig）。
   * - 语音识别 Key：回车或离开输入框时保存（逐键保存会把半截 Key 落盘）；
   *   主进程复核持久化与加密成功才算数。TTS 与 ASR 同一把豆包 Key，存完同步试听可用态。
   */
  const handleTtsAutoSave = useCallback(
    async (next: Partial<TtsConfigForm>) => {
      const bridge = window.hemiVoice;
      if (!bridge) throw new Error('设置服务未连接。');
      const merged = { ...ttsForm, ...next };
      setTtsForm(merged);
      const saved = await bridge.saveTtsConfig({
        ttsEnabled: merged.ttsEnabled,
        ttsVoice: merged.ttsVoice,
        ttsResourceId: merged.ttsResourceId.trim() || TTS_DEFAULT_RESOURCE_ID,
      });
      setTtsForm((current) => ({
        ...current,
        ttsEnabled: saved.ttsEnabled,
        ttsVoice: saved.ttsVoice,
        ttsResourceId: saved.ttsResourceId,
        hasApiKey: Boolean(saved.hasApiKey),
        keyStoredSecurely: Boolean(saved.keyStoredSecurely),
      }));
    },
    [ttsForm],
  );

  const handleAsrKeyAutoSave = useCallback(
    async (rawKey: string) => {
      const bridge = window.hemiVoice;
      const key = rawKey.trim();
      if (!bridge) throw new Error('设置服务未连接。');
      if (!key) return;
      const saved = await bridge.saveConfig({
        ...configForm,
        apiKey: key,
        resourceId: configForm.resourceId.trim() || DURATION_RESOURCE_ID,
      });
      if (!saved.hasApiKey) throw new Error('密钥没有保存成功，请重新输入。');
      if (!saved.keyStoredSecurely) throw new Error('本机暂时无法加密保存密钥（系统钥匙串不可用），请稍后重试。');
      updateConfigForm({
        apiKey: '',
        resourceId: saved.resourceId,
        endpoint: saved.endpoint,
        hasApiKey: true,
        keyStoredSecurely: true,
      });
      setTtsForm((current) => ({ ...current, hasApiKey: true, keyStoredSecurely: true }));
    },
    [configForm, updateConfigForm],
  );

  const updateModelForm = useCallback((next: Partial<TextModelConfigForm>) => {
    setModelForm((current) => ({ ...current, ...next }));
  }, []);

  /** 033：思考强度拨盘选档——落库（只写档位）并同步表单，下一轮对话即生效。
   *  041 用户裁决：全局一档，永远写默认模型条目（全局槽），不再跟会话选择/
   *  自动路由走；发送侧用各模型自己的 thinkingFormat 映射翻译这一档。
   *  2026-10-07 用户裁决：全局档只在会话内保持——每个新会话重置回「自动」
   *  （resetThinkingLevelForNewConversation）。 */
  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevel) => {
    const receipt = await window.hemiVoice
      ?.setThinkingLevel(level)
      .catch(() => null);
    setModelForm((current) => ({
      ...current,
      thinkingLevel: receipt?.thinkingLevel ?? level,
    }));
  }, []);

  /** 试听：先落当前表单配置（试听的就是所选音色），负数代次避开对话回合号。 */
  const handlePreviewTts = useCallback(async () => {
    const bridge = window.hemiVoice;
    if (!bridge) return;
    const turnId = -Date.now();
    stopTtsPlayback();
    try {
      const saved = await bridge.saveTtsConfig({
        ttsEnabled: true,
        ttsVoice: ttsForm.ttsVoice,
        ttsResourceId: ttsForm.ttsResourceId.trim() || TTS_DEFAULT_RESOURCE_ID,
      });
      setTtsForm((current) => ({
        ...current,
        ttsEnabled: saved.ttsEnabled,
        ttsVoice: saved.ttsVoice,
        ttsResourceId: saved.ttsResourceId,
        hasApiKey: Boolean(saved.hasApiKey),
        keyStoredSecurely: Boolean(saved.keyStoredSecurely),
      }));
      if (!saved.hasApiKey) {
        setErrorMessage('试听失败：未配置豆包 API Key。');
        return;
      }
    } catch (error) {
      setErrorMessage(messageFromError(error, '试听失败：保存配置出错。'));
      return;
    }
    const active: ActiveSpeak = {
      turnId,
      kind: 'preview',
      synthDone: false,
      failed: false,
      failureMessage: '',
      receivedBytes: 0,
    };
    ttsSpeakRef.current = active;
    ttsActiveRef.current = true;
    setTtsActive(true);
    setGateMuted(true);
    ensureBargeIn().reset();
    let result;
    try {
      await ensureTtsPlayer().resume();
      if (ttsSpeakRef.current !== active) return;
      result = await bridge.speakTts({ turnId, text: TTS_PREVIEW_TEXT, preview: true });
    } catch (error) {
      result = { ok: false, message: messageFromError(error, '播放失败。') };
    }
    if (ttsSpeakRef.current !== active) return;
    if (!result?.ok) {
      setErrorMessage(`试听失败：${result?.message ?? '请求失败'}`);
      ttsPlayerRef.current?.stopAll();
      settleReply();
      return;
    }
  }, [ensureBargeIn, ensureTtsPlayer, setGateMuted, settleReply, stopTtsPlayback, ttsForm]);

  /**
   * 019 duplex 事件订阅：cap 帧进共享采集处理（喂门/barge-in/试音/视觉），
   * drained/underrun 对齐 Web Audio 播放器的排空语义，failed 结束通话（R-07）。
   * 旧 preload（未重启的 dev 实例）没有这些方法——`?.` 整体跳过，浏览器链路照常。
   */
  useEffect(() => {
    const bridge = window.hemiVoice;
    if (!bridge?.onDuplexCap) return undefined;

    const offCap = bridge.onDuplexCap((event) => {
      if (!duplexModeRef.current || !activeRef.current) return;
      const gate = gateRef.current;
      if (!gate) return;
      const samples = new Int16Array(event.audio);
      if (!samples.length) return;
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index] / 32768;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / samples.length);
      const frameMs = event.ms > 0 ? event.ms : (samples.length / 16000) * 1000;
      handleCaptureFrame(gate, event.audio, rms, frameMs);
      updateOrbFromRms(rms);
    });
    const offDrained = bridge.onDuplexDrained(() => {
      if (!duplexModeRef.current) return;
      duplexPlayingRef.current = false;
      handlePlaybackDrained();
    });
    const offUnderrun = bridge.onDuplexUnderrun(() => {
      if (duplexModeRef.current) voiceLog.warn('tts 播放断流（duplex）');
    });
    const offState = bridge.onDuplexState((snapshot) => {
      if (snapshot.phase === 'restarting') {
        voiceLog.warn(`duplex 后端重启中（第 ${snapshot.attempt ?? '?'} 次）`);
        return;
      }
      if (snapshot.phase === 'failed') {
        voiceLog.error(`duplex 后端失败：${snapshot.reason ?? '未知'}——结束通话`);
        if (duplexModeRef.current && activeRef.current) void stopSession();
      }
    });
    return () => {
      offCap();
      offDrained();
      offUnderrun();
      offState();
    };
  }, [handleCaptureFrame, handlePlaybackDrained, stopSession, updateOrbFromRms]);

  /** 057：boot 链只跑一次（依赖身份不稳导致的重跑见下述修复说明）。 */
  const bootRanRef = useRef(false);
  useEffect(() => {
    const bridge = window.hemiVoice;
    if (!bridge) {
      setBootstrapping(false);
      return;
    }
    // 配置初始化只跑一次；正式消息始终由当前会话 flow 的只读订阅投影。
    //
    // 2026-10-17 修复（bug#18）：原实现配 cancelled（cleanup 置真、链回调全跳过）——
    // StrictMode 开发模式的双挂载之下，第一次链被 cleanup 废、第二次被 bootRanRef
    // 拦，setBootstrapping(false) 永不执行＝开发模式启动页永久卡「正在读取配置」
    // （2026-10-16 09:05 起每次 npm run dev 均卡；生产无 double-invoke 不受影响）。
    // 语义修正：单页应用窗口生命周期即组件生命周期，真卸载后 setState 为 no-op
    // （React 18+），无需 cancelled；防重跑只由 bootRanRef 承担。
    if (bootRanRef.current) return;
    bootRanRef.current = true;

    document.documentElement.dataset.platform = window.hemiVoice.platform;

    void Promise.all([
      window.hemiVoice.getConfig(),
      window.hemiVoice.getMicrophonePermissionStatus(),
      window.hemiVoice.getUiPreferences(),
      window.hemiVoice.getTextModelConfig(),
      window.hemiVoice.getTtsConfig(),
      window.hemiVoice.getOnboardingState(),
      window.hemiVoice.getLastConversation().catch(() => null),
    ])
      .then(([config, permission, preferences, modelConfig, ttsConfig, onboardingState, lastConversation]) => {
        updateConfigForm({
          resourceId: config.resourceId,
          endpoint: config.endpoint,
          hasApiKey: Boolean(config.hasApiKey),
          keyStoredSecurely: Boolean(config.keyStoredSecurely),
        });
        setMicrophonePermission(permission);
        // 034 v3：悬浮球开关已挪设置页（floating-orb-section 自包含读写），主界面不再镜像。
        setPrimarySpeakerEnabled(preferences.primarySpeakerEnabled === true);
        primarySpeakerEnabledRef.current = preferences.primarySpeakerEnabled === true;
        setModelForm({
          baseUrl: modelConfig.baseUrl,
          model: modelConfig.model,
          apiKey: '',
          hasApiKey: Boolean(modelConfig.hasApiKey),
          keyStoredSecurely: Boolean(modelConfig.keyStoredSecurely),
          thinkingLevel: modelConfig.thinkingLevel ?? 'default',
          supportsVision: modelConfig.supportsVision !== false,
          visionModel: modelConfig.visionModel ?? '',
        });
        modelReadyRef.current = Boolean(
          modelConfig.hasApiKey && modelConfig.model.trim(),
        );
        setTtsForm({
          ttsEnabled: ttsConfig.ttsEnabled,
          ttsVoice: ttsConfig.ttsVoice,
          ttsResourceId: ttsConfig.ttsResourceId,
          hasApiKey: Boolean(ttsConfig.hasApiKey),
          keyStoredSecurely: Boolean(ttsConfig.keyStoredSecurely),
        });
        logChain(
          `启动完成：模型 ${modelReadyRef.current ? `已配置（${modelConfig.model}）` : '未配置（纯转写）'}，ASR ${config.hasApiKey ? '已配置' : '未配置'}，TTS ${ttsConfig.hasApiKey && ttsConfig.ttsEnabled ? `开（${ttsConfig.ttsVoice}）` : '关'}，引导 ${onboardingState?.phase ?? '未知'}`,
        );
        // 032：首启判定以主进程引导状态为权威——麦克风未授权/配置缺失不再
        // 打回引导（AC-2/AC-7），只有 phase=in_progress 才呈现五屏。
        if (onboardingState) setOnboarding(onboardingState);
        else {
          // 旧 preload / 异常兜底：无引导快照时保持主界面，不阻断使用。
          setOnboarding({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'pending', asrSaved: Boolean(config.hasApiKey), modelComplete: modelReadyRef.current });
        }
        // 015 R-01：启动继续上次对话——最近会话全文种子化对话流与上下文。
        if (lastConversation) {
          applyConversationSession(lastConversation);
          if (lastConversation.turns.length) {
            logChain(
              `继续上次的对话「${lastConversation.title}」（${lastConversation.turns.length} 条）`,
            );
          }
        }
        // 030：无会话冷启动＝落在新对话——恢复新对话草稿槽（未发送内容不丢）。
        if (!lastConversation) {
          loadDraftFor('draft-new');
          void resetThinkingLevelForNewConversation(); // 2026-10-07：冷启动新对话态，思考档重置回「自动」
        }
        setConversationReady(true);
      })
      .catch((error: unknown) => {
        setSetupError(messageFromError(error, '无法读取本机配置。'));
        setOnboarding({ version: 1, phase: 'in_progress', step: 'welcome', permissionChoice: 'pending', asrSaved: false, modelComplete: false });
      })
      .finally(() => {
        setBootstrapping(false);
      });
  }, [updateConfigForm, applyConversationSession, loadDraftFor, resetThinkingLevelForNewConversation]);

  useEffect(() => {
    if (!window.hemiVoice) return;

    // 「说完」判定的统一武装点：静音 TURN_END_SILENCE_MS 才提交。到点时若
    // 静音门仍开（用户还在出声——ASR 提前切断、下一句 partial 未到的窗口），
    // 继续等待而不是抢跑提交，否则残句成回合、播报打断用户（2026-09-20 实录）。
    const armTurnSilence = () => {
      if (turnSilenceTimerRef.current !== null) {
        window.clearTimeout(turnSilenceTimerRef.current);
      }
      turnSilenceTimerRef.current = window.setTimeout(() => {
        turnSilenceTimerRef.current = null;
        if (!activeRef.current || sessionModeRef.current !== 'continuous') return;
        if (shouldWaitForSpeech(voiceGateOpenRef.current, interimAdmittedRef.current ? interimTextRef.current : '', performance.now() - lastAsrProgressRef.current)) {
          logChain('回合仍有语音或识别进展 → 推迟提交');
          armTurnSilence();
          return;
        }
        logChain('回合静音 1.2s 到 → 提交');
        submitTurn();
      }, TURN_END_SILENCE_MS);
    };

    return window.hemiVoice.onAsrEvent((event) => {
      if (event.type === 'session.started') {
        updateInterim(interimRef.current.reset());
      }
      if (event.type === 'session.ended') updateInterim('');
      // 松手后只接收最终定稿，不能让收尾的临时结果重新显示为「识别中」。
      if (event.type === 'transcript.partial' && !activeRef.current) return;
      // 旁人定稿也要移除其对应的临时文本，但不能清掉下一句。
      if (event.type === 'transcript.final') {
        updateInterim(interimRef.current.finalize(event), interimAdmittedRef.current);
      }
      // 013 D-4：连接重建/结束＝锁定失效（R-06）——新连接不得复用旧编号。
      if (
        (event.type === 'session.started' || event.type === 'session.ended') &&
        primarySpeakerEnabledRef.current &&
        sessionModeRef.current === 'continuous'
      ) {
        primaryFilterRef.current.reset();
      }
      // 013 D-3：转写采纳过滤——在字幕/历史/回合计时/任务入口之前。
      if (
        primarySpeakerEnabledRef.current &&
        sessionModeRef.current === 'continuous' &&
        (event.type === 'transcript.partial' || event.type === 'transcript.final')
      ) {
        const outcome = primaryFilterRef.current.admitEvent({
          type: event.type,
          text: event.text,
          utteranceId: event.utteranceId,
          speaker: event.speaker ?? null,
        });
        if (outcome.notice) logChain(`013 ${outcome.notice}`);
        if (!outcome.admit) {
          // ASR 的说话人编号通常到二遍定稿才返回。先显示临时识别，但不让未知
          // 说话人推进回合计时、打断播报或触发请求；已知旁人的 partial 仍隐藏。
          if (event.type === 'transcript.partial' && event.text && outcome.preview) {
            updateInterim(interimRef.current.partial(event), false);
          }
          return;
        }
      }
      if (event.type === 'transcript.partial') {
        // 空 partial 不是「识别结果变空」，而是这条响应消息里没有新的临时文本
        // （豆包在句子定稿后、下一句还没识别出字的间隙必然发一条）。拿它清空
        // 会让字幕卡/活区回退显示上一句旧文本（用户报过「闪回一下上次的旧信息」），
        // 也不能拿它推迟「说完」判定。真正的清空点：定稿、会话结束、结束通话。
        if (!event.text) return;
        const nextInterim = interimRef.current.partial(event);
        const changed = nextInterim !== interimTextRef.current;
        if (changed) lastAsrProgressRef.current = performance.now();
        updateInterim(nextInterim);
        // 通话模式：还在说就推迟「说完」判定，静音计时从最新声音重新起算。
        if (
          sessionModeRef.current === 'continuous' &&
          turnPhaseRef.current === 'listening' &&
          changed &&
          turnSilenceTimerRef.current !== null
        ) {
          armTurnSilence();
        }
        return;
      }

      if (event.type === 'transcript.final') {
        // 对话历史同步入列：提交与上下文以它为准，不等 React 渲染。
        const recorded = recordFinal(speechHistoryRef.current, event.text, event.utteranceId);
        speechHistoryRef.current = recorded.history;
        setSpeechDraftText(recorded.history.slice(speechAcceptedCountRef.current).map(entry => entry.text).join('\n'));
        if (recorded.changed) lastAsrProgressRef.current = performance.now();
        logChain(
          `final「${event.text.slice(0, 24)}」（历史 ${speechHistoryRef.current.length} 条，phase=${turnPhaseRef.current}，mode=${sessionModeRef.current ?? 'null'}）`,
        );
        if (sessionModeRef.current === 'continuous' && recorded.changed && recorded.index >= lastSubmitCountRef.current) {
          // A real final can arrive before the local interruption detector.
          // Accept it immediately; leaving it in speaking would never arm a turn.
          if (turnPhaseRef.current === 'speaking') {
            stopTtsPlayback();
            turnPhaseRef.current = 'listening';
            setTurnPhase('listening');
          }
          // idle 一并转回：回合完成后 phase 停在 idle（settle 计时落点），
          // 之前只有重连路径能把 idle 拉回 listening——用户接着说话就全部
          // 卡在「静音判定未武装：phase=idle」被吞（2026-09-20 真机实录，
          // 连续三句无响应直到重启）。
          if (
            turnPhaseRef.current === 'replying' ||
            turnPhaseRef.current === 'error' ||
            turnPhaseRef.current === 'idle'
          ) {
            turnPhaseRef.current = 'listening';
            setTurnPhase('listening');
          }
          // 通话在停顿提交时由宿主停止旧目标后接管；按住说话仍按普通队列受理。

          if (turnPhaseRef.current === 'listening' || turnPhaseRef.current === 'thinking') {
            // 「说完」判定：静音一段时间才提交，因为停顿不等于说完。
            armTurnSilence();
          } else {
            logChain(`静音判定未武装：phase=${turnPhaseRef.current}`);
          }
        }
        return;
      }

      if (event.type === 'error') {
        if (activeRef.current) {
          if (sessionModeRef.current === 'continuous') {
            // Keep the call alive: the socket is rebuilt by the reconnect loop.
            setErrorMessage(event.message);
            scheduleContinuousReconnect();
            return;
          }
          activeRef.current = false;
          sessionModeRef.current = null;
          setSessionMode(null);
          stopAudioCapture();
          setSessionState('error');
          void window.hemiVoice.stopAsr();
        }
        // 032：服务端明确鉴权失败才提示换 Key（AC-7）——网络断连不误报。
        if (/鉴权失败/.test(event.message ?? '')) {
          setRepairHint({
            key: 'asr',
            title: '语音服务密钥需要更新',
            detail: '语音暂不可用，文字对话仍可继续。',
            actionLabel: '去设置',
            onAction: () => {
              setSettingsTarget({ page: 'voice', section: 'recognition' });
              setSettingsOpen(true);
            },
          });
        }
        setErrorMessage(event.message);
        return;
      }

      if (event.type === 'session.ended' && activeRef.current) {
        if (sessionModeRef.current === 'continuous') {
          scheduleContinuousReconnect();
          return;
        }
        activeRef.current = false;
        sessionModeRef.current = null;
        setSessionMode(null);
        stopAudioCapture();
        updateInterim('');
        setSessionState('idle');
        // 单句的提交由 stopSession 在 stopAsr 收完定稿后统一触发，
        // 这里不再重复提交（定稿此刻往往还没到齐）。
      }
    });
  }, [invalidateTurn, scheduleContinuousReconnect, stopAudioCapture, stopTtsPlayback, submitTurn, updateInterim]);

  // 048：用量账本变更（对话轮结束、任务每次模型调用完成）——重取聚合。
  // 数值只在调用完成时更新一次，不逐 token 跳数。
  useEffect(() => {
    if (!window.hemiVoice) return;
    return window.hemiVoice.onUsageChanged((event) => {
      const id = event?.conversationId ?? '';
      if (!id || id !== conversationIdRef.current) return;
      void window.hemiVoice?.getUsageLedger(id)
        .then((view) => {
          if (conversationIdRef.current === id) setUsageRecords(view?.records ?? []);
        })
        .catch(() => { /* 静默：下次变更会再拉 */ });
    });
  }, []);

  useEffect(() => {
    if (!window.hemiVoice) return;

    // TTS 音频与收尾事件：旧代次（已被打断/停掉的播报）一律丢弃。
    const offAudio = window.hemiVoice.onTtsAudio(handleTtsAudioEvent);
    const offState = window.hemiVoice.onTtsState(handleTtsStateEvent);
    return () => {
      offAudio();
      offState();
    };
  }, [handleTtsAudioEvent, handleTtsStateEvent]);

  // 按住说话的两条入口都在本进程之外：全局 Option 快捷键（022，主进程
  // uiohook）与悬浮球长按（下面的命令通道）。2026-09-28 用户裁决：窗口内
  // 「空格按住说话」退役，空格回归普通按键（输入、按钮激活、侧栏键盘排序），
  // 页面不再为此挂键盘监听。
  useEffect(() => {
    if (!window.hemiVoice) return;

    return window.hemiVoice.onFloatingOrbCommand((command) => {
      if (command === 'hold-start') {
        handleHoldStart();
        return;
      }

      if (command === 'hold-cancel') {
        handleHoldCancel();
        return;
      }

      if (command === 'toggle-call') {
        // 悬浮通话按钮（交互稿）：主窗口隐藏时也能直接接通/挂断。
        handleToggleCall();
        return;
      }

      handleHoldEnd();
    });
  }, [handleHoldCancel, handleHoldEnd, handleHoldStart, handleToggleCall]);

  useEffect(() => {
    // 正式对话带作者；尚未受理的语音草稿（定稿＋partial）单独走 interimText：
    // 字幕条按「一句一行」显示，临时结果那一行会被它自己在原地改写。
    // 早先这里把临时结果混进 recentLines，字幕条分不出句子，新句子一来就是
    // 两行一起换掉，看起来像文字在不断往上堆。
    const recentSegments = transcripts
      .slice(-2)
      .map((item) => ({ id: `${conversationId}:${item.id}`, text: item.text, author: item.author }))
      .filter((line) => line.text);

    window.hemiVoice?.publishUiState({
      sessionState,
      isSpeaking,
      interimText: speechPreviewText,
      recentLines: recentSegments,
      errorText: turnError,
      turnPhase,
      elapsedSeconds,
      callActive: sessionMode === 'continuous',
      callMuted,
      ttsActive,
      // 048：思考计时（字幕窗/Dock 用）——正文首字（endedAt 定格）即清。
      thinkingSince:
        streamingThinking && streamingThinking.endedAt == null
          ? streamingThinking.startedAt
          : null,
    });
  }, [
    callMuted,
    conversationId,
    elapsedSeconds,
    speechPreviewText,
    isSpeaking,
    sessionMode,
    sessionState,
    streamingThinking,
    turnError,
    turnPhase,
    transcripts,
    ttsActive,
  ]);

  useEffect(() => {
    if (sessionState !== 'idle' && sessionState !== 'error') return;
    if (sessionModeRef.current === null) return;
    // Central release point: every failure path in `startSession` settles on
    // idle or error, so the listening mode is dropped here instead of in each
    // individual branch.
    sessionModeRef.current = null;
    setSessionMode(null);
    reconnectAttemptRef.current = 0;
  }, [sessionState]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(
      () => setElapsedSeconds((current) => current + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [isActive]);

  // 对话流贴底统一由 voice-screen 的 useSmoothFollow 管（跟随中才贴底；切会话、
  // 用户发出消息强制回底）。原先这里在 transcripts 每次换引用时无条件 smooth
  // scrollTo 到底，用户上翻读历史也被拽回——2026-10-11「轻轻滑动往上自动弹」。

  useEffect(() => {
    return () => {
      activeRef.current = false;
      sessionModeRef.current = null;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (turnSilenceTimerRef.current !== null) {
        window.clearTimeout(turnSilenceTimerRef.current);
        turnSilenceTimerRef.current = null;
      }
      if (replySettleTimerRef.current !== null) {
        window.clearTimeout(replySettleTimerRef.current);
        replySettleTimerRef.current = null;
      }
      // 渲染层卸载只脱离 UI，宿主请求继续并入史；应用退出由主进程统一取消。
      attachedRequestRef.current = null;
      viewEpochRef.current += 1;
      turnIdRef.current += 1;
      // 卸载清理走直接路径：stopTtsPlayback 会 setState，卸载期无意义。
      if (ttsSpeakRef.current) {
        window.hemiVoice?.cancelTts(ttsSpeakRef.current.turnId);
        ttsSpeakRef.current = null;
      }
      if (ttsDuckReleaseTimerRef.current !== null) {
        window.clearTimeout(ttsDuckReleaseTimerRef.current);
        ttsDuckReleaseTimerRef.current = null;
      }
      ttsPlayerRef.current?.dispose();
      ttsPlayerRef.current = null;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (processorRef.current) processorRef.current.onaudioprocess = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioContextRef.current) void audioContextRef.current.close();
      void window.hemiVoice?.stopAsr();
    };
  }, []);

  /** 013：仅响应首位说话人开关（hook 必须在所有提前 return 之前——Rules of Hooks，
   *  否则 setupRequired/bootstrapping 分支下 hook 数量漂移，React 整树卸载＝白屏）。 */
  const handleTogglePrimarySpeaker = useCallback((enabled: boolean) => {
    setPrimarySpeakerEnabled(enabled);
    primarySpeakerEnabledRef.current = enabled;
    void window.hemiVoice
      ?.setPrimarySpeakerEnabled(enabled)
      .then((prefs) => {
        setPrimarySpeakerEnabled(prefs.primarySpeakerEnabled === true);
        primarySpeakerEnabledRef.current = prefs.primarySpeakerEnabled === true;
      })
      .catch(() => {});
  }, []);

  if (bootstrapping) {
    return (
      <main className="setup-shell flex min-h-dvh items-center justify-center">
        <div className="animate-pulse" role="status" aria-label="正在读取配置">
          <BrandIcon className="brand-mark" />
        </div>
      </main>
    );
  }

  if (setupRequired && onboarding) {
    return (
      <SetupScreen
        step={onboarding.step}
        permissionChoice={onboarding.permissionChoice}
        microphonePermission={microphonePermission}
        permissionBusy={permissionBusy}
        saving={savingConfig}
        asrSaved={onboarding.asrSaved}
        asrKeySuffix=""
        asrKeyDraft={asrKeyDraft}
        onAsrKeyChange={setAsrKeyDraft}
        modelSaved={onboarding.modelComplete}
        errorMessage={setupError}
        onRequestMicrophone={() => void handleRequestMicrophone()}
        onAdvance={handleOnboardingAdvance}
        onSaveAsrKey={() => void handleSaveAsrKey()}
        onComplete={() => void handleCompleteOnboarding()}
        onOpenExternal={(url) => void window.hemiVoice?.openExternal(url)}
        onOpenMicrophoneSettings={() => void window.hemiVoice?.openMicrophoneSettings()}
      />
    );
  }

  if (settingsOpen) {
    return (
      <SettingsScreen
        saving={savingConfig}
        config={configForm}
        modelConfig={modelForm}
        ttsConfig={ttsForm}
        primarySpeakerEnabled={primarySpeakerEnabled}
        initialPage={settingsTarget?.page}
        initialModelTab={settingsTarget?.modelTab}
        initialSection={settingsTarget?.section}
        onClose={() => {
          setSettingsTarget(null);
          setSettingsOpen(false);
        }}
        onOpenSkills={() => {
          // 037：设置成为壳内页面——图标栏「技能」先关设置再打开技能中心。
          setSettingsTarget(null);
          setSettingsOpen(false);
          setSkillMarketOpen(true);
        }}
        onConfigChange={updateConfigForm}
        onModelConfigChange={updateModelForm}
        onTogglePrimarySpeaker={handleTogglePrimarySpeaker}
        onPreviewTts={() => void handlePreviewTts()}
        onSaveTts={handleTtsAutoSave}
        onSaveAsrKey={handleAsrKeyAutoSave}
        callStatus={
          sessionMode === 'continuous'
            ? { elapsedSeconds, muted: callMuted }
            : null
        }
        onCallExpand={handleExpandDock}
        onCallEnd={handleToggleCall}
      />
    );
  }

  // —— 024 文字输入的 UI 判定（同步守卫在 handleSubmitText，规则同源：按住录音、
  // ASR 临时稿、定稿未提交三态；连续通话本身不算待提交语音）——
  const holdActive = (sessionState === 'requesting' || sessionState === 'listening') && sessionMode === 'hold';
  const lastTranscript = transcripts[transcripts.length - 1];
  const textPendingSpeech =
    holdActive ||
    speechPreviewText.trim().length > 0 ||
    (turnPhase === 'listening' && lastTranscript?.author === 'user' && lastTranscript.kind !== 'task');

  return (
    <>
      <VoiceScreen
        skillMarketOpen={skillMarketOpen}
        onOpenSkillMarket={async () => {
          if(!await confirmWorkflowLeave())return;
          setSkillMarketOpen(true);
          setWorkflowStudioOpen(false);
        }}
        onCloseSkillMarket={() => setSkillMarketOpen(false)}
        workflowStudioOpen={workflowStudioOpen}
        onOpenWorkflowStudio={() => {
          setSkillMarketOpen(false);
          setWorkflowStudioOpen(true);
        }}
        onCloseWorkflowStudio={async () => {if(await confirmWorkflowLeave())setWorkflowStudioOpen(false);}}
        sessionState={sessionState}
        callActive={isCallActive}
        turnPhase={turnPhase}
        turnStartedAt={Number(flowSnapshot?.runs[flowSnapshot.activeRunId ?? '']?.startedAt) || null}
        elapsedSeconds={elapsedSeconds}
        callMuted={callMuted}
        dockCollapsed={dockCollapsed}
        onToggleCallMute={handleToggleCallMute}
        onExpandDock={handleExpandDock}
        onCollapseDock={handleCollapseDock}
        memoryNotice={
          <MemoryNotices
            items={memoryNotices.items}
            onView={memoryNotices.view}
            onUndo={(item) => void memoryNotices.undo(item)}
            onRestore={(item) => void memoryNotices.restore(item)}
            onToggleDetail={memoryNotices.toggleDetail}
          />
        }
        turnError={turnError}
        streamingReply={streamingReply}
        streamingThinking={streamingThinking}
        usageRecords={usageRecords}
        usageRunning={
          modelBusy ||
          (taskState?.tasks ?? []).some((task) => task.conversationId === conversationId && task.phase !== 'terminal')
        }
        interimText={speechPreviewText}
        transcripts={transcripts}
        conversationLoading={Boolean(conversationId && flowSnapshot?.conversationId !== conversationId)}
        timelineNotice={projection.leftoverTurns ? '此会话的时间线记录不完整，当前按原始记录顺序展示。' : undefined}
        taskState={taskState}
        timelineGeneration={flowSnapshot?.generation ?? 0}
        taskSnaps={taskSnaps}
        onTaskAction={handleTaskAction}
        contextState={contextState}
        contextBusy={contextBusy}
        contextError={contextError}
        onAttachContext={(kind) => void handleAttachContext(kind)}
        onRefreshContext={(id) => void handleRefreshContext(id)}
        onRemoveContext={(id) => void handleRemoveContext(id)}
        onOpenArtifact={(taskId, artifactId, intent) => void handleOpenArtifact(taskId, artifactId, intent)}
        errorMessage={errorMessage}
        repairHint={repairHint}
        onToggleCall={handleToggleCall}
        onRetryTurn={handleRetryTurn}
        textDraft={draft}
        onTextDraftChange={setDraft}
        onTextSend={handleSubmitText}
        onStopModelTurn={handleStopModelTurn}
        onStartEditMessage={handleStartEdit}
        onCancelEditMessage={handleCancelEdit}
        onEditResendMessage={handleEditResend}
        editingMessageId={editingId}
        onContinueDiscuss={handleContinueDiscuss}
        textModelBusy={modelBusy}
        textPendingSpeech={textPendingSpeech}
        textModelReady={Boolean(modelForm.hasApiKey && modelForm.model.trim())}
        onOpenSettings={async () => {
          if(!await confirmWorkflowLeave())return;
          // 2026-10-08 用户裁决：普通设置入口落第一分类「通用」——此前硬编码
          // 「模型与路由」（且 R-07 还会记住上次页），每次打开都不在第一个 tab。
          setSettingsTarget(null);
          setSettingsOpen(true);
        }}
        onOpenModelSettings={async () => {
          if(!await confirmWorkflowLeave())return;
          setSettingsTarget({ page: 'models' });
          setSettingsOpen(true);
        }}
        onNewConversation={handleNewConversation}
        onOpenConversation={(id) => void handleOpenConversation(id)}
        onConversationRemoved={handleConversationRemoved}
        onConversationRenamed={handleConversationRenamed}
        currentConversationId={conversationId}
        conversationTitle={conversationTitle}
        thinkingLevel={modelForm.thinkingLevel}
        onThinkingLevelChange={(level) => void handleThinkingLevelChange(level)}
        discussContext={discussContext}
        onClearDiscussContext={() => setDiscussContext(null)}
        composerFocusToken={composerFocusToken}
        attachments={attachmentViews}
        draftAttachments={draftAttachments}
        flowDeliverables={flowDeliverables}
        attachError={attachError}
        onAttachPaste={(dataUrl) => void handleAttachPaste(dataUrl)}
        onAttachDrop={(filePath) => void handleAttachDrop(filePath)}
        onRemoveAttachment={(attachmentId) => void handleRemoveAttachment(attachmentId)}
        inputHistory={inputHistory}
        mentionConversationId={conversationId}
        mentionWorkspaceId={conversationWorkspaceRef.current}
        draftReferences={draftReferences}
        draftSkills={draftSkills}
        onSetDraftReferences={setDraftReferences}
        onSetDraftSkills={setDraftSkills}
        modelNotice={modelNotice}
        onAddReference={handleAddReference}
        onRemoveReference={handleRemoveReference}
        queueState={queueState}
        queueStoppedIdle={queueStoppedIdle}
        onContinueStoppedTask={handleContinueStoppedTask}
        onPromoteQueued={handlePromoteQueued}
        onReorderQueued={handleReorderQueued}
        onWithdrawQueued={handleWithdrawQueued}
        onResumeQueue={() => {
          const conversationId = conversationIdRef.current;
          if (conversationId) void window.hemiVoice?.resumeTurnQueue(conversationId);
        }}
        onEditQueued={handleEditQueued}
        queueEditing={Boolean(queueEdit)}
        queueEditSaving={queueEditSaving}
        onCancelQueueEdit={() => { if (!queueEditActionRef.current) leaveQueueEdit(); }}
        modelProfiles={modelProfiles}
        currentProfileId={conversationProfileId}
        onSelectModelProfile={handleSelectModelProfile}
        onOpenAutoRoutingSettings={() => {
          // 056：模型路由弹窗关闭——重读目录，「自动路由」就绪随之刷新。
          void reloadModelProfiles();
        }}
        onOpenAccessSettings={async () => {
          if(!await confirmWorkflowLeave())return;
          setSettingsTarget({ page: 'control', section: 'access' });
          setSettingsOpen(true);
        }}
        workspaceState={workspaceState}
        workspaceCurrent={
          !conversationWorkspaceId
            ? { kind: 'legacy' }
            : workspaceCurrentView
              ? { kind: 'view', view: workspaceCurrentView }
              : conversationWorkspaceId === 'default'
                // 登记状态尚未载到的首帧：默认工作区身份固定，先按可用占位。
                ? { kind: 'view', view: { id: 'default', type: 'default', name: '默认空间', dir: '', status: 'ok' } }
                : { kind: 'view', view: { id: conversationWorkspaceId, type: 'project', name: '（已移除的项目）', dir: '', status: 'missing', message: '项目不在列表里（可能已被移除），请重新选择' } }
        }
        workspaceSendBlocked={workspaceMissing}
        onWorkspaceSelect={handleWorkspaceSelect}
        onWorkspaceClear={handleWorkspaceClear}
        onWorkspacePickFolder={() => void handleWorkspacePickFolder()}
        onWorkspaceRemoteAdded={handleRemoteAdded}
        onWorkspaceRetryRemote={(id) => void handleWorkspaceRetryRemote(id)}
        onWorkspaceRemove={(id) => void handleWorkspaceRemove(id)}
      />
      {remotePasswordFor ? (
        <RemotePasswordDialog
          host={remotePasswordFor.host}
          busy={remotePasswordBusy}
          onClose={() => setRemotePasswordFor(null)}
          onSubmit={(password, remember) => void submitRemotePassword(password, remember)}
        />
      ) : null}
    </>
  );
}
