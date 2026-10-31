/**
 * 主进程 ↔ 渲染层的 IPC 协议类型（唯一事实来源）。
 * env.d.ts 用它约束 window.hemiVoice 的形状；渲染层经 '@/shared/types'
 * 的 re-export 消费。只放纯类型，不放任何依赖 DOM 或 Node API 的代码。
 */

import type {AppearanceBootstrap,AppearanceSnapshot,AppearanceSetRequest,AppearanceSetResult,AppearanceApplied,AppearanceActivity} from './appearance/types';
export type {AppearanceBootstrap,AppearanceSnapshot,AppearancePreference,AppearanceSetRequest,AppearanceSetResult,AppearanceApplied,AppearanceActivity,SkinId} from './appearance/types';

export type DoubaoConfig = {
  apiKey?: string;
  resourceId: string;
  endpoint: string;
  hasApiKey?: boolean;
  keyStoredSecurely?: boolean;
};

export type AsrEvent =
  | { type: 'session.started' }
  | { type: 'session.ended' }
  | {
      type: 'transcript.partial';
      text: string;
      utteranceId?: string;
      /** 聚合临时文本的分句身份，用于定稿修订时只移除对应句子。 */
      utterances?: Array<{ text: string; utteranceId?: string }>;
      definite?: boolean;
      /** 013：说话人编号（聚合 partial 仅在全部同编号时携带；未知为 null）。 */
      speaker?: number | null;
    }
  | {
      type: 'transcript.final';
      text: string;
      utteranceId?: string;
      definite?: boolean;
      /** 013：分句说话人编号（0 是有效编号；缺失为 null）。 */
      speaker?: number | null;
    }
  | { type: 'error'; message: string; code?: string | number };

export type AsrStartResult = {
  ok: boolean;
  code?: string;
  message?: string;
};

export type MicrophonePermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

/**
 * How the user drives the microphone.
 * - `hold`: push-to-talk, the session lives only while the button/orb is held.
 * - `continuous`: a call, the session keeps streaming until the user ends it.
 */
export type ListenMode = 'hold' | 'continuous';

/**
 * ASR 会话状态（麦克风那一侧）。
 * - `idle`：没在录；`requesting`：正在接通；`listening`：音频上行中；
 * - `error`：麦克风 / ASR 自身失败——语义是「关闭通话」，与模型失败（turnPhase）不同。
 */
export type SessionState = 'idle' | 'requesting' | 'listening' | 'error';

/**
 * 对话回合状态（模型那一侧）。单句快捷录音也走这套：
 * - `listening`：音频上行；`thinking`：说完等模型；`speaking`：TTS 播报中（可被打断）；
 *   `replying`：回应已就绪（播报结束或不可用后停留）；`error`：模型失败，通话保持。
 */
export type TurnPhase =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'replying'
  | 'error';

/** 字幕条定稿行：文本 + 说话人（Hemi 行要上色）。 */
export type RecentLine = {
  /** 会话与消息的稳定身份，区分相同文案的新消息。 */
  id?: string;
  text: string;
  author: 'user' | 'hemi';
  /** 主进程标记：已在主窗口展示过，字幕不再重播。 */
  captionRead?: boolean;
};

export type WindowActivityView = { visible: boolean };

export type UiState = {
  sessionState: SessionState;
  isSpeaking: boolean;
  /** 正在识别的临时结果（会不断改写），字幕条用单独一行显示它。 */
  interimText: string;
  /** 最近几句**已定稿**的整句；临时结果不要混进来，否则字幕条分不出句子。 */
  recentLines: RecentLine[];
  /** 模型失败提示。独立通路：不进 recentLines（不伪装成 Hemi 的话），也不进模型上下文。 */
  errorText: string;
  turnPhase: TurnPhase;
  elapsedSeconds: number;
  callActive: boolean;
  /** 024：用户在 Call Dock 静音（悬浮窗可据此调整「我在听」类文案）。 */
  callMuted: boolean;
  /** TTS 正在播报（含试听）；悬浮窗「正在说话」由它驱动。 */
  ttsActive: boolean;
  /**
   * 048：模型思考的起点（毫秒时间戳；null＝不在思考）。字幕窗只显示
   * 「思考中 · Ns」计时，不出思考文字；正文首字到达即清（回「正在想」）。
   */
  thinkingSince?: number | null;
};

export type UiPreferences = {
  floatingOrbEnabled: boolean;
  /** 013：仅响应首位说话人（默认关；仅通话模式生效）。 */
  primarySpeakerEnabled: boolean;
  /** 022：全局长按 Option 对话开关（仅 macOS 有此功能）。 */
  globalPushToTalkEnabled: boolean;
  /** 043：长按键规范标识（darwin=option；平台默认由主进程给出）。 */
  globalPushToTalkKey: string;
  /** 022：全局钩子是否真的在跑（开了但缺辅助功能授权时为 false）。 */
  globalPushToTalkReady: boolean;
  /** 022：事件流确认可达（tap 被静默吞事件时为 false，提示补「输入监控」授权）。 */
  globalPushToTalkListening: boolean;
  /** 钩子最近一次启动失败的原文（空串=没有失败）；设置页优先展示它，不误报成缺授权。 */
  globalPushToTalkStartError: string;
};

/** 022：全局按住开关回执（热启停后的钩子状态；startError 供设置页展示原因）。 */
export type GlobalPushToTalkStatus = {
  globalPushToTalkEnabled: boolean;
  globalPushToTalkReady: boolean;
  globalPushToTalkListening: boolean;
  globalPushToTalkStartError: string;
};

// ---------------------------------------------------------------------------
// 043 · 平台能力快照（B1 共享底座）
// 主进程 platform 服务是能力状态的唯一事实来源（technical-plan §能力状态）：
// supported=该构建是否含此实现；enabled=已保存的用户意图；state=实际后端状态。
// 未实测平台一律如实 unknown/unavailable，禁止默认 ready。
// ---------------------------------------------------------------------------

export type CapabilityId =
  | 'microphone'
  | 'audioDuplex'
  | 'pushToTalk'
  | 'desktop'
  | 'browser'
  | 'command'
  | 'systemProxy'
  | 'capture'
  | 'currentPage'
  | 'appCatalog';

export type CapabilityState =
  | 'checking'
  | 'ready'
  | 'blocked'
  | 'unavailable'
  | 'error';

export type CapabilityReason =
  | 'privacy-disabled'
  | 'no-device'
  | 'driver-load-failed'
  | 'desktop-session-unavailable'
  | 'app-catalog-unavailable'
  | 'shortcut-conflict'
  | 'bridge-disconnected'
  | 'backend-not-verified'
  | 'unsupported-proxy'
  | 'probe-failed';

export type CapabilityAction =
  | 'open-microphone-settings'
  | 'recheck'
  | 'change-shortcut'
  | 'manage-extension';

export type Capability = {
  supported: boolean;
  enabled: boolean;
  state: CapabilityState;
  reason?: CapabilityReason;
  actions: CapabilityAction[];
};

export type PlatformShortcutInfo = { key: string; label: string };

export type PlatformSnapshot = {
  platform: 'darwin' | 'win32';
  /** 宿主运行代次：重启后 revision 可从头开始；按 {sessionId, revision} 去重。 */
  sessionId: string;
  revision: number;
  capabilities: Record<CapabilityId, Capability>;
  shortcuts: { pushToTalk: PlatformShortcutInfo | null };
};

/** 平台动作回执：固定动作映射在主进程，渲染层不传 URI/命令。 */
export type PlatformActionResult = { ok: boolean; error?: string };

/** 043：长按键配置统一入口（旧 setGlobalPushToTalkEnabled 映射到同一实现）。 */
export type PushToTalkConfig = {
  globalPushToTalkEnabled: boolean;
  globalPushToTalkKey: string;
  globalPushToTalkReady: boolean;
  globalPushToTalkListening: boolean;
  globalPushToTalkStartError: string;
  /** key 不在当前平台已验证清单时的回执（状态不被改变）。 */
  error?: 'INVALID_INPUT';
};

/**
 * 024：输入来源。触发回合/任务的来源在建档时写入一次，之后不变：
 * 文字来源的回复与任务通知默认静音，语音来源保持既有播报规则。
 */
export type InputSource = 'voice' | 'text';

/**
 * 033：思考强度档位。default＝各厂商提供的中间档位（openai 发
 * reasoning_effort:"medium"，deepseek/zai/qwen 等二值格式发「开思考」），
 * 与执行器侧 SDK 默认档对齐；off/low/medium/high 由主进程
 * services/thinking-level.mjs 按厂商映射成原生字段。
 */
export type ThinkingLevel = 'default' | 'off' | 'low' | 'medium' | 'high';

export type TextModelConfig = {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  keyStoredSecurely: boolean;
  /** 思考强度档位（default=厂商中档；拨盘与设置页共用）。 */
  thinkingLevel: ThinkingLevel;
  /** 主脑模型支持看图（2026-09-20 裁决：视觉模型归模型页配置）。 */
  supportsVision: boolean;
  /** 未勾选支持看图时单独用的视觉模型名（端点与 Key 仍复用主脑模型）。 */
  visionModel: string;
};

export type TextModelSaveConfig = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
  supportsVision?: boolean;
  visionModel?: string;
};

/** 连通性测试：表单当前值（含未保存的 key）可覆盖存储值，缺省字段回落存储。 */
export type ModelTestOverrides = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
};

export type ModelTestResult = {
  ok: boolean;
  /** 探活往返耗时（ok 时才有）。 */
  latencyMs?: number;
  /** 服务端实际使用的模型名——别名（deepseek-v4-flash → deepseek-flash）在这里现形。 */
  resolvedModel?: string;
  /** Jev 决策的置信度（仅 Jev 探活回传）。 */
  confidence?: number | null;
  /** 失败原因（ok=false 时必有，已是可展示的中文）。 */
  error?: string;
  /** 032：失败类别（testModelProfile 返回）——渲染层按类给就地反馈与修复入口。 */
  errorKind?: 'missing' | 'invalid' | 'auth' | 'model' | 'network' | 'timeout';
};

export type ChatTurnPayload = {
  turnId: number;
  /** 渲染层本轮身份，跨导航/重载不与新回合混淆。 */
  requestId?: string;
  messages: Array<{ role: string; content: string }>;
  /** 021 裁决：任务归属会话（依据注入与任务卡按会话隔离）。 */
  conversationId?: string | null;
  /** 024：本轮输入来源（文字回合不触发 TTS，任务建档沿用）；缺省按 voice。 */
  inputSource?: InputSource;
  /** 连续通话在停顿后即时接管旧目标；按住说话沿用普通排队。仅 voice 来源生效。 */
  voiceMode?: ListenMode;
  /** 028：本条消息携带的附件（主进程登记过的 attachmentId；按会话受控解析）。 */
  attachmentIds?: string[];
  /** 057 S3-2：附件视图随消息冻结进 flow 用户项（重载后 chips 不依赖渲染层保存）。 */
  attachmentViews?: MessageAttachmentView[];
  /** 028 二批：`@` 引用（按固定对象身份解析：attachment/artifact/context＋063 四类行内引用）。 */
  references?: Array<{ kind: string; [key: string]: unknown }>;
  /** 063：`/` 显式选中的技能（行内标签身份；派发时校验可用性并注入执行指令）。 */
  skills?: SkillSelectionView[];
  /** 031：会话选中的模型配置组（主进程回合受理时冻结；null/缺省＝默认组）。 */
  profileId?: string | null;
  /** 033：会话绑定的工作区身份（'default' 或项目 id；null/缺省＝旧会话家目录语义）。 */
  workspaceId?: string | null;
};

export type ChatTurnReceipt =
  | { ok: true; inputId: string; disposition: 'started' | 'queued' | 'preempting'; queued?: boolean; runId?: string | null }
  | { ok: false; code: string; message: string };

export type ChatTurnResult = {
  text: string;
  finishReason: string;
  /** 060 S1：宿主受理为排队（忙时有队首）——不等整轮，回答由 flow 投影；
   *  text 为空字符串、inputId 为受理身份（待发送区展示用）。 */
  queued?: boolean;
  inputId?: string;
  /** 主进程已入史的回复身份，渲染层沿用以免重复。 */
  responseId?: string;
  createdAt?: number;
  /**
   * 055 R-01（口）：语音播报用的一句口语（主进程经口压全文所得）。缺省＝
   * 渲染层按旧口径念全文（口的调用失败/未开启时如实降级）。
   */
  speechText?: string;
  /** 055 R-06：播报回合（announce）的出声判定来源（任务建档来源，024 口径）。 */
  inputSource?: 'voice' | 'text';
  /**
   * 048：本回合的思考全文与时长（跨工具轮累计，主进程权威）。模型没思考
   * （档位关闭或模型自行不思考）时缺省。
   */
  thinking?: TurnThinking;
  /** 056：按到达顺序的段（有工具/思考时才带；只有正文时缺省）。 */
  parts?: TurnPart[];
  /** 048：本回合全部模型调用的用量合计（pi-ai 归一口径，跨工具轮累加）。 */
  usage?: TurnUsage;
  /** 055 R-06：本回合派过的工具（大脑 agent 循环的诊断面，不进上下文）。 */
  toolNames?: string[];
};

/**
 * 056：回合内容按到达顺序的段（思考／正文／工具组）——对话流从上往下照实展示。
 * 归约在 src/shared/turn-parts.mjs（主进程快照/落档与渲染层流式共用）。
 */
export type TurnToolCall = {
  id: string;
  tool: string;
  args: Record<string, string | number | boolean>;
  state: 'running' | 'done' | 'error' | 'stopped';
  output?: string;
  outputTruncated?: boolean;
};
/** 059 人工输入（HI 通用节点）：冻结后的表单投影（配置、预览与运行同一 schema）。 */
export interface WorkflowInteractionField {
  fieldId: string;
  key: string;
  label: string;
  type: 'text' | 'choice' | 'file' | 'files';
  required: boolean;
  options?: string[];
  optionsError?: string;
  prefill?: string;
}
export interface WorkflowInteractionAction {
  actionId: string;
  label: string;
  primary: boolean;
  requiredKeys: string[];
  /** 选中该操作后的去向节点标题（只读记录「选中 › 去向」）。 */
  nextTitle?: string | null;
}
export interface WorkflowInteractionProjection {
  interactionId: string;
  nodeId: string;
  title: string;
  status: 'open' | 'responded' | 'expired' | 'cancelled';
  content: string;
  contentIssues: string[];
  fields: WorkflowInteractionField[];
  actions: WorkflowInteractionAction[];
  timeoutNextTitle?: string | null;
  hasTimeout: boolean;
  expiresAt: number | null;
  revision: number;
  draft: { values: Record<string, unknown>; savedAt: number } | null;
  /** 响应已持久但续跑尚未入队；只读记录可用原回执重试。 */
  resumePending?: boolean;
  response: {
    actionId: string;
    actionLabel: string;
    values: Record<string, unknown>;
    submittedAt: number;
    source: 'user' | 'timeout';
  } | null;
}

export type TurnPart =
  | { type: 'thinking'; text: string; startedAt: number; endedAt: number | null; interrupted?: boolean }
  | { type: 'text'; text: string; textId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' | 'unclassified'; phaseSource?: 'provider' | 'contract' }
  | { type: 'tools'; calls: TurnToolCall[] }
  /** 会话成果：同一回合去重，后续回合更新仍可见；同一文件复用预览身份。 */
  | { type: 'file-delivery'; artifactId: string; name: string; host?: string | null; description?: string;
      conversationId?: string; linkPath?: string; contentVersion?: number; size?: number }
  /** 059 执行卡：参数＋进展同卡（flow 的 workflow-card part 投影）。 */
  | {
      type: 'workflow-card';
      card: {
        invocationId: string;
        cardId?: string;
        workflowId?: string;
        workflowRunId?: string;
        conversationId?: string;
        draftRevision?: number;
        executionModel?: WorkflowExecutionModel | null;
        modelLabel?: string;
        title: string;
        status: string;
        currentNodeId?: string;
        completedCount?: number;
        totalCount?: number;
        waitingReason?: string;
        needsReview?: boolean;
        resourceWaiting?: boolean;
        values?: Record<string, unknown>;
        issues?: Array<{ code: string; message: string; field?: string }>;
        ready?: boolean;
        outputs?: Record<string, unknown>;
        fileOutputs?: string[];
        error?: string;
        /** 人工输入挂起时的表单／已提交只读记录（同 schema 渲染）。 */
        interaction?: WorkflowInteractionProjection;
      };
    };

/**
 * 048：轮次思考（pi-ai 归一，两方言同构）。`interrupted`＝回合中途停止，
 * 已收到的思考保留；`truncated`＝超出落盘上限被截尾。
 */
export type TurnThinking = {
  text: string;
  durationMs: number;
  interrupted?: boolean;
  truncated?: boolean;
};

/** 048：轮次用量。input 为未命中缓存部分，output 含思考；genMs＝首个思考或正文分片 → 结束。 */
export type TurnUsage = {
  /** 实际作答的模型（自动路由切备用后为备用）。 */
  modelKey: string;
  modelName: string;
  /** 请求时冻结的型号，避免内部目录键被当成型号展示。 */
  requestedModel?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  genMs: number;
};

/**
 * 048：主进程 → 渲染层的结构化增量事件（同一 llm:delta 通道，按 kind 分派）。
 * 渲染层对未知 kind 一律忽略——新增返回内容类型只加渲染层消费端，不改管道
 * （AC-08 扩展性契约）。`restart`＝自动路由切备用，渲染层清空本轮思考/正文
 * 流式缓冲。
 */
export type LlmDeltaEvent = { conversationId?: string | null; requestId?: string } & (
  | { turnId: number; kind: 'text'; text: string; textId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' | 'unclassified'; phaseSource?: 'provider' | 'contract' }
  | { turnId: number; kind: 'text-start' | 'text-phase'; textId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' | 'unclassified'; phaseSource?: 'provider' | 'contract' }
  | { turnId: number; kind: 'thinking_start' }
  | { turnId: number; kind: 'thinking'; text: string }
  | { turnId: number; kind: 'thinking_end' }
  | { turnId: number; kind: 'message-end' }
  | { turnId: number; kind: 'restart' }
  | { turnId: number; kind: 'activity'; activity: RunActivityView }
  /** 056：主 agent 自己的工具调用（对话流折叠展示；args 为有界摘要）。 */
  | { turnId: number; kind: 'tool_start'; tool: string; toolCallId?: string; args?: Record<string, string | number | boolean> }
  | { turnId: number; kind: 'tool_end'; tool: string; toolCallId?: string; isError?: boolean });

export type ConversationTurnState = {
  conversationId: string | null;
  requestId: string;
  turnId: number;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  text: string;
  thinking: { text: string; startedAt: number; endedAt: number | null } | null;
  /** 056：按到达顺序的段（导航后接回运行中回合时照段还原）。 */
  parts?: TurnPart[];
  result?: ChatTurnResult;
  error?: string;
  /**
   * 055 R-06：主进程驱动的播报回合（任务事件唤醒大脑的转述）——渲染层
   * 采纳时按 result.inputSource 决定是否出声（语音任务才播，024 口径）。
   */
  announce?: boolean;
};

export type TtsConfig = {
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsResourceId: string;
  hasApiKey: boolean;
  keyStoredSecurely: boolean;
};

export type TtsSaveConfig = {
  ttsEnabled?: boolean;
  ttsVoice?: string;
  ttsResourceId?: string;
};

export type TtsSpeakPayload = {
  turnId: number;
  text: string;
  /** 试听（设置页）：不进对话编排。 */
  preview?: boolean;
};

export type TtsSpeakResult = {
  ok: boolean;
  message?: string;
};

/**
 * 主进程推来的 TTS 音频分片（16-bit 单声道 24 kHz PCM）。
 * 019 duplex 模式：音频由主进程直推 duplexd，不进渲染层——此时 audio 缺省，
 * 只有 bytes（渲染层用来计 receivedBytes，驱动「已实际收到音频」判定）。
 */
export type TtsAudioEvent = {
  turnId: number;
  seq: number;
  audio?: ArrayBuffer;
  /** duplex 模式的字节计数（audio 缺省时必有）。 */
  bytes?: number;
};

/** TTS 合成收尾事件：finished = 服务端发完（播完与否看播放器排空）。 */
export type TtsStateEvent = {
  turnId: number;
  phase: 'finished' | 'failed';
  message?: string;
};

/** 019：duplexd 处理后的采集帧（16-bit 单声道 16 kHz PCM，消回声后）。 */
export type DuplexCapEvent = {
  audio: ArrayBuffer;
  ms: number;
};

/** 019：原生双工后端状态（running 含引擎格式；failed 后不再自动重启）。 */
export type DuplexStateEvent = {
  phase: 'running' | 'restarting' | 'fault' | 'failed';
  inFormat?: string | null;
  outFormat?: string | null;
  attempt?: number;
  reason?: string;
  error?: string;
};

/** 019：duplex 启动结果（失败时渲染层回退浏览器链路，不报错弹窗）。 */
export type DuplexStartResult = {
  ok: boolean;
  reason?: string;
  inFormat?: string | null;
  outFormat?: string | null;
  note?: string;
};

export type FloatingOrbCommand =
  | 'hold-start'
  | 'hold-end'
  | 'hold-cancel'
  | 'toggle-call';

export type ScreenPoint = {
  x: number;
  y: number;
};

export type FloatingCaptionLayout = {
  anchorX: number;
  maxWidth: number;
  placement: 'above' | 'below';
};

/**
 * 004 任务状态契约。实现是主进程的 task-manager.mjs（JS），此类型手工人肉同步——
 * 改动任何字段两侧一起改。生命周期状态 + 终态 outcome + 派生位的设计见
 * requirements/004-agent-tool-calls/technical-plan/README.md「任务状态机与编排」。
 */
export type TaskPhase =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'stopping'
  | 'terminal';

export type TaskOutcome =
  | 'complete'
  | 'stopped'
  | 'denied'
  | 'blocked'
  | 'partial'
  | 'unknown'
  | 'startfailed'
  | 'reportfailed';

/** 确认卡按钮（R-11 + 005「永远允许」四钮）。 */
/** 042：task＝本任务允许、persistent＝持续允许。052 R-04 起风险卡也用 task
 * （本任务内同类操作不再询问）；once（允许这次）保留兼容旧调用方。 */
export type TaskPermissionChoice = 'deny' | 'once' | 'task' | 'persistent';

/** 任务动作（task:action）。 */
export type TaskActionName =
  | 'stop'
  | 'decide';

export type TaskEventLogLine = {
  at: number;
  text: string;
};

/** 等待确认的操作请求；倒计时权威值在主进程（切视图不重置）。 */
export type TaskPermissionRequest = {
  id: string;
  summary: string;
  tool: string;
  args: Record<string, unknown>;
  /** 005：自动审查档透传的判定理由（review 改判 ask 时有值），确认卡与日志展示。 */
  note?: string | null;
  /** 042：卡面种类（grant＝授权卡三选一，action＝风险确认卡两钮）。 */
  kind?: 'grant' | 'action';
  /** 042：本卡的选项值（与按钮一一对应；缺省按 action 两钮渲染）。 */
  options?: string[];
  /** 018：请求发出时刻（审批等待计时起点，宿主记录用）。 */
  askedAt?: number;
  remainingMs: number;
};

/** 018：单次工具调用的结构化耗时记录（起止配对；乱序时 startedAt/durationMs 为 null）。 */
export type ToolCallRecord = {
  tool: string;
  startedAt: number | null;
  durationMs: number | null;
  isError: boolean;
  /** executed / not-executed / null（无上报的工具）。 */
  actionState: 'executed' | 'not-executed' | null;
  /**
   * 021 R-12：browser_act 步级摘要（有界脱敏——targetText 只取元素行前 24 字）。
   * status 为 done/low-confidence/blocked/verify-failed/circuit 系列/error/aborted；
   * reason 为结构化失败原因；steps 每步含操作/两类置信度/耗时/目标元素文本；
   * verifyRounds 为每轮 DONE 核验结果（0.2.2 复盘批次）。
   */
  browser?: BrowserControlRecord | null;
};

/** 021：browser_act 一次调用的步级结构化摘要（历史记账与任务详情同源）。 */
export type BrowserControlRecord = {
  status: string | null;
  reason: string | null;
  errorKind: string | null;
  elapsedMs: number | null;
  /** 收到 ok 回执的副作用动作数（执行事实：终态≠执行状态）。 */
  executedEffects: number | null;
  steps: Array<{
    n: number | null;
    op: string | null;
    target: number | null;
    /** 0.2.2 复盘批次：目标元素行文本（24 字内有界）——复盘时对得上现场。 */
    targetText: string | null;
    status: string | null;
    confidence: number | null;
    operationConfidence: number | null;
    targetConfidence: number | null;
    decideMs: number | null;
    actMs: number | null;
  }>;
  /** 0.2.2 复盘批次：每轮 DONE 核验结果（最近 3 轮），verify-failed 可归因。 */
  verifyRounds: Array<{ stable: boolean; satisfied: number | null; error: string | null }>;
  evidence: { title: string; url: string } | null;
};

/** 018：一次任务的审批等待累计。 */
export type TaskApprovalStats = { count: number; totalWaitMs: number };

/** 010：结构化核验记录（报告内嵌【核验】段解析；快照/档案/摘要同源）。 */
export type TaskVerification = {
  verdict: 'complete' | 'partial' | 'unknown';
  evidence: string[];
  unchecked: string[];
  at: number;
};

/** 012 任务产物（文件或 https 结果链接）。 */
export type TaskArtifact = {
  id: string;
  kind: 'file' | 'link';
  name: string;
  path?: string;
  url?: string;
  registeredAt?: number | null;
  /** file 专有：实时查证的可用性（不缓存为真；快照里未查证可为 undefined）。 */
  available?: boolean;
  size?: number | null;
  /** 可执行产物只定位（Finder 显示），不自动运行。 */
  executable?: boolean;
  /** 025：交付分组角色（main=主成果 / attachment=附件）；旧档案缺省。 */
  role?: 'main' | 'attachment';
  /** 025：登记时申报的媒体类型（如 text/csv）；仅展示用。 */
  mediaType?: string;
  /** 049：远端产物的 SSH 主机（有 host＝不提供本机打开/访达，改预览＋下载）。 */
  host?: string;
  /** 050：声明时的一句话说明（register_delivery v2 files[].description）。 */
  description?: string;
  /**
   * 050 R-08：可用状态（宿主查证结果，不落盘为事实——后来删除文件只影响
   * 可用状态，不改原任务终态）。未查证＝快照里缺省。
   */
  availability?: TaskArtifactAvailability;
};

/** 050 R-08 文件可用状态（完成时／历史加载／打开前查证）。 */
export type TaskArtifactAvailability = {
  state: 'unchecked' | 'ok' | 'missing' | 'unreadable' | 'undecodable' | 'unsupported';
  reason?: string;
  checkedAt?: number;
};

/** 050 R-05：来源（执行器声明 ∩ 宿主访问记录；未访问的声明标「未访问」）。 */
export type TaskSourceRef = {
  title: string;
  url: string;
  visited: boolean;
};

/** 050 R-06：文件改动清单（宿主按工具记录＋git 快照统计）。 */
export type TaskFileChanges = {
  files: Array<{
    path: string;
    fromPath?: string;
    kind: 'A' | 'M' | 'D' | 'R';
    add: number | null;
    del: number | null;
    source: 'tool' | 'git';
    attribution: 'task' | 'uncertain';
    /** 050 R-22：有「首次修改前 vs 最终」的 Diff 快照（无＝不显示入口）。 */
    diffAvailable?: boolean;
  }>;
  /** 非 git 目录只有工具记录，界面标「命令改动未完整统计」。 */
  coverage: 'tools' | 'tools+git';
  /** 快照失败/超时原因（降级如实可见）。 */
  degraded: string | null;
  /** 未列入的临时文件数。 */
  tempExcluded: number;
};

/**
 * 025 内容块（经主进程 delivery.mjs 校验后的形状；渲染卡片/报告/HTML 导出同源消费）。
 * section 只允许一层嵌套；image 的 artifactId 由宿主绑定到已登记文件产物。
 */
export type DeliveryBlock =
  | { type: 'p'; text: string }
  | {
      type: 'metrics';
      items: Array<{ label: string; value: string; unit?: string; note?: string }>;
    }
  | { type: 'table'; caption?: string; columns: string[]; rows: string[][] }
  | {
      type: 'checklist';
      groups: Array<{ title?: string; items: Array<{ text: string; note?: string }> }>;
    }
  | { type: 'section'; title: string; blocks: DeliveryBlock[] }
  | { type: 'image'; artifactId: string; caption?: string };

/** 025 来源条目（宿主分配 id；url 只认 https）。 */
export type DeliverySource = {
  id: string;
  title: string;
  url?: string;
  note?: string;
};

/**
 * 025 结构化交付（register_delivery 校验后的落档形状；实现是主进程
 * delivery.mjs / register.mjs，此类型人肉同步）。旧档案/未登记任务为 null。
 */
export type TaskDelivery = {
  schemaVersion: 1;
  /** 呈现载体：card=结果卡 / report=报告网页 / file=主成果是文件。 */
  form: 'card' | 'report' | 'file';
  /** 内容结构：四类卡 + 报告。 */
  kind: 'summary' | 'comparison' | 'checklist' | 'receipt' | 'report';
  title: string;
  /** 一句核心结论。 */
  summary: string;
  blocks: DeliveryBlock[];
  sources: DeliverySource[];
  /** 主成果 / 附件的产物 ID（指向任务档案 deliverables；由宿主解析绑定）。 */
  mainArtifacts: string[];
  attachmentArtifacts: string[];
  /** 形式选择理由（R-12 本地诊断，不进主阅读内容）。 */
  reason?: string | null;
  /** 部分完成：未完成事项与说明。 */
  partial?: { missing?: string[]; note?: string } | null;
  /** 降级备注（超限截断、文件/图片未登记等；R-12 可追溯）。 */
  degraded?: string[];
  /** 展示生成失败原因（原任务事实状态不受影响）。 */
  presentationError?: string | null;
  registeredAt?: number | null;
};

export type TaskStateSnapshot = {
  /** 兼容字段：单任务快照的任务身份序号；顶层请使用 stateSeq 判断新旧。 */
  seq: number;
  /** 顶层状态广播版本；多任务并行时始终单调递增。旧客户端/历史快照可缺省。 */
  stateSeq?: number;
  /** 017：稳定任务键（`t<seq>`，本进程内唯一；卡片身份与动作寻址用）。 */
  key: string | null;
  /** 009/012：稳定任务 ID（产物与历史寻址用）；null＝尚无档案。 */
  taskId: string | null;
  /** 021 裁决：提交会话归属（渲染层只在本会话渲染任务卡）。 */
  conversationId?: string | null;
  /** 024：建档来源（文字任务的自动播报静音判定）；旧快照缺省按 voice。 */
  inputSource?: InputSource;
  /** 033：受理时冻结的工作区快照（任务卡归属显示）；null/缺省＝旧任务家目录语义。 */
  workspace?: TaskWorkspaceSnapshot | null;
  phase: TaskPhase;
  outcome: TaskOutcome | null;
  /** 任务原文（用户那句话）。 */
  taskText: string;
  /** 进度行文案（无总数时不伪造计数，R-13）。 */
  progressText: string;
  /** 子任务自身的展示对话；不进入主 agent 的对话正文或上下文。 */
  conversation?: {
    revision: number;
    truncated?: boolean;
    messages: Array<{ id: string; author: 'user' | 'hemi'; text: string; createdAt: number; parts?: TurnPart[] }>;
  } | null;
  /** 宿主的后台命令/资源等待事实，供任务详情和恢复投影使用。 */
  activity?: RunActivityView | null;
  /** 2026-09-26：任务开始时间戳——运行中任务卡「已跑 X 分钟」用；旧快照缺省。 */
  startedAt?: number | null;
  /** 含核验与回炉总结的终态时刻；旧快照可缺省。 */
  endedAt?: number | null;
  /** 005：最近一次阶段性成果（【阶段】协议抽取，模型只报「大结果」），语音播报与字幕用。 */
  stageText?: string | null;
  /** 派生位：至今只发生过只读操作（交互稿 reading 相位）。 */
  readOnly: boolean;
  /** 派生位：正在只读复核（交互稿 checking 相位）。 */
  verifying: boolean;
  /** partial/unknown 已核实（checkResult 完成后）。 */
  verified: boolean;
  permission: TaskPermissionRequest | null;
  queueCount: number;
  /** 007：已并入在途任务的补充指令数（任务卡「＋N」徽标）。 */
  steeredCount: number;
  log: TaskEventLogLine[];
  /** 050 语义变更：用户正文 Markdown（执行器最后一条消息，终态定稿）；denied/blocked 为空。 */
  resultText: string | null;
  /** 050：正文版本（渲染去重身份＝taskId+resultVersion）；旧快照缺省 0。 */
  resultVersion?: number;
  /** 050：正文来源（executor / fallback-report / legacy-delivery / legacy-result）。 */
  bodySource?: 'executor' | 'fallback-report' | 'legacy-delivery' | 'legacy-result' | null;
  /** 050：语音短交代（回炉产物）——TTS/字幕读这里，不念正文；旧快照缺省。 */
  speechText?: string | null;
  /** 050：附带提醒（submit_task_result notices；不参与终态判定）。 */
  notices?: string[];
  /** 050：来源（声明 ∩ 访问记录，收尾定稿）。 */
  sources?: TaskSourceRef[];
  /** 050：文件改动清单（宿主统计）；旧档案缺省＝未记录。 */
  fileChanges?: TaskFileChanges | null;
  /** 终态原因（拒绝/拦截/启动失败/断连），denied/blocked/startfailed/unknown 用。 */
  outcomeReason: string | null;
  /** 010：结构化核验记录；null＝没有核验证据（无核验段/无法确认/空报告）。 */
  verification: TaskVerification | null;
  /** 026：结构化收尾提交；旧快照缺省。 */
  taskResult?: {
    schemaVersion: 1;
    proposedVerdict: 'complete' | 'partial' | 'unknown';
    summary?: string;
    checks: Array<{ target: string; status: 'satisfied' | 'unsatisfied' | 'unknown'; evidence: string }>;
    missing: string[];
    sideEffects: string[];
    submittedAt?: number;
  } | null;
  /** 012：已登记产物（live 卡实时更新；可用性在打开/历史详情时实时查证）。 */
  artifacts: TaskArtifact[];
  /** 025：结构化成果（结果卡/报告入口）；未登记或旧快照为 null。 */
  delivery?: TaskDelivery | null;
  /** 最近一次工具动作（任务卡的「目标/命令」明细与确认卡上下文用）。 */
  lastAction: { tool: string; args: Record<string, unknown> } | null;
  /** 018：最近工具调用的结构化耗时记录（截尾 20 条）。 */
  recentToolCalls?: ToolCallRecord[];
  /** 018：审批等待累计（次数与总等待毫秒）。 */
  approvals?: TaskApprovalStats | null;
  /** 017：终态延续任务的来历（「续自」徽标）；普通任务为 null。 */
  resumedFrom?: { taskId: string; taskText: string } | null;
  /** 056：子 agent 角色（explorer/oracle/fixer/designer）与显示名（任务卡徽标）。 */
  agent?: string;
  agentTitle?: string;
  /** 056：是否后台派出。 */
  background?: boolean;
  /** 056：本子会话的运行次数（续用时递增）。 */
  runs?: number;
  /** 056：发起本次运行的主 agent task 工具调用 id（对话流据此把子 agent 行放在调用处）。 */
  toolCallId?: string | null;
  /** 064：工具调用 ID 只在所属根目标内关联，不能串到其他运行的同名调用。 */
  rootRunId?: string | null;
  /**
   * 056：主 agent 自己的确认请求（仅顶层快照携带）——它不是任务，没有任务卡；
   * 渲染层与子 agent 的等待卡合并按序出卡，decide 用 key 定向。
   */
  agentPermissions?: Array<{
    key: string;
    taskId: string;
    conversationId: string | null;
    inputSource?: InputSource;
    taskText: string;
    permission: TaskPermissionRequest;
  }>;
  /**
   * 017：仅顶层快照（bundle）携带——全量任务列表（017 多任务并行）。
   * 列表内的单任务快照不再嵌套本字段。顶层其余字段镜像自主任务
   * （最新一个非终态任务），供悬浮字幕等旧消费方兼容。
   */
  tasks?: TaskStateSnapshot[];
};

/** 006 computer use 配置（设置页电脑控制区块读写；视觉模型归模型页）。 */
export type ComputerUsePreferences = {
  enabled: boolean;
};

/** 006 macOS 权限状态（null＝探测失败/未知）。 */
export type VisionPermissionStatus = {
  screenRecording: boolean | null;
  accessibility: boolean | null;
};

/** 014 浏览器操控配置（扩展桥；开关默认关）。 */
export type BrowserControlPreferences = {
  enabled: boolean;
};

/** 020 browser_act（Jev 步进）配置：开关默认开（D-1），免 key 不上场。 */
export type BrowserActPreferences = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

/** 2026-09-26：执行器终端命令代理开关状态（applied＝实际注入 env 成功）。 */
export type ShellProxyStatus = {
  enabled: boolean;
  applied?: boolean;
  proxy?: string | null;
};

/** 014 浏览器桥运行态（Pi 扩展写、设置页读；off＝本会话尚无浏览器任务）。 */
export type BrowserBridgeStatus = {
  state: 'off' | 'connecting' | 'ready' | 'error';
  detail: string | null;
  port: number | null;
  updatedAt: number | null;
  /** 021：已接入 Chrome 扩展自报的版本；null＝旧扩展未上报（指引重载）。 */
  extVersion: string | null;
  backend?: 'extension' | 'headless' | null;
  extensionConnected?: boolean;
  headlessTasks?: number;
};

/** web 检索配置（设置页读写；key 明文不出主进程，回执只带 hasApiKey）。 */
export type WebSearchPreferences = {
  enabled: boolean;
  hasApiKey: boolean;
  provider: string;
};

/** 005 权限偏好（设置页读展示）。 */
/** 042：授权状态 DTO（设置页与范围浮层只读消费；无令牌与内部路径）。 */
export type AccessStateDto = {
  health: string;
  revision: number;
  grants: Array<{
    grantId: string;
    resourceId: string;
    capability: 'access' | 'edit';
    lifetime: 'task' | 'persistent';
    taskId?: string | null;
  }>;
  /** 2026-10-15 起只有应用资源（文件夹授权退役）。 */
  resources: Array<{
    resourceId: string;
    type: 'app';
    displayName?: string;
    uiEnabled?: boolean;
  }>;
  writeFailure?: { operation: string; affectedResourceIds: string[] } | null;
};

/**
 * 043 B2a：添加授权的应用条目（替换 042 的 AccessApplicationRow）。
 * rowId 只负责列表选择与键盘移动；appRef 是主进程签发的可过期宿主引用，
 * 提交时主进程复核目录代次与真实 OS 身份；名称/位置仅用于展示，不是身份。
 */
export type ApplicationChoice = {
  rowId: string;
  name: string;
  platform: 'darwin' | 'win32';
  ref: { appRef: string; catalogRevision: number };
  running: boolean;
  /** 系统应用图标 dataURL（取不到为 null，界面退首字 tile）。 */
  icon?: string | null;
  source: {
    kind: 'bundle' | 'package' | 'executable';
    /** 验证过才展示为发布者；不由模型或清单字符串提供。 */
    publisher?: string;
    locationLabel: string;
  };
  /** 宿主核对已有授权后给出；用于「已添加」态，非选择键。 */
  addedResourceId?: string;
};

export type AccessMutationResult = {
  ok: boolean;
  revision?: number;
  errorCode?: string;
  grantId?: string;
  resourceId?: string;
};

/** 008 工作对象种类（视图层不含正文与图片本体，快照权威在主进程内存）。 */
export type WorkContextKind = 'web' | 'file' | 'image';

/** Original runtime files, transported without parsing into memory entities. */
export type AgentRuntimeFile = { path: string; size: number; modifiedAt: number };
export type AgentEnvironmentSnapshot = {
  owner: string;
  memoryDir: string;
  files: AgentRuntimeFile[];
  summaryUsageIncluded: boolean;
};

/** 008 附加动作：网页 / 选中文件（访达选中优先、浏览窗兜底，2026-09-20 合并）/ 系统交互截图。 */
export type WorkContextAttachKind = 'web' | 'file' | 'screenshot';

/** 008 来源条上的单个对象视图。 */
export type WorkContextObjectView = {
  id: string;
  kind: WorkContextKind;
  /** 来源大类文案（网页 / 文件 / 图片文件 / 截图）。 */
  source: string;
  title: string;
  /** 网页 URL 或文件路径；截图为空。 */
  detail: string;
  /** 读取范围（全文 N 字 / 仅标题与链接 / 窗口/区域截图…）。 */
  scope: string;
  capturedAt: number;
};

export type WorkContextState = {
  objects: WorkContextObjectView[];
};

export type WorkContextAttachResult = {
  ok: boolean;
  cancelled?: boolean;
  state: WorkContextState;
};

/**
 * 028：本条消息附件的登记视图（渲染层只持元数据，原始字节只在主进程）。
 * status='failed' 只出现在历史快照回看（原文件失效）；登记失败本身不产生记录。
 */
export type MessageAttachmentView = {
  attachmentId: string;
  conversationId: string;
  name: string;
  kind: 'text' | 'image';
  sizeBytes: number;
  status: 'ready' | 'failed';
  /** 失败原因／读取提示（status=failed 时给用户看）。 */
  message?: string;
  source: 'picker' | 'drop' | 'paste';
  /** 文件类附件的来源路径（粘贴图片为空串）。 */
  originPath?: string;
  registeredAt: number;
  /** 图片附件的小缩略图（data URL，长边 ≤144px，登记时生成；随消息入档，跨重启仍可显示）。 */
  thumbnailUrl?: string;
  /** 粘贴图片的受控暂存路径（重启后预览读取的回退寻址，主进程只认暂存区内的图片）。 */
  stagedPath?: string;
};

/**
 * 028 二批：`@` 引用视图（草稿芯片与历史快照共用；身份字段随 kind 携带）。
 * 063：新增行内引用三类——workflow／file／folder／conversation（工作区范围）。
 * 旧三类（attachment／artifact／context）沿用托盘芯片形态与既有解析；新类型
 * 以「类型图标＋@名称」行内标签进正文，身份字段随 kind 携带、按固定身份解析。
 */
export type MessageReferenceView = {
  kind: 'attachment' | 'artifact' | 'context' | 'workflow' | 'file' | 'folder' | 'conversation';
  key: string;
  name: string;
  subtitle: string;
  attachmentId?: string;
  taskId?: string;
  artifactId?: string;
  contextId?: string;
  /** workflow：引用的已保存定义（published revision）。 */
  workflowId?: string;
  workflowRevision?: number;
  /** file／folder：工作区内相对路径（本机／远端统一 POSIX 形态）。 */
  refPath?: string;
  /** conversation：被引用对话的稳定会话 id（不切换当前会话）。 */
  targetConversationId?: string;
};

/**
 * 063：`/` 选中的技能标签（正文行内标签的身份载荷）。token＝正文中该标签的
 * 完整文字（技能名）；派发时按 skillId＋source 校验可用性，不按显示名换技能。
 */
export type SkillSelectionView = {
  token: string;
  name: string;
  source: 'library' | 'project';
  skillId: string;
  /** 选择时的短说明快照（详情气泡展示；不以此代替执行校验）。 */
  description?: string;
};

/**
 * 063：`/` 首层候选（命令 + 技能；与生产装配同源——技能来自当前会话/工作区
 * 的生产解析结果，不自行遍历另一套目录）。首层不平铺模型。
 */
export type SlashCommandCandidate = {
  id: 'model';
  name: string;
  description: string;
};

export type SlashSkillCandidate = {
  skillId: string;
  name: string;
  description: string;
  source: 'library' | 'project';
};

export type SlashCandidatesResult = {
  commands: SlashCommandCandidate[];
  skills: SlashSkillCandidate[];
  /** 技能读取失败（命令分组仍可用；面板如实展示失败态，不隐藏能力入口）。 */
  skillsError?: string;
};

/** 028：附件登记／移除的回执（attachments＝该会话当前全部草稿附件）。 */
export type ComposerAttachmentResult = {
  ok: boolean;
  cancelled?: boolean;
  attachment?: MessageAttachmentView;
  code?: string;
  attachments?: MessageAttachmentView[];
};

/** 026/028：预览受控读取的统一结果形状（成果与附件共用；code 见附件错误码）。 */
export type ArtifactPreviewResult = {
  ok: boolean;
  kind?: 'text' | 'image';
  markdown?: boolean;
  text?: string;
  dataUrl?: string;
  message?: string;
  code?: string;
};

export type AttachmentDocumentPreview = {
  ok: boolean;
  format?: 'pdf' | 'docx' | 'xlsx' | 'pptx';
  bytes?: Uint8Array;
  sheets?: Array<{ name: string; rows: Array<Array<{ address: string; value: string; formula?: string }>>; truncated: boolean }>;
  message?: string;
};

/**
 * 009 任务历史视图（列表项）。corrupt＝记录文件损坏（AC-06 可见不可静默）。
 * 终态语义与 TaskOutcome 一致；interrupted＝重启补标的「执行中断/待核实」；
 * pendingOnly＝排队时退出，未执行且不会自动重放。
 */
export type TaskHistoryView = {
  taskId: string;
  taskText: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: TaskOutcome | null;
  outcomeReason: string | null;
  interrupted: boolean;
  pendingOnly: boolean;
  steeredCount: number;
  hasReport: boolean;
  /** 025：有已登记的结构化交付（详情里渲染结果卡）。 */
  hasDelivery?: boolean;
  corrupt?: boolean;
  /** 024：建档来源（历史详情/恢复用）；旧档案缺省按 voice。 */
  inputSource?: InputSource;
};

export type TaskHistoryList = {
  tasks: TaskHistoryView[];
  storageError: string | null;
};

/** 009 完整记录（详情）：事实档案，只读展示。 */
export type TaskHistoryRecord = TaskHistoryView & {
  contextExcerpt: string;
  resultText: string | null;
  report: string | null;
  steers: Array<{ text: string; accepted: string; at: number }>;
  events: Array<{ at: number; text: string }>;
  /** 010：核验记录（append-only；空＝没有核验证据，不反向解释为已核实）。 */
  verifications: TaskVerification[];
  /** 012：产物（历史详情里经实时查证，带 available/size）。 */
  deliverables: TaskArtifact[];
  /** 025：结构化交付（结果卡/报告数据源）；旧档案/未登记为 null。 */
  delivery: TaskDelivery | null;
};

export type TaskHistoryActionResult = {
  ok: boolean;
  message?: string;
  resultText?: string | null;
};

/** 015 会话条目：对话流原样落盘；任务卡条目携带冻结快照，载入后重建卡片。 */
export type ConversationTurn = {
  id: string;
  text: string;
  createdAt: number;
  author: 'user' | 'hemi';
  /** 024：输入来源（用户消息建档写入；旧档缺省 voice，仅文字可编辑重发）。 */
  inputSource?: InputSource;
  /** 024 消息编辑：被编辑的时间戳（存在即显示「已编辑」）。 */
  editedAt?: number;
  /** 029 排队撤回：排队消息被撤回（原位转「已撤回，未发送」；不再复用旧编辑标记）。 */
  withdrawn?: boolean;
  /**
   * kind='task'：任务卡条目（taskSeq 关联快照）。
   * 2026-10-07 会话审计：kind='error'＝聊天回合失败留痕（正文＝失败原因），
   * 渲染层按 kind 不进模型上下文。
   */
  kind?: 'task' | 'error';
  taskSeq?: number;
  /** 任务卡的稳定身份（主进程 taskId 全局唯一）；seq 跨会话会撞号，渲染层对卡认它。 */
  taskId?: string;
  /** 017：稳定任务键（`t<seq>`）；卡身份优先用它，旧档退 taskId／s<seq>。 */
  taskKey?: string;
  taskSnap?: TaskStateSnapshot;
  taskFrozen?: boolean;
  /** 063：用户轮随档冻结的引用（含 workflow/file/folder/conversation 行内引用）。 */
  references?: MessageReferenceView[];
  /** 063：用户轮随档冻结的显式技能选择（行内标签身份；重启历史回显用）。 */
  skills?: SkillSelectionView[];
  /** 048：本条 hemi 回应的思考与用量（随档案落盘；中断轮标 interrupted）。 */
  thinking?: TurnThinking;
  parts?: TurnPart[];
  usage?: TurnUsage;
};

/**
 * 048 D7：会话用量账本的记录单元（对话侧每次物理模型调用一条；任务执行侧
 * 按模型聚合后以 source='task' 行并入查询结果）。source：chat＝对话轮（主
 * 模型）；fallback＝自动路由切备用；summary＝任务回炉/核验补判；title＝
 * 自动标题；task＝任务执行（按模型汇总，calls＝物理调用次数）。`missing`
 * ＝服务未回用量的调用计数（不编造数字，面板注明）。
 */
export type UsageRecord = {
  /** 实际请求所属角色；旧账本未记录时保持缺省，不按模型反推。 */
  role?: 'main' | 'explorer' | 'oracle' | 'fixer' | 'designer' | 'auxiliary';
  purpose?: string;
  coverage?: 'complete' | 'unknown';
  costStatus?: 'unknown' | 'known';
  source: 'chat' | 'fallback' | 'summary' | 'title' | 'task';
  modelKey: string;
  modelName: string;
  providerName?: string;
  requestedModel?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  genMs: number;
  at: number;
  /** 任务执行行：聚合的调用次数与缺用量次数。 */
  calls?: number;
  missing?: number;
  /** 对话侧行：归属的任务（回炉/补判对应任务）。 */
  taskId?: string;
};

/** 048：会话用量账本查询结果（对话侧明细＋任务执行按模型汇总）。 */
export type UsageLedgerView = {
  conversationId: string;
  records: UsageRecord[];
};

/** 上下文容量：分类明细（字符估算比例，按总量等比缩放）。 */
export type ContextUsageCategoryView = {
  key: 'tools' | 'conversation' | 'toolResults' | 'system';
  label: string;
  tokens: number;
  percent: number;
};

/** 上下文容量快照（tokens/percent 为 null＝压缩后未确认，等待下一轮回复）。 */
export type ContextUsageSnapshotView = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  categories: ContextUsageCategoryView[];
  unknownReason?: 'compaction';
};

/** 上下文容量查询结果（无在途主会话时 snapshot 为 null）。 */
export type ContextSnapshotView = {
  conversationId: string;
  snapshot: ContextUsageSnapshotView | null;
};

/** 015 完整会话（启动种子化 / 历史列表点开载入）。 */
export type ConversationSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
  /** 060：全文载荷所属的代次（宿主已随原档案返回 flow），回卷后不可盖过新代。 */
  flow?: Pick<FlowSnapshotView, 'generation'>;
  /** 031：会话选中的模型配置组（null/缺省＝默认组；旧档无此字段）。 */
  profileId?: string | null;
  /** 033：会话绑定的工作区身份（null/缺省＝旧会话，沿用家目录执行语义）。 */
  workspaceId?: string | null;
  /**
   * 024 回卷剪除键（条目 id＋任务 taskId）：被编辑回卷撤下的内容以此拒绝
   * 宿主回写复活；渲染层载入后据此抑制被剪任务卡/交代的重插。
   */
  cutKeys?: string[];
};

/** 015 会话列表行（不带全文）。 */
export type ConversationStatus = 'running' | 'waiting' | 'queued';

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  corrupt?: boolean;
  /** 置顶会话在侧栏顶部单独分组，普通保存不改此状态。 */
  pinned?: boolean;
  status?: ConversationStatus | null;
  /** 宿主新结果的未读版本；清读须带 expectedUnreadAt，避免迟到回执吞掉新结果。 */
  unreadAt?: number | null;
  /** 033：会话绑定的工作区身份（侧栏项目分组用；旧档 null）。 */
  workspaceId?: string | null;
};

export type ConversationList = {
  sessions: ConversationSummary[];
  storageError: string | null;
};

/** 033 工作区视图（登记表实时快照；status 每次读取现探，不缓存）。 */
export type WorkspaceView = {
  id: string;
  type: 'default' | 'project';
  name: string;
  /** 绝对路径（可用时为 realpath 归一后的实路径）。 */
  dir: string;
  status: 'ok' | 'missing';
  /** missing 时的可展示原因（目录被移走/卸载/拒绝访问）。 */
  message?: string;
  /** 049：SSH 目标（有 host 即远端项目；路径是服务器上的 POSIX 真实路径）。 */
  host?: string;
  /** 049：远端 $HOME（显示路径缩 ~ 用；本机项目无此字段）。 */
  remoteHome?: string;
};

export type WorkspaceState = {
  default: WorkspaceView;
  projects: WorkspaceView[];
  corrupt?: boolean;
};

/** 066：顶栏打开工作区目录的方式（跨平台：finder＝访达/资源管理器）。 */
export type WorkspaceOpenTarget = 'finder' | 'terminal' | 'vscode';

/** 066：打开结果——失败 kind：unknown-workspace / remote / missing / not-found / open-failed。 */
export type WorkspaceOpenResult =
  | { ok: true; target?: WorkspaceOpenTarget }
  | { ok: false; kind: string; message: string };

/** 033：任务受理时冻结的工作区快照（执行 cwd 与成果归属同源）。 */
export type TaskWorkspaceSnapshot = {
  id: string | null;
  type: 'default' | 'project' | null;
  name: string;
  dir: string;
  /** 049：远端工作区的 SSH 目标（旧档案无此字段＝本机）。 */
  host?: string;
  /** 049：远端 $HOME（快照冻结；路径归一与显示用）。 */
  remoteHome?: string;
};

/** 031 v2：模型条目视图（属于供应商；modelKey＝providerId/modelId）。 */
export type ModelEntryView = {
  /** A host-specific reason this model cannot be selected. */
  unavailableReason?: string;
  id: string;
  modelKey: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  supportsVision: boolean;
  visionModel: string;
};

/** 046：供应商线协议——OpenAI 兼容（chat/completions）或 Anthropic 原生（/v1/messages）。 */
export type ModelProviderApi = 'openai-completions' | 'anthropic-messages' | 'openai-responses';

export type OAuthProvider = 'openai' | 'anthropic' | 'github-copilot' | 'bigmodel';
export type OAuthLoginState = {
  id: string;
  revision: number;
  provider: OAuthProvider;
  name: string;
  phase: 'login' | 'success' | 'failed' | 'cancelled';
  message: string;
  url: string | null;
  userCode: string | null;
  providerId?: string;
  prompt: null | { id: string; type: 'text' | 'secret' | 'select' | 'manual_code'; message: string; placeholder: string; options?: Array<{ id: string; label: string }> };
};

/** 订阅余额单窗口视图（如 ChatGPT/GLM 的 5 小时、周窗口；订阅行内进度条的数据源）。 */
export type SubscriptionQuotaWindow = {
  /** 窗口标识（'five-hour' | 'weekly'；后续窗口由服务器定义，UI 按 label 展示）。 */
  id: string;
  label: string;
  /** 剩余额度百分比 0-100；null＝服务器未给出，不本地估算、不补 0。 */
  remainingPercent: number | null;
  /** 绝对剩余量（GLM 以服务端 remaining 为准；与 limit-used 可差 1＝服务端取整，不本地重算）。 */
  remaining?: number;
  used?: number;
  limit?: number;
  unit?: string;
  /** 窗口重置时间（epoch 毫秒）。 */
  resetsAt?: number;
};

/** 订阅余额查询结果（oauth:quota）。失败一律以 status 表达，不 reject。 */
export type SubscriptionQuotaView = {
  provider: OAuthProvider;
  /** ok＝已取得额度；unsupported＝该供应商没有订阅余额接口；unavailable＝接口失败/不兼容；signed-out＝未登录。 */
  status: 'ok' | 'unsupported' | 'unavailable' | 'signed-out';
  windows: SubscriptionQuotaWindow[];
  fetchedAt: number;
  message?: string;
};

/** 031 v2：供应商视图（端点＋Key＋协议＋模型列表；无 Key 材料）。 */
export type ModelProviderView = {
  configuration?: 'newapi';
  source?: 'local' | 'cloud';
  oauthProvider?: OAuthProvider;
  id: string;
  name: string;
  baseUrl: string;
  /** 046：线协议；缺省 openai-completions（存量目录行为不变）。 */
  api: ModelProviderApi;
  hasApiKey: boolean;
  keyStoredSecurely: boolean;
  updatedAt: number;
  models: ModelEntryView[];
};

/** 031 v2：目录（defaultModelId 是模型键）。 */
export type ModelProfilesDirectory = {
  version: number;
  defaultModelId: string | null;
  /** 2026-10-08：上次主脑模型选择（模型键或 'auto'；null＝未记录/已失效，新建对话回落默认）。 */
  lastConversationModelKey?: string | null;
  corrupt?: boolean;
  envOverride?: boolean;
  /** 056：角色路由槽位（null＝未配）。 */
  roleModels?: Partial<Record<RoleModelSlot, string | null>>;
  /** 056：全局看图模型（模型键；null＝没单独配置）。 */
  visionModelKey?: string | null;
  providers: ModelProviderView[];
};

/** 056：角色路由槽位（main＝自动模式的主 agent；四个子 agent 角色；fallback＝备用）。 */
export type RoleModelSlot = 'main' | 'explorer' | 'oracle' | 'fixer' | 'designer' | 'fallback';

/** 056：一个角色路由槽位的视图（手动值与就绪；不含 Key）。 */
export type RoleModelSlotView = {
  /** null＝未配（角色跟随 main；main/fallback 未配＝不可选自动/不用备用）。 */
  modelKey: string | null;
  /** designer 需要能看图的模型。 */
  needsVision: boolean;
  ready: boolean;
  reason: 'missing' | 'no-vision' | null;
};

/** 056：角色路由设置页载荷（ready＝main 已配且可用，模型选择器可选「自动」）。 */
export type RoleModelsView = {
  roles: Array<{ name: Exclude<RoleModelSlot, 'main' | 'fallback'>; title: string; description: string; needsVision: boolean }>;
  slots: Record<RoleModelSlot, RoleModelSlotView>;
  ready: boolean;
};

/** 056：角色路由逐项保存的 patch（一次恰好一个字段，值为模型键或 null＝清除）。 */
export type RoleModelPatch = Partial<Record<RoleModelSlot, string | null>>;

/** 031 v2：保存供应商的输入（id 缺省＝新建；apiKey 非空才覆盖；模型列表整体提交）。 */
export type ModelProviderSaveInput = {
  id?: string;
  name: string;
  baseUrl: string;
  /** 046：线协议；缺省沿已存值（新建落 openai-completions）。 */
  api?: ModelProviderApi;
  apiKey?: string;
  /**
   * 032（2026-09-30 用户裁决）：首启引导保存的分组一律设为默认分组——
   * 保存后立即设默认并回读核验，存在旧默认组时取而代之。设置页不传。
   */
  makeDefault?: boolean;
  models: Array<{
    id?: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    thinkingFormat?: string | null;
    supportsVision?: boolean;
    visionModel?: string;
  }>;
};

/** 首启四步主流程，microphone/asr 为可选能力子页。 */
export type OnboardingStep = 'welcome' | 'model' | 'capabilities' | 'microphone' | 'asr' | 'done';

/** 数据备份（docs/requirements/data-backup.md）——与 backup-manager 返回结构对齐。 */
// 2026-11 用户裁决：仅保留轻量档。'full' 只作为旧备份集/历史 lastRun 的只读兼容值出现；
// 新创建的备份（manifest/BackupRunResult）恒为 'light'，IPC 不再接受 tier 入参。
export type BackupTier = 'light' | 'full';
export type BackupSettingsView = {
  schemaVersion: 1;
  target:
    | { kind: 'local'; dir: string }
    | { kind: 'webdav'; url: string; username: string; remoteDir: string; hasPassword: boolean }
    | null;
  schedule: { enabled: boolean; interval: 'daily' | 'weekly'; tier: 'light' };
  keep: number;
  lastRun: {
    at: string;
    ok: boolean;
    tier: BackupTier;
    trigger: string;
    packedBytes?: number;
    files?: number;
    durationMs?: number;
    message?: string;
  } | null;
};
export type BackupTargetDraft = {
  kind: 'local' | 'webdav';
  dir?: string;
  url?: string;
  username?: string;
  remoteDir?: string;
  /** 仅在用户本次输入新密码时携带；已存密码不回传渲染层。 */
  password?: string;
  hasPassword?: boolean;
};
export type BackupSettingsPatch = {
  target?: BackupTargetDraft & { kind: 'local' | 'webdav' };
  schedule?: Partial<BackupSettingsView['schedule']>;
  keep?: number;
};
export type BackupConnectionResult = { ok: boolean; code?: string; message?: string };
export type BackupRunResult = {
  ok: boolean;
  code?: string;
  message?: string;
  manifest?: { tier: BackupTier; createdAt: string; files: number; packedBytes: number };
};
export type BackupSetSummary = {
  name: string;
  createdAt: string | null;
  tier: BackupTier | null;
  totals: { rawBytes: number; packedBytes: number } | null;
  appVersion: string | null;
  source: 'local' | 'webdav';
  broken?: boolean;
  dir?: string;
};
export type BackupRestorePrepareResult = {
  ok: boolean;
  code?: string;
  message?: string;
  preview?: { files: number; conversations: number; memoryFiles: number; tops: string[] };
};
export type BackupRestoreApplyResult = { ok: boolean; code?: string; applied?: string[]; safeCopyRoot?: string };
export type BackupProgressEvent = {
  phase: 'start' | 'pack' | 'upload' | 'prune' | 'done' | 'error' | 'restore-download';
  tier?: BackupTier;
  trigger?: string;
  detail?: string;
  packedBytes?: number;
  message?: string;
};

/** 引导快照（主进程权威；模型为必需配置，语音为可选配置）。 */
export type OnboardingState = {
  version: number;
  phase: 'in_progress' | 'complete';
  /** 对齐后的当前步骤（配置被删会退回相应配置步）。 */
  step: OnboardingStep;
  permissionChoice: 'pending' | 'granted' | 'skipped';
  /** 语音服务密钥已持久保存（可解密密文；环境变量/内存态不算）。 */
  asrSaved: boolean;
  /** 默认模型组三项完整且 Key 已加密保存。 */
  modelComplete: boolean;
  updatedAt?: number;
};

/** 032：advance/complete 的回执（失败给可展示原因，不带 Key）。 */
export type OnboardingActionResult =
  | { ok: true; state: OnboardingState }
  | { ok: false; message: string };

/** 029 P2：待发送条目视图（主进程队列权威）；056 修订：语音/文字来源都入队。 */
export type TurnQueueItemView = {
  readOnly?: boolean;
  queueItemId: string;
  conversationId: string;
  text: string;
  revision: number;
  /** 托盘只收 pending（submitting＝已转正上屏，行即刻消失——2026-10-16 用户裁决）。 */
  dispatchState: 'pending' | 'editing' | 'promoting' | 'sending';
  error: string;
  attachmentIds: string[];
  references: Array<{ kind: string; [key: string]: unknown }>;
  /** 063：随条目冻结的显式技能标签（待发送区与正式消息同一标签语义）。 */
  skills?: SkillSelectionView[];
  inputSource?: 'text' | 'voice';
  createdAt: number;
};

export type TurnQueueState = { paused: boolean; items: TurnQueueItemView[] };

/** 029 P2：队列推送事件（单通道带 type）。 */
export type TurnQueuePushEvent =
  | { type: 'queue:state'; conversationId: string; paused: boolean; items: TurnQueueItemView[] }
  | { type: 'queue:dispatching'; conversationId: string; queueItemId: string; text: string; inputSource?: 'text' | 'voice' }
  | { type: 'queue:result'; conversationId: string; queueItemId: string; ok: boolean; result?: ChatTurnResult; error?: string };

/**
 * 057 对话流（渲染层消费面，契约 §2/§7）。快照的真实形状由
 * src/shared/conversation-flow.mjs 归约产出；这里只钉 UI 依赖的结构性字段，
 * 其余字段经字典透传（tasks/artifacts/permissions 等投影在 S2 接线时细化）。
 */
export type FlowPhase = 'idle' | 'preparing' | 'running' | 'stopping';

export type RunActivityView = {
  runId?: string;
  phase: 'running' | 'waiting-background' | 'waiting-resource' | 'waiting-subagents'
    | 'compacting' | 'verifying' | 'continuing' | 'finishing';
  since: number | null;
  jobs: Array<{
    runId?: string; generation?: number; taskId?: string; cleanupConfirmed?: boolean;
    id: string; toolCallId?: string; command: string;
    description?: string; commandTruncated?: boolean; lastOutputAt?: number | null;
    deadlineAt?: number; outputBytes?: number; earliestOutput?: number;
    startedAt: number; endedAt: number | null; status: string;
    code: number | null; output: string;
  }>;
  resources: Array<{
    toolCallId: string; tool: string; since: number;
    resource: { host: string; scope: string; mode: string };
    blockers: Array<{ tool?: string; description?: string; owner?: { conversationId?: string } | string }>;
  }>;
};

export type BackgroundJobView = RunActivityView['jobs'][number] & {runId:string;generation:number};

export type FlowSnapshotView = {
  schemaVersion: number;
  conversationId: string;
  revision: number;
  generation: number;
  phase: FlowPhase;
  activeRunId: string | null;
  awaitingUser?: {runId:string;question:string;reason:string} | null;
  queuePaused: boolean;
  pending: FlowInputView[];
  timeline: FlowItemView[];
  runs: Record<string, Record<string, unknown> & { activity?: RunActivityView | null; recovery?: import('@hemi/conversation-flow').ModelRecoveryView }>;
  tasks: Record<string, Record<string, unknown>>;
  artifacts: Record<string, Record<string, unknown>>;
  permissions: Record<string, Record<string, unknown>>;
  pendingReports: Array<{ taskId: string; resultVersion: number }>;
  backgroundJobs?: BackgroundJobView[];
};

export type FlowInputView = {
  workflow?: {invocationId:string;workflowId?:string;workflowRunId?:string};
  inputId: string;
  editRevision: number;
  text: string;
  inputSource: 'text' | 'voice';
  attachmentIds: string[];
  attachmentViews?: MessageAttachmentView[];
  state: 'pending' | 'submitting' | 'needs-review' | 'editing';
  promoteAt?: number | null;
  references?: MessageReferenceView[];
  /** 063：随输入提交的显式技能选择（行内标签身份）。 */
  skills?: SkillSelectionView[];
  editDraft?: { text: string; attachmentIds: string[]; attachmentViews: MessageAttachmentView[]; references: MessageReferenceView[]; skills?: SkillSelectionView[] };
  editDraftRevision?: number;
  targetRunId?: string | null;
  createdAt?: number;
};

export type FlowItemView =
  | {
      id: string;
      kind: 'user';
      runId: string;
      text: string;
      inputSource: 'text' | 'voice';
      attachmentIds: string[];
      attachments?: MessageAttachmentView[];
      /** 063：随消息冻结的引用与技能标签（正式流用户项回显用）。 */
      references?: MessageReferenceView[];
      skills?: SkillSelectionView[];
      acceptedAt: number | null;
      deliveredAt: number | null;
      /** 060 R-11：显式并入投递的输入（挂在目标运行上）；渲染层据此放行转正上屏。 */
      mergedInto?: string;
    }
  | {
      itemId: string;
      kind: 'assistant';
      runId: string;
      afterInputId: string | null;
      parts: Array<{ partId: string; kind: string } & Record<string, unknown>>;
    };

export type FlowChangeView = { conversationStatus?: ConversationStatus | null } & (
  | { kind: 'snapshot'; snapshot: FlowSnapshotView }
  | {
      kind: 'patch';
      conversationId: string;
      generation: number;
      baseRevision: number;
      revision: number;
      changes: Array<{ kind: string } & Record<string, unknown>>;
    });

/** 062：会话交付物（flow.artifacts 条目；主进程登记时已宿主查证）。 */
export type ConversationDeliverableView = {
  artifactId: string;
  kind: 'file';
  name: string;
  path: string;
  host?: string | null;
  description?: string;
  previewKind?: 'text' | 'image' | 'video' | 'unsupported';
  size?: number | null;
  producerRunId?: string | null;
  taskId?: string | null;
  producers?: Array<{ runId: string | null; taskId: string | null; generation: number | null; at: number }>;
  contentVersion?: number;
  registeredAt?: number;
};

/** 062：会话交付物受控读取结果（unsupported＝文件信息＋系统打开，不冒充预览成功）。 */
export type ConversationDeliverableReadResult = {
  ok: boolean;
  kind?: 'text' | 'image' | 'video' | 'unsupported' | 'document';
  document?: AttachmentDocumentPreview;
  mediaUrl?: string;
  markdown?: boolean;
  text?: string;
  dataUrl?: string;
  name?: string;
  path?: string;
  size?: number | null;
  message?: string;
};

export type FileOpenApplication = { id: string; name: string; isDefault: boolean; icon: string | null };
export type FileOpenApplicationsResult = { ok: boolean; applications: FileOpenApplication[]; message?: string };

/** 062：Markdown 本地链接受控解析结果（ok 时 artifactId 与正式登记同一身份函数）。 */
export type ConversationLinkResolution = {
  ok: boolean;
  artifactId?: string;
  name?: string;
  path?: string;
  host?: string | null;
  message?: string;
};

export type FlowCommandResult = {
  data?: {text?:string;next?:number;total?:number;lossy?:boolean;accepted?:boolean};
  ok: boolean;
  code?: string;
  disposition?: string;
  inputId?: string;
  runId?: string | null;
  revision?: number;
  message?: string;
  input?: FlowInputView;
};

export type WorkflowExecutionModel = { mode: 'fixed'; modelKey: string } | { mode: 'auto' };

/** 059：工作流列表条目（definitionStore.list 投影）。 */
export type WorkflowDefinitionSummary = {
  workflowId: string;
  name: string;
  description: string;
  published: { revision: number; name: string; description: string; contentHash: string | null; createdAt: number | null } | null;
  // 从已发布输入节点派生；不是可独立编辑的第二份 schema。
  parameters?: Array<{key:string;label?:string;required?:boolean;defaultValue?:unknown;defaultRule?:string}>;
  nodeTypes?: string[];
  inputTypes?: string[];
  hasDraft: boolean;
  draftRevision: number | null;
  updatedAt: number;
};

/** preload 暴露到 window.hemiVoice 的桥形状（env.d.ts 消费）。 */
export type SkillMarketItem = {
  id: string;
  name: string;
  title: string;
  description: string;
  author: string;
  version: string;
  package: string;
  sha256: string;
  files: string[];
  installedId: string | null;
};

export type InstalledSkill = {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  sha256: string;
  origin: 'market' | 'local' | 'skillsmp';
  author: string;
  enabled: boolean;
  files: string[];
  sourcePath: string | null;
  /** 034：skillsmp 来源的固定身份（条目 ID、仓库、目录、提交、两个来源页）。 */
  github: {
    entryId: string;
    repo: string;
    path: string;
    commit: string;
    url: string;
    githubUrl: string;
  } | null;
  updateAvailable: boolean;
  sourceWithdrawn: boolean;
};

/** 034 SkillsMP：搜索结果条目（只读发现元数据，不含可安装文件）。 */
export type SkillsmpSkill = {
  id: string;
  name: string;
  author: string;
  description: string;
  contentLanguage: string;
  githubUrl: string | null;
  skillUrl: string | null;
  stars: number | null;
  updatedAt: number | null;
};

/** 034 SkillsMP：持久化的上次成功搜索（离线/失败展示，标时间不标实时）。 */
export type SkillsmpSearchCache = {
  schema: 1;
  query: string;
  sortBy: 'stars' | 'recent';
  skills: SkillsmpSkill[];
  pagination: { page: number; totalPages: number; total: number; hasNext: boolean };
  checkedAt: number;
};

export type SkillsmpSearchResponse = {
  ok: boolean;
  reason?: string;
  live?: boolean;
  cached?: SkillsmpSearchCache | null;
} & Partial<SkillsmpSearchCache>;

/** 034 SkillsMP：GitHub 固定提交快照预览（用户确认后才安装）。 */
export type SkillsmpPreview = {
  skillsmpId: string;
  entryName: string;
  author: string;
  skillUrl: string | null;
  githubUrl: string;
  name: string;
  title: string;
  description: string;
  repo: string;
  dirPath: string;
  commit: string;
  files: Array<{ path: string; size: number }>;
  totalBytes: number;
  bundleSha256: string;
  skillMd: string;
};

export type SkillsmpUpdateStatus = 'up-to-date' | 'update-available' | 'source-changed' | 'unavailable';

export type SkillsmpUpdateResponse = {
  ok: boolean;
  reason?: string;
  status?: SkillsmpUpdateStatus;
  commit?: string;
  githubUrl?: string;
};

export type SkillMarketState = {
  installed: InstalledSkill[];
  catalog: SkillMarketItem[];
  catalogSource: 'built-in' | 'cached' | 'online';
  catalogError: string;
  storageError: string;
  checkedAt: number | null;
  publishedAt: string;
  /** 034：SkillsMP 上次成功搜索缓存（可能为 null）。 */
  mpSearch: SkillsmpSearchCache | null;
};

export type SkillActionResult = {
  ok: boolean;
  cancelled?: boolean;
  reason?: string;
  state?: SkillMarketState | null;
  skill?: InstalledSkill;
};

/** 044 应用内更新状态（设置页「关于与更新」消费；supported=false 见 unsupportedReason）。 */
export type UpdaterState = {
  supported: boolean;
  /** supported=false 的原因：dev＝开发实例；unsupported-platform＝mac/win 之外的构建（当前无分发形态）。 */
  unsupportedReason: 'dev' | 'unsupported-platform' | null;
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  errorMessage: string | null;
};

/** 044 更新动作回执：失败如实带 code/message，渲染层不做静默吞错。 */
export type UpdaterActionResult = {
  ok: boolean;
  code?:
    | 'unsupported'
    | 'no-update'
    | 'not-downloaded'
    | 'check-failed'
    | 'download-failed';
  message?: string;
};

/** 047 导入阶段（与主进程 IMPORT_PHASES 同源字符串）。 */
export type ProviderImportPhase =
  | 'opening'
  | 'login'
  | 'discovering'
  | 'selecting'
  | 'preflight'
  | 'creating'
  | 'reconciling'
  | 'reading-key'
  | 'validating'
  | 'ready-to-save'
  | 'saving'
  | 'success'
  | 'cancelling'
  | 'cleanup-pending'
  | 'cancelled'
  | 'failed';

/** 047：单个型号的验证结果（主进程严格探活回执；code 为本地错误码）。 */
export type ProviderImportValidationItem = {
  modelName: string;
  api: ModelProviderApi;
  ok: boolean;
  code: string | null;
};

/** 047：选择（分组/型号/协议/预算/期限/首次默认；主进程白名单校验后冻结）。 */
export type ProviderImportSelection = {
  group: string;
  budgetMode: 'unlimited' | 'usd';
  budgetUsd?: number;
  expiryMode: 'never' | 'days';
  expiryDays?: number;
  models: Array<{ modelName: string; api: ModelProviderApi }>;
  firstDefaultModelKey: string | null;
};

/** 047：提交预览（同协议归组、跨协议拆供应商、共用本次 Key）。 */
export type ProviderImportPreview = {
  planHash: string;
  providers: Array<{ name: string; api: ModelProviderApi; baseUrl: string; models: string[] }>;
  firstDefaultModelKey: string | null;
};

/** 047：安全状态 DTO（无 Key/JWT/Cookie/DOM；revision 递增）。 */
export type ProviderImportState = {
  destination?: { kind: 'bot'; instanceId: string };
  operationId: string;
  revision: number;
  phase: ProviderImportPhase;
  control: 'user' | 'hemi' | 'paused';
  siteOrigin: string;
  apiBaseUrl: string;
  siteLabel: string | null;
  accountLabel: string | null;
  tokenName: string | null;
  groups: Array<{ name: string; desc: string }>;
  candidates: Array<{ modelName: string; apis: ModelProviderApi[]; unsupported: string[] }>;
  candidatesGroup: string | null;
  selection: ProviderImportSelection | null;
  preview: ProviderImportPreview | null;
  progress: string | null;
  validation: ProviderImportValidationItem[] | null;
  error: { code: string; message: string; retryTarget?: string; detail?: string } | null;
  result: {
    providerIds: string[];
    modelKeys: string[];
    providers: Array<{ id: string; name: string; api: ModelProviderApi; baseUrl: string; modelCount: number }>;
    encrypted: boolean;
  } | null;
  cleanupPending: { siteOrigin: string; tokenName: string | null; tokenId: number | null } | null;
  resumeHint: string | null;
  /** 登录记忆失败原因，不含账号密码或 Cookie。 */
  loginMemoryError?: string | null;
  can: {
    checkLogin: boolean;
    setSelection: boolean;
    submit: boolean;
    pause: boolean;
    resume: boolean;
    retry: boolean;
    cancel: boolean;
    back: boolean;
  };
};

/** 047：journal 待处理摘要（恢复入口；不含秘密）。 */
export type ProviderImportPendingItem = {
  destination?: { kind: 'bot'; instanceId: string };
  operationId: string;
  readable: boolean;
  phase: string;
  siteOrigin?: string | null;
  accountLabel?: string | null;
  tokenName?: string | null;
  tokenId?: number | null;
  apiKeyHeld?: boolean;
  committed?: boolean;
  updatedAt?: number | null;
};

export type HemiVoiceBridge = {
  bot: import('./bot').BotBridge;
  getAppearanceBootstrap: () => AppearanceBootstrap | null;
  getAppearance: () => Promise<AppearanceSnapshot>;
  setAppearance: (request:AppearanceSetRequest) => Promise<AppearanceSetResult>;
  onAppearanceChanged: (callback:(snapshot:AppearanceSnapshot)=>void) => () => void;
  onAppearanceActivity: (callback:(activity:AppearanceActivity)=>void) => () => void;
  reportAppearanceApplied: (value:AppearanceApplied) => void;
  reportAppearanceVisualReady: (value:AppearanceApplied) => void;
  platform: string;
  getSkillState: () => Promise<SkillMarketState>;
  refreshSkillCatalog: () => Promise<SkillActionResult>;
  importLocalSkill: () => Promise<SkillActionResult>;
  installMarketSkill: (id: string) => Promise<SkillActionResult>;
  setSkillEnabled: (id: string, enabled: boolean) => Promise<SkillActionResult>;
  removeSkill: (id: string) => Promise<SkillActionResult>;
  readSkill: (id: string) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  revealSkill: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 034 SkillsMP：默认市场发现与主动添加。 */
  searchSkillsMp: (payload: { query: string; sortBy?: 'stars' | 'recent' }) => Promise<SkillsmpSearchResponse>;
  previewSkillsMp: (id: string) => Promise<{ ok: boolean; preview?: SkillsmpPreview; reason?: string }>;
  installSkillsMp: (payload: {
    skillsmpId: string;
    commit: string;
    bundleSha256: string;
    githubUrl: string;
    author?: string;
    skillUrl?: string | null;
  }) => Promise<SkillActionResult>;
  checkSkillsMpUpdate: (id: string) => Promise<SkillsmpUpdateResponse>;
  /** 028：拖入文件的受控路径（沙箱渲染层取不到 File.path 的官方替代）。 */
  pathForFile: (file: File) => string;
  openExternal: (url: string) => Promise<boolean>;
  /** 056：对话内容里的链接——任意 http/https 用默认浏览器打开（其他协议拒绝）。 */
  openLink: (url: string) => Promise<boolean>;
  /** 2026-10-05：主进程写剪贴板（页面剪贴板被权限闸门拦，见 system.ipc 注释）。 */
  copyText: (text: string) => Promise<{ ok: boolean }>;
  /** 系统「键盘导航」：true＝Tab 走遍所有控件；false＝只在文本输入与列表间切换（mac 默认）。 */
  getKeyboardNavigation: () => Promise<{ fullKeyboardAccess: boolean }>;
  getConfig: () => Promise<DoubaoConfig>;
  saveConfig: (config: DoubaoConfig) => Promise<DoubaoConfig>;
  requestMicrophonePermission: () => Promise<boolean>;
  getMicrophonePermissionStatus: () => Promise<MicrophonePermissionStatus>;
  /** 打开「系统设置 → 隐私与安全性 → 麦克风」。 */
  openMicrophoneSettings: () => Promise<boolean>;
  startAsr: (mode?: ListenMode) => Promise<AsrStartResult>;
  sendAudio: (audio: ArrayBuffer) => void;
  stopAsr: () => Promise<{ ok: boolean }>;
  /** 032 冷启动引导：快照 / 前进一步 / 完成（主进程权威校验）。 */
  getOnboardingState: () => Promise<OnboardingState>;
  advanceOnboarding: (payload: {
    to: OnboardingStep;
    permissionChoice?: 'granted' | 'skipped';
  }) => Promise<OnboardingActionResult>;
  completeOnboarding: () => Promise<OnboardingActionResult>;
  /** 数据备份（docs/requirements/data-backup.md）：状态（含脱敏目标配置）/ 保存 / 测试 / 执行 / 列表 / 恢复 / 进度订阅。 */
  getBackupState: () => Promise<BackupSettingsView>;
  saveBackupSettings: (payload: BackupSettingsPatch) => Promise<BackupSettingsView>;
  testBackupConnection: (target?: BackupTargetDraft) => Promise<BackupConnectionResult>;
  runBackupNow: () => Promise<BackupRunResult>;
  listBackups: () => Promise<BackupSetSummary[]>;
  prepareBackupRestore: (setName: string) => Promise<BackupRestorePrepareResult>;
  applyBackupRestore: () => Promise<BackupRestoreApplyResult>;
  cancelBackupRestore: () => Promise<{ ok: boolean; code?: string }>;
  /** 删除单个备份集（本地目录或远端集合，递归删除，不可恢复）。 */
  deleteBackupSet: (setName: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** 系统目录选择框（本地文件夹目标）；取消时 canceled=true。 */
  pickBackupDirectory: () => Promise<{ canceled: boolean; path: string | null }>;
  onBackupProgress: (callback: (event: BackupProgressEvent) => void) => () => void;
  getTextModelConfig: () => Promise<TextModelConfig>;
  saveTextModelConfig: (config: TextModelSaveConfig) => Promise<TextModelConfig>;
  /** 033：思考强度快捷拨盘（只写档位，下一轮对话即生效；031 起可指定组）。 */
  setThinkingLevel: (level: ThinkingLevel, profileId?: string) => Promise<{ thinkingLevel: ThinkingLevel }>;
  /** 031 v2 多组模型配置：目录 / 保存供应商 / 删除供应商（默认模型需替代）/ 默认模型 / 逐模型测试。 */
  listModelProfiles: () => Promise<ModelProfilesDirectory>;
  startOAuthLogin: (provider: OAuthProvider) => Promise<OAuthLoginState>;
  getOAuthLoginState: () => Promise<OAuthLoginState | null>;
  answerOAuthLogin: (payload: { id: string; promptId: string; value: string }) => Promise<OAuthLoginState | null>;
  cancelOAuthLogin: (id: string) => Promise<OAuthLoginState | null>;
  logoutOAuth: (provider: OAuthProvider) => Promise<{ ok: boolean }>;
  /** 订阅余额（5h/周窗口）查询：主进程缓存＋并发合并＋force 限频；失败以 status 表达，不抛错。 */
  getSubscriptionQuota: (provider: OAuthProvider, options?: { force?: boolean }) => Promise<SubscriptionQuotaView>;
  saveModelProfile: (provider: ModelProviderSaveInput) => Promise<{ ok: boolean; providerId: string; modelKeys: string[] }>;
  removeModelProfile: (payload: {
    providerId: string;
    replacementModelId?: string;
  }) => Promise<{ ok: boolean; defaultModelId?: string }>;
  setDefaultModelProfile: (modelKey: string) => Promise<{ ok: boolean; defaultModelId: string }>;
  /** 2026-10-08：记上次主脑模型选择（模型键或 'auto'；新建对话恢复用，纯缓存不抛错）。 */
  setLastConversationModel: (modelKey: string) => Promise<{ ok: boolean; lastConversationModelKey?: string | null }>;
  /** 056：全局看图模型（模型键或 null＝不单独配置）。 */
  setVisionModel: (modelKey: string | null) => Promise<{ ok: boolean; visionModelKey: string | null }>;
  /** 056：角色路由视图与逐项即时保存（一个 patch 一个字段）。 */
  getRoleModels: () => Promise<RoleModelsView>;
  saveRoleModel: (patch: RoleModelPatch) => Promise<{ ok: boolean } & RoleModelsView>;
  /**
   * 逐组探活（032 扩展）：带模型键时空字段回落该组已存值；不带模型键＝首启
   * 未建组，三项须显式传入、不回落任何已存配置。失败带 errorKind 类别。
   */
  testModelProfile: (payload: {
    modelKey?: string;
    /** 首启验证工具调用响应；不会执行模型返回的工具。 */
    requireTools?: boolean;
    /** 051：线协议（首启引导草稿显式传入；缺省回退该组已存协议）。 */
    api?: ModelProviderApi;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }) => Promise<ModelTestResult>;
  /**
   * 041 拉取模型列表：供应商详情只传 providerId（主进程用已存 Key）；
   * 添加流程传 baseUrl＋尚未保存的 apiKey。Key 原文不回渲染层。
   */
  listRemoteModels: (payload: {
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
  }) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
  /** 设置页「测试连通性」：最小请求探活文本模型（表单值可覆盖存储值）。 */
  testTextModel: (overrides?: ModelTestOverrides) => Promise<ModelTestResult>;
  /** 047 New API 站点登录导入：命令进主进程协调器，状态订阅消费安全 DTO。 */
  startProviderImport: (payload: { siteUrl: string; destination?: { kind: 'bot'; instanceId: string } }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  getProviderImportState: (operationId?: string | null) => Promise<{ ok: boolean; state: ProviderImportState | null }>;
  listPendingProviderImports: () => Promise<{
    ok: boolean;
    activeOperationId: string | null;
    pending: ProviderImportPendingItem[];
  }>;
  resumePendingProviderImport: (operationId: string) => Promise<{
    ok: boolean;
    settled?: string;
    state?: ProviderImportState | { operationId: string; phase: string; result: object };
  }>;
  checkProviderImportLogin: (payload: {
    operationId: string;
    revision: number;
  }) => Promise<{ ok: boolean; code?: string; message?: string; state: ProviderImportState }>;
  setProviderImportSelection: (payload: {
    operationId: string;
    revision: number;
    selection: {
      group: string;
      budgetMode?: 'unlimited' | 'usd';
      budgetUsd?: number;
      expiryMode?: 'never' | 'days';
      expiryDays?: number;
      models: Array<{ modelName: string; api: ModelProviderApi }>;
      firstDefaultModelKey?: string | null;
    };
  }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  submitProviderImport: (payload: {
    operationId: string;
    revision: number;
    planHash: string;
  }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  retryProviderImport: (payload: { operationId: string; revision: number; target?: string }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  pauseProviderImport: (payload: { operationId: string; revision: number }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  resumeProviderImport: (payload: { operationId: string; revision: number }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  cancelProviderImport: (payload: { operationId: string; revision: number }) => Promise<{ ok: boolean; state: ProviderImportState }>;
  setProviderImportViewport: (payload: {
    operationId: string;
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
    layoutGeneration?: number;
  }) => Promise<{ ok: boolean }>;
  onProviderImportState: (callback: (state: ProviderImportState) => void) => () => void;
  submitChatTurn: (payload: ChatTurnPayload) => Promise<ChatTurnReceipt>;
  chatTextModel: (payload: ChatTurnPayload) => Promise<ChatTurnResult>;
  cancelTextModel: (target: number | {
    conversationId: string | null;
    turnId: number;
    requestId?: string;
    /** preempt＝抢话/编辑替换（主进程不暂停待发送队列）；缺省＝停止（暂停）。 */
    reason?: 'preempt';
  }) => void;
  getConversationTurn: (conversationId: string) => Promise<ConversationTurnState | null>;
  onConversationTurn: (callback: (state: ConversationTurnState) => void) => () => void;
  getTtsConfig: () => Promise<TtsConfig>;
  saveTtsConfig: (config: TtsSaveConfig) => Promise<TtsConfig>;
  speakTts: (payload: TtsSpeakPayload) => Promise<TtsSpeakResult>;
  cancelTts: (turnId?: number) => void;
  /** 排查日志：经主进程落到终端与 userData/hemi.log。 */
  logLine: (line: string) => void;
  /** 在 Finder 中定位 hemi.log。 */
  revealLogFile: () => Promise<boolean>;
  showAppMenu?: (request: import('./app-menu.mjs').AppMenuRequest) => Promise<import('./app-menu.mjs').AppMenuCommand | null>;
  /** 044 应用内更新：状态快照 / 检查 / 下载 / 立刻重启安装 / 状态订阅。 */
  updaterGetState: () => Promise<UpdaterState>;
  updaterCheck: () => Promise<UpdaterActionResult>;
  updaterDownload: () => Promise<UpdaterActionResult>;
  updaterInstall: () => Promise<UpdaterActionResult>;
  onUpdaterChanged: (callback: (state: UpdaterState) => void) => () => void;
  getUiPreferences: () => Promise<UiPreferences>;
  setFloatingOrbEnabled: (enabled: boolean) => Promise<UiPreferences>;
  /** 013：切换「仅响应首位说话人」（下一次通话生效）。 */
  setPrimarySpeakerEnabled: (enabled: boolean) => Promise<UiPreferences>;
  /** 022：全局长按 Option 对话开关（macOS；热启停），回执带钩子运行态。 */
  setGlobalPushToTalkEnabled: (enabled: boolean) => Promise<GlobalPushToTalkStatus>;
  /**
   * 043：长按键配置统一入口（enabled/key 可只给其一；key 只接受当前平台
   * 已验证的键，未验证的键回 INVALID_INPUT 且不改变现有状态）。
   */
  setPushToTalkConfig: (payload: {
    enabled?: boolean;
    key?: string;
  }) => Promise<PushToTalkConfig>;
  /** 043 平台能力快照：先订阅（onPlatformStateChanged）再取初始快照。 */
  platformGetState: () => Promise<PlatformSnapshot | null>;
  platformRecheck: (capability: CapabilityId) => Promise<PlatformSnapshot | null>;
  platformPerformAction: (
    capability: CapabilityId,
    action: CapabilityAction,
  ) => Promise<PlatformActionResult>;
  onPlatformStateChanged: (
    callback: (snapshot: PlatformSnapshot) => void,
  ) => () => void;
  /** 022：弹系统辅助功能授权引导框（返回调用时刻的授权状态）。 */
  requestAccessibilityTrust: () => Promise<boolean>;
  /** 022：直达「系统设置 → 输入监控」面板。 */
  openInputMonitoringPane: () => Promise<boolean>;
  setMainWindowExpanded: (expanded: boolean) => void;
  hideMainWindow: () => void;
  publishUiState: (state: UiState) => void;
  getUiState: () => Promise<UiState>;
  /** 065：仅 dev 监控使用；普通浏览器 fixture 没有此桥。 */
  getDevWindowActivity?: () => Promise<WindowActivityView | null>;
  onDevWindowActivity?: (callback: (activity: WindowActivityView) => void) => () => void;
  showMainWindow: () => void;
  floatingHoldStart: () => void;
  floatingHoldEnd: () => void;
  floatingHoldCancel: () => void;
  floatingDragStart: (point: ScreenPoint) => void;
  floatingDragMove: (point: ScreenPoint) => void;
  floatingDragEnd: () => void;
  /** 004：悬浮球/任务菜单的悬停上报（显示/隐藏任务菜单）。 */
  floatingTaskHover: (hovered: boolean) => void;
  getFloatingCaptionLayout: () => Promise<FloatingCaptionLayout>;
  onFloatingCaptionLayout: (
    callback: (layout: FloatingCaptionLayout) => void,
  ) => () => void;
  onFloatingDragDetected: (callback: () => void) => () => void;
  /** 悬浮窗隐藏/重现（渲染层据此清悬停态——窗口 hide 不发 mouseleave）。 */
  onFloatingVisibilityChanged: (
    callback: (visible: boolean) => void,
  ) => () => void;
  onAsrEvent: (callback: (event: AsrEvent) => void) => () => void;
  onLlmDelta: (callback: (event: LlmDeltaEvent) => void) => () => void;
  onTtsAudio: (callback: (event: TtsAudioEvent) => void) => () => void;
  onTtsState: (callback: (event: TtsStateEvent) => void) => () => void;
  onUiState: (callback: (state: UiState) => void) => () => void;
  onFloatingOrbCommand: (
    callback: (command: FloatingOrbCommand) => void,
  ) => () => void;
  /** 004 任务面。 */
  getTaskState: () => Promise<TaskStateSnapshot>;
  taskAction: (
    action: TaskActionName,
    /**
     * 017：定向到具体任务（多任务卡各自的按钮）；decide 另带 choice。
     * 2026-09-23 身份收敛：taskId 是任务唯一标识，新代码一律传它；
     * taskKey（进程内 t 键）仅作过渡兼容保留。
     */
    payload?: { choice?: TaskPermissionChoice; taskId?: string; taskKey?: string },
  ) => Promise<{ ok: boolean }>;
  onTaskState: (callback: (state: TaskStateSnapshot) => void) => () => void;
  /** 042 应用级授权（access-grants.json 事实源）。旧三档/白名单通道已退役。 */
  accessGetState: (taskId?: string) => Promise<AccessStateDto>;
  accessListApplications: () => Promise<ApplicationChoice[]>;
  /** 043 B2a：ref 换成主进程签发的 appRef+catalogRevision（提交时主进程复核）。 */
  accessAddApplication: (payload: {
    ref: { appRef: string; catalogRevision: number };
    expectedRevision?: number;
  }) => Promise<AccessMutationResult>;
  accessSetUiEnabled: (payload: {
    resourceId: string;
    enabled: boolean;
    expectedRevision?: number;
  }) => Promise<AccessMutationResult>;
  accessRemoveGrant: (payload: { grantId: string; expectedRevision?: number }) => Promise<AccessMutationResult>;
  accessRevokeResource: (payload: { resourceId: string; expectedRevision?: number }) => Promise<AccessMutationResult>;
  accessRetrySave: () => Promise<AccessMutationResult>;
  onAccessChanged: (callback: (event: { revision: number; health: string }) => void) => () => void;
  /** 006 computer use：配置读写与 macOS 权限检测/引导（设置页）。 */
  getComputerUse: () => Promise<ComputerUsePreferences>;
  setComputerUse: (next: Partial<ComputerUsePreferences>) => Promise<ComputerUsePreferences>;
  getVisionPermissions: () => Promise<VisionPermissionStatus>;
  openVisionPermissionPane: (kind: 'screenRecording' | 'accessibility') => Promise<boolean>;
  /** 014 浏览器操控：开关读写、桥运行态、扩展目录定位（安装引导）。 */
  getBrowserControl: () => Promise<BrowserControlPreferences>;
  setBrowserControl: (next: Partial<BrowserControlPreferences>) => Promise<BrowserControlPreferences>;
  getBrowserBridge: () => Promise<BrowserBridgeStatus>;
  exportBrowserExtension: () => Promise<{ path: string } | { canceled: true }>;
  /** web 检索：开关与 key（key 只写不读）。 */
  getWebSearch: () => Promise<WebSearchPreferences>;
  setWebSearch: (next: { enabled?: boolean; apiKey?: string }) => Promise<WebSearchPreferences>;
  /** 020 browser_act：开关与 Jev 端点（key 只写不读）。 */
  getBrowserAct: () => Promise<BrowserActPreferences>;
  setBrowserAct: (next: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string }) => Promise<BrowserActPreferences>;
  /** 设置页「测试连通性」：最小请求探活 Jev 决策端（输入框值可覆盖存储值）。 */
  testBrowserAct: (overrides?: ModelTestOverrides) => Promise<ModelTestResult>;
  /** 2026-09-26：执行器终端命令走系统代理（输入工具行快捷拨杆，默认关）。 */
  getShellProxy: () => Promise<ShellProxyStatus>;
  setShellProxy: (enabled: boolean) => Promise<ShellProxyStatus>;
  /** 008 当前工作上下文：来源条状态与附加/刷新/移除。 */
  getContextState: () => Promise<WorkContextState>;
  attachContext: (kind: WorkContextAttachKind) => Promise<WorkContextAttachResult>;
  refreshContext: (id: string) => Promise<WorkContextAttachResult>;
  removeContext: (id: string) => Promise<WorkContextAttachResult>;
  onContextState: (callback: (state: WorkContextState) => void) => () => void;
  /** 028 二批：`@` 引用候选（063 起含 workflow/file/folder/conversation 四类行内引用；
   *  workspaceId 显式指定 @ 的文件/对话搜索范围，缺省按会话档案解析）。 */
  listReferences: (
    conversationId: string,
    query?: string,
    workspaceId?: string,
  ) => Promise<{
    candidates: Array<{
      kind: 'attachment' | 'artifact' | 'context' | 'workflow' | 'file' | 'folder' | 'conversation';
      key: string;
      name: string;
      subtitle: string;
      attachmentId?: string;
      taskId?: string;
      artifactId?: string;
      contextId?: string;
      workflowId?: string;
      workflowRevision?: number;
      refPath?: string;
      targetConversationId?: string;
    }>;
  }>;
  /** 063：`/` 首层候选——命令（/model）＋当前会话/工作区实际可用的技能。 */
  listSlashCandidates: (
    conversationId: string,
  ) => Promise<SlashCandidatesResult>;
  /** 029 P2：运行中投递——队列 CRUD／继续发送／补充任务与推送订阅；
   * 056 修订：忙时追加一律入队（inputSource 标语音来源，派发后照常口播）。 */
  enqueueTurn: (payload: {
    conversationId: string;
    text: string;
    attachmentIds?: string[];
    /** 057 S3-2：附件视图随条目冻结（派发转正后 chips 不依赖渲染层保存）。 */
    attachmentViews?: MessageAttachmentView[];
    references?: Array<{ kind: string; [key: string]: unknown }>;
    inputSource?: 'text' | 'voice';
  }) => Promise<{ ok: boolean; item?: TurnQueueItemView; message?: string }>;
  listTurnQueue: (conversationId: string) => Promise<TurnQueueState>;
  updateTurnQueueItem: (payload: {
    conversationId: string;
    queueItemId: string;
    text: string;
  }) => Promise<{ ok: boolean; item?: TurnQueueItemView; message?: string }>;
  withdrawTurnQueueItem: (payload: {
    conversationId: string;
    queueItemId: string;
  }) => Promise<{ ok: boolean; message?: string }>;
  resumeTurnQueue: (conversationId: string) => Promise<void>;
  /** 060 R-21：显式插队＝让该条目优先（停止旧目标，确认后优先派发）。 */
  promoteTurnQueueItem: (payload: {
    conversationId: string;
    queueItemId: string;
  }) => Promise<{ ok: boolean; disposition?: string; inputId?: string; message?: string }>;
  onQueuePush: (callback: (event: TurnQueuePushEvent) => void) => () => void;
  /** 057 对话流：命令受理 / 快照获取 / 补丁订阅（先订阅再取快照；缺口重取）。 */
  flowCommand: (
    conversationId: string,
    command: Record<string, unknown>,
    operation?: {requestId: string; generation: number | null},
  ) => Promise<FlowCommandResult>;
  flowLookupOperation?: (conversationId: string, requestId: string) => Promise<FlowCommandResult | null>;
  onFlowDisconnected?: (receive: () => void) => () => void;
  flowGetHistory?: (conversationId:string,cursor:{before:number;generation:number})=>Promise<import('@hemi/conversation-flow/core').FlowHistoryPage>;
  flowGetSnapshot: (conversationId: string) => Promise<FlowSnapshotView | null>;
  /** 059 工作流：列表／定义只读＋两入口受理（渲染层零 store 访问）。 */
  workflowApplications: () => Promise<Array<{name:string;applicationRef:string}>>;
  workflowRemove: (workflowId:string) => Promise<{removed:boolean}>;
  workflowOpenArtifact: (invocationId:string,path:string) => Promise<{ok:boolean}>;
  workflowListInvocations: (workflowId:string) => Promise<Array<Record<string,unknown>>>;
  workflowList: () => Promise<Array<WorkflowDefinitionSummary>>;
  workflowGetRevision: (
    workflowId: string,
    revision?: number | null,
  ) => Promise<{ workflowId: string; revision: number; name: string; document: unknown } | null>;
  workflowSaveDraft: (
    workflowId: string,
    document: unknown,
    name?: string,
    expectedDraftRevision?: number | null,
  ) => Promise<{ workflowId: string; draftRevision: number; updatedAt: number }>;
  workflowGetDraft: (
    workflowId: string,
  ) => Promise<{ workflowId: string; draftRevision: number; document: unknown; name?: string } | null>;
  workflowPublish: (
    workflowId: string,
    expectedDraftRevision?: number | null,
    expectedRevision?: number | null,
  ) => Promise<{ workflowId: string; revision: number; contentHash: string }>;
  workflowPrepare: (payload: {
    workflowId: string;
    revision?: number | null;
    conversationId?: string | null;
    entryMode?: 'chat' | 'direct' | 'editor-test';
    executionModel?: WorkflowExecutionModel | null;
    profileId?: string | null;
    workspaceId?: string | null;
  }) => Promise<Record<string, unknown>>;
  workflowUpdatePreparation: (payload: {
    invocationId: string;
    expectedDraftRevision?: number | null;
    values?: Record<string, unknown>;
    issues?: Array<unknown>;
    executionModel?: WorkflowExecutionModel | null;
  }) => Promise<Record<string, unknown>>;
  workflowStartPrepared: (payload: {
    invocationId: string;
    cardId?: string | null;
    expectedDraftRevision?: number | null;
    requestId: string;
    conversationId: string;
    values?: Record<string, unknown> | null;
  }) => Promise<Record<string, unknown>>;
  workflowAbandon: (payload:{invocationId:string;conversationId?:string}) => Promise<unknown>;
  workflowContinue: (payload:{invocationId:string;requestId:string;confirmed?:boolean;verifiedOutputs?:Record<string,unknown>;resumeMessage?:string}) => Promise<Record<string,unknown>>;
  workflowSubmitInteraction: (payload:{invocationId:string;interactionId:string;requestId:string;actionId:string;values?:Record<string,unknown>;expectedRevision?:number}) => Promise<Record<string,unknown>>;
  workflowSaveInteractionDraft: (payload:{invocationId:string;interactionId:string;values:Record<string,unknown>;expectedRevision?:number}) => Promise<{ok:true;revision:number}|{ok:false;code:string;message:string}>;
  workflowStop: (workflowRunId: string) => Promise<{ stopped: boolean; reason?: string }>;
  workflowGetInvocation: (invocationId: string) => Promise<Record<string, unknown> | null>;
  /** 057 S3-2d：元数据轻保存（profile/workspace；不动宿主 turns）。 */
  flowSaveMetadata: (payload: {
    conversationId: string;
    profileId?: string | null;
    workspaceId?: string | null;
  }) => Promise<{ ok: boolean }>;
  /** 057 S3-2d：编辑回卷走宿主（档案剪除＋flow 裁剪；渲染层不再整表保存）。 */
  flowRewind: (payload: {
    conversationId: string;
    targetInputId: string;
    removedTurnKeys: string[];
  }) => Promise<{ ok: boolean; code?: string; message?: string; cutKeysGrew?: boolean; generation?: number }>;
  onFlowChanged: (
    callback: (payload: { conversationId: string; change: FlowChangeView }) => void,
  ) => () => void;
  /** 028 本条消息附件：登记（文件/粘贴）/ 移除 / 列表 / 受控预览 / 受控打开。 */
  attachFile: (payload: {
    conversationId: string;
    /** Picker opens the native dialog when no path is supplied. */
    filePath?: string;
    source: 'picker' | 'drop';
  }) => Promise<ComposerAttachmentResult>;
  attachPasteImage: (payload: { conversationId: string; dataUrl: string }) => Promise<ComposerAttachmentResult>;
  removeAttachment: (payload: {
    conversationId: string;
    attachmentId: string;
  }) => Promise<ComposerAttachmentResult>;
  listAttachments: (conversationId: string) => Promise<{ attachments: MessageAttachmentView[] }>;
  readAttachmentPreview: (
    conversationId: string,
    attachmentId: string,
    stagedPath?: string,
  ) => Promise<ArtifactPreviewResult>;
  readAttachmentDocument: (conversationId: string, attachmentId: string) => Promise<AttachmentDocumentPreview>;
  openAttachmentSource: (
    conversationId: string,
    attachmentId: string,
  ) => Promise<{ ok: boolean; message?: string; code?: string }>;
  inspectAgentEnvironment: () => Promise<AgentEnvironmentSnapshot>;
  readAgentRuntimeFile: (payload: { path: string }) => Promise<{ path: string; text: string; modifiedAt: number }>;
  /** 009 任务历史：列表 / 详情 / 删除 / 重新总结（全部按 taskId 寻址）。 */
  getTaskHistory: () => Promise<TaskHistoryList>;
  getTaskHistoryRecord: (taskId: string) => Promise<TaskHistoryRecord>;
  deleteTaskHistory: (taskId: string) => Promise<{ ok: boolean }>;
  resummarizeTaskHistory: (taskId: string) => Promise<TaskHistoryActionResult>;
  /** 011：继续执行中断任务（同一 taskId 新尝试；成功后主窗口出现任务卡）。 */
  resumeTask: (taskId: string) => Promise<TaskHistoryActionResult>;
  /** 012：按 artifactId 打开/定位产物（intent='reveal' 强制 Finder 定位）。 */
  openArtifact: (
    taskId: string,
    artifactId: string,
    intent?: 'open' | 'reveal',
  ) => Promise<TaskHistoryActionResult>;
  /** 025：保存报告 HTML（系统保存面板；内容来自档案里已校验的交付）。 */
  saveDeliveryReport: (taskId: string) => Promise<TaskHistoryActionResult & { canceled?: boolean; path?: string }>;
  /** 050：保存交付正文 .md（系统保存面板；内容来自档案 resultText）。 */
  saveTaskBodyMarkdown: (taskId: string) => Promise<TaskHistoryActionResult & { canceled?: boolean; path?: string }>;
  /** 050 R-22：读文件改动的本任务 Diff（首次修改前 vs 最终；档案快照）。 */
  readFileDiff: (
    taskId: string,
    filePath: string,
  ) => Promise<{ ok: true; diff: string; truncated: boolean } | { ok: false; message: string }>;
  /** 050 R-06：打开/定位改动文件（主进程按档案 fileChanges 校验路径后执行）。 */
  openFileChange: (
    taskId: string,
    filePath: string,
    intent?: 'open' | 'reveal',
  ) => Promise<TaskHistoryActionResult>;
  /** 025：受控打开来源链接（只认档案 delivery.sources 登记过的条目）。 */
  openDeliverySource: (taskId: string, sourceId: string) => Promise<TaskHistoryActionResult>;
  /** 025：读取报告图片（档案登记的图片产物 → data URL）。 */
  readDeliveryImage: (
    taskId: string,
    artifactId: string,
  ) => Promise<{ ok: boolean; dataUrl?: string; message?: string }>;
  /** 026：应用内文件预览的受控读取（Markdown/纯文本/图片；按档案寻址）。 */
  readArtifactPreview: (
    taskId: string,
    artifactId: string,
  ) => Promise<{
    ok: boolean;
    kind?: 'text' | 'image';
    markdown?: boolean;
    text?: string;
    dataUrl?: string;
    message?: string;
  }>;
  /** 027 R-02：预览面板路径点击——受控在浏览器打开已登记文件（主进程寻址）。 */
  openArtifactPreviewFile: (
    taskId: string,
    artifactId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** 062：会话交付物元数据（flow.artifacts 的条目形状；渲染层只消费投影）。 */
  readConversationDeliverable: (
    conversationId: string,
    artifactId: string,
    linkPath?: string | null,
  ) => Promise<ConversationDeliverableReadResult>;
  readConversationDeliverableText?: (conversationId:string,artifactId:string,linkPath?:string|null) => ReturnType<HemiVoiceBridge['readAttachmentPreview']>;
  /** 062：会话交付物受控打开（预览栏路径点击；范围外格式走系统应用）。 */
  openConversationDeliverable: (
    conversationId: string,
    artifactId: string,
    linkPath?: string | null,
    intent?: 'preview-file' | 'system' | 'reveal' | 'choose-app' | 'directory' | 'application',
    applicationId?: string | null,
  ) => Promise<{ ok: boolean; canceled?: boolean; message?: string }>;
  listConversationDeliverableApplications: (
    conversationId: string, artifactId: string, linkPath?: string | null,
  ) => Promise<FileOpenApplicationsResult>;
  /** 062：对话正文 Markdown 本地文件链接的受控解析（成功＝可预览对象，非正式交付）。 */
  resolveConversationLink: (
    conversationId: string,
    href: string,
  ) => Promise<ConversationLinkResolution>;
  /** 030 会话草稿：按会话保存/读取/删除（revision 单调守卫在主进程）。
   *  063：草稿随存行内标签身份（skills＋行内引用；正文 token 与身份共同恢复）。 */
  saveDraft: (payload: {
    conversationId: string;
    revision: number;
    text: string;
    skills?: SkillSelectionView[];
    references?: MessageReferenceView[];
  }) => Promise<{ ok: boolean; stale?: boolean; revision?: number; message?: string }>;
  getDraft: (conversationId: string) => Promise<{
    conversationId: string;
    revision: number;
    text: string;
    updatedAt: number;
    skills?: SkillSelectionView[];
    references?: MessageReferenceView[];
  } | null>;
  removeDraft: (conversationId: string) => Promise<{ ok: boolean }>;
  /** 015 会话：最近 / 保存（防抖全量）/ 列表 / 打开 / 删除。 */
  getLastConversation: () => Promise<ConversationSession | null>;
  saveConversation: (
    payload: {
      id: string;
      turns: ConversationTurn[];
      profileId?: string | null;
      /** 033：会话绑定的工作区身份（缺省＝不动已存；'default'/项目 id/null）。 */
      workspaceId?: string | null;
      /**
       * 024 回卷：本次编辑撤下的剪除键（条目 id＋任务 taskId）。主进程并入
       * 档案 cutKeys 持久化，宿主回写（合并/追加/补终态）一律按它过滤。
       */
      removedTurnKeys?: string[];
    },
  ) => Promise<{ ok: boolean; unchanged?: boolean; storageError?: string }>;
  listConversations: () => Promise<ConversationList>;
  /** activate 仅在用户点击打开时按真实更新时间重排；启动恢复和只读加载不重排。 */
  openConversation: (id: string, options?: { activate?: boolean }) => Promise<ConversationSession>;
  markConversationRead: (id: string, expectedUnreadAt: number) => Promise<{ ok: boolean; unreadAt: number | null; unchanged?: boolean }>;
  removeConversation: (id: string) => Promise<{ ok: boolean }>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<{ ok: boolean; session?: ConversationSummary; storageError?: string }>;
  /** 024：双击重命名（空标题回退派生标题；不动 updatedAt）。 */
  renameConversation: (
    id: string,
    title: string,
  ) => Promise<{ ok: boolean; session: ConversationSummary }>;
  /** 024：侧栏拖拽排序（全量 id 序落 order-index.json）。 */
  reorderConversations: (
    ids: string[],
  ) => Promise<{ ok: boolean; count?: number; storageError?: string }>;
  /** 档案落盘/改名/删除/排序/自动起名后的变更广播（收到即重读列表；title 载荷带新标题供顶栏同步）。 */
  onConversationsChanged: (
    callback: (event: {
      kind: 'save' | 'rename' | 'remove' | 'reorder' | 'title' | 'unread' | 'read' | 'pin';
      session?: ConversationSummary;
      id?: string;
    }) => void,
  ) => () => void;
  /** 048：会话用量账本（对话侧明细＋任务执行按模型汇总合并返回）。 */
  getUsageLedger: (
    conversationId: string,
  ) => Promise<UsageLedgerView>;
  /** 048：账本有新记录（对话轮结束、任务每次模型调用完成）——重取聚合。 */
  onUsageChanged: (
    callback: (event: { conversationId: string }) => void,
  ) => () => void;
  /** 上下文容量：主会话当前占用＋分类估算。 */
  getContextSnapshot: (
    conversationId: string,
  ) => Promise<ContextSnapshotView>;
  /** 上下文占用轮末可能变化（含取消/失败停靠）——重取快照。 */
  onContextChanged: (
    callback: (event: { conversationId: string }) => void,
  ) => () => void;
  /** 033：工作区状态（默认工作区 + 项目列表，含实时可用性）。 */
  getWorkspaceState: () => Promise<WorkspaceState>;
  /** 033：系统目录选择器添加项目目录（取消返回 cancelled:true）。 */
  addWorkspaceFolder: () => Promise<{
    ok: boolean;
    cancelled?: boolean;
    workspace?: WorkspaceView;
    deduped?: boolean;
    state?: WorkspaceState;
    reason?: string;
  }>;
  /** 033：移除项目列表项（不删磁盘文件）。 */
  removeWorkspace: (
    id: string,
  ) => Promise<{ ok: boolean; state?: WorkspaceState; reason?: string }>;
  /** 049 R-01：添加服务器上的文件夹（SSH 目标＋远端路径；probe 通过才登记）。
   * 密码登录（2026-10-12 用户裁决）：可选 password 经 SSH_ASKPASS 喂给系统 ssh，
   * 只进会话内存不落盘；认证失败回 canPassword 供界面引导输入密码。 */
  addRemoteWorkspace: (
    host: string,
    dir: string,
    password?: string,
    /** 勾「记住密码」（默认 true）：safeStorage 加密落盘，重启恢复；false 只进内存。 */
    remember?: boolean,
  ) => Promise<{
    ok: boolean;
    kind?: string;
    field?: 'host' | 'dir';
    message?: string;
    /** kind=auth 时为 true：本机无免密密钥，可改输密码。 */
    canPassword?: boolean;
    workspace?: WorkspaceView;
    deduped?: boolean;
    state?: WorkspaceState;
  }>;
  /** 049 R-09：重试连接（重新探测登记的远端项目并更新状态缓存）；认证失败可带密码重试。 */
  probeRemoteWorkspace: (
    id: string,
    password?: string,
    remember?: boolean,
  ) => Promise<{ ok: boolean; kind?: string; message?: string; canPassword?: boolean; state?: WorkspaceState }>;
  /** 066：顶栏打开工作区目录（按登记 id；远端/失效/未装应用如实返回失败）。 */
  openWorkspaceDir: (id: string, target: WorkspaceOpenTarget) => Promise<WorkspaceOpenResult>;
  /** 066：打开方式默认偏好（顶栏主按钮图标与菜单勾选）。 */
  getWorkspaceOpenTarget: () => Promise<{ target: WorkspaceOpenTarget }>;
  setWorkspaceOpenTarget: (target: WorkspaceOpenTarget) => Promise<{ target: WorkspaceOpenTarget }>;
  /** 049 R-11：远端产物下载到本机（按档案寻址；经 SSH 读，系统保存面板）。 */
  downloadArtifact: (
    taskId: string,
    artifactId: string,
  ) => Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }>;
  /** 使用记录：跨会话总览消耗与请求历史。 */
  getUsageHistory: (query: import('./usage-history').UsageHistoryQuery) => Promise<import('./usage-history').UsageHistoryResponse>;
  /** 019：拉起原生双工后端（失败回退浏览器链路）。 */
  startDuplex: () => Promise<DuplexStartResult>;
  /** 019：会话结束关停双工后端。 */
  stopDuplex: () => Promise<{ ok: boolean }>;
  /** 019：打断停播（清 duplexd 播放队列）。 */
  duplexStopPlay: () => Promise<{ ok: boolean }>;
  /** 019：播放增益（duck/恢复）。 */
  duplexVolume: (gain: number) => Promise<{ ok: boolean }>;
  onDuplexCap: (callback: (event: DuplexCapEvent) => void) => () => void;
  onDuplexDrained: (callback: () => void) => () => void;
  onDuplexUnderrun: (callback: () => void) => () => void;
  onDuplexState: (callback: (state: DuplexStateEvent) => void) => () => void;
};
