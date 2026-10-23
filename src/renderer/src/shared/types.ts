import type { MessageAttachmentView, MessageReferenceView, SkillSelectionView, TaskStateSnapshot, ThinkingLevel, TurnThinking, TurnPart, TurnUsage, UsageRecord, LlmDeltaEvent } from '@shared/protocol';

export type { UsageRecord, LlmDeltaEvent };

export const DURATION_RESOURCE_ID = 'volc.seedasr.sauc.duration';
export const DEFAULT_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

/** TTS 与 ASR 同一把豆包 Key,但 Resource ID 是另一个资源、独立计费(按字符)。 */
export const TTS_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
/**
 * 默认音色:知性灿灿 2.0(豆包 App 同款女声)。实测(2026-09-19)本机 Key 只开通了
 * 2.0 档,且音色必须与资源同档(1.0 音色在 2.0 资源上会报 55000000)。
 */
export const TTS_DEFAULT_VOICE = 'zh_female_cancan_uranus_bigtts';
/** 双向流式合成端点(与 ASR 同域,协议同族)。 */
export const TTS_DEFAULT_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
/** 设置页试听按钮念的句子。 */
export const TTS_PREVIEW_TEXT = '你好，我是 Hemi，这是我的声音。';
/** 送合成的单句上限:模型输出不守「一句」约束时客户端自保。 */
export const TTS_MAX_TEXT_CHARS = 300;
/** 播报输出采样率(PCM 16-bit 单声道)。 */
export const TTS_SAMPLE_RATE = 24000;
// 打断判定的参数(压低音量/恢复滞回/确认帧数)在 windows/voice/lib/barge-in.ts 集中维护。

/**
 * 设置页音色下拉的精选列表;只收录 2.0 档音色(与默认资源 seed-tts-2.0 同档——
 * 音色跨档会报 55000000,1.0 档音色在未开通 1.0 资源的 Key 上不可用,不展示)。
 */
export const TTS_VOICE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 · 豆包同款' },
  { value: 'zh_female_vv_uranus_bigtts', label: 'VV · 通用女声' },
  { value: 'zh_female_xiaohe_uranus_bigtts', label: '小何 · 通用女声' },
  { value: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 · 通用女声' },
  { value: 'zh_male_m191_uranus_bigtts', label: '云舟 · 通用男声' },
  { value: 'zh_male_taocheng_uranus_bigtts', label: '小天 · 通用男声' },
];

/** 火山引擎「豆包语音」新版控制台的 API Key 管理页，可直接创建/复制 Key。 */
export const DOUBAO_CONSOLE_API_KEY_URL =
  'https://console.volcengine.com/speech/new/setting/apikeys?projectName=default';

/**
 * 044 Hemi 发布页（设置页「关于与更新」的「去发布页看」）。
 * owner/repo 的功能侧事实来源在 src/shared/release-info.mjs（主进程更新桥，
 * 渲染层引不了 .mjs）；改仓库时两处联动。
 */
export const HEMI_RELEASES_PAGE_URL = 'https://github.com/PiuQiuPiaQia/Hemi/releases';

export type TranscriptItem = {
  recovery?: import('@hemi/conversation-flow').ModelRecoveryView;
  /** 060：纯投影的渲染身份，供真机全结构校验；不由客户端生成正式消息。 */
  flow?: { runId: string; itemId: string; inputId?: string; partIds: string[] };
  live?: boolean;
  /** 当前运行的最后一段展示内容；与整轮仍在运行的 live 分开，防止旧段落出现光标。 */
  streaming?: boolean;
  id: string;
  text: string;
  createdAt: number;
  utteranceId?: string;
  /** 谁说的；Hemi 的回应是 'hemi'。 */
  author: 'user' | 'hemi';
  /**
   * 024：本条消息的输入来源。用户消息建档时写入一次；旧档缺省按 'voice'
   * 处理——只有文字消息可编辑重发。
   */
  inputSource?: 'voice' | 'text';
  /** 024 消息编辑：用户消息被编辑的时间戳（存在即显示「已编辑」）。 */
  editedAt?: number;
  /**
   * 005：任务卡作为对话流的一等公民（用户 2026-09-19 裁决「任务框跟着对话走」）——
   * kind='task' 的条目在流内原位渲染任务卡，历史对话与任务卡交错排布；
   * taskSeq 关联主进程 TaskManager 的快照（活跃任务用实时快照，终态后用冻结快照）。
   * 2026-10-07 会话审计：kind='error'＝聊天回合失败留痕（正文是失败原因）——
   * 原位渲染但不进模型上下文（lib/message-edit 的过滤约定）。
   */
  kind?: 'task' | 'error';
  taskSeq?: number;
  /**
   * 任务卡的稳定身份：主进程 taskId 全局唯一（task-<seq>-<随机>），跨会话不撞号。
   * seq 只在单次应用会话内单调——会话化对话（015）里老会话的卡也是从 1 编起，
   * 拿 seq 当身份会把新任务的快照写进老卡（2026-09-20 真机事故：天气卡被 GEV
   * 任务整个顶掉）。旧档案没有 taskId，按 `s<seq>` 兜底键渲染。
   */
  taskId?: string;
  /**
   * 017：稳定任务键（`t<seq>`）——多任务后卡身份优先用它（主进程单次运行内唯一），
   * 旧档退 taskId／`s<seq>`。
   */
  taskKey?: string;
  /** 历史载入时随 turn 带回的冻结快照（type 层补齐，渲染用 taskSnaps 表）。 */
  taskSnap?: TaskStateSnapshot;
  /**
   * 021 转向并入：true＝原地冻结的历史卡（旧位置）——渲染为只读快照形态
   * （「已并入 · 历史快照」，无操作按钮），活卡已挪到对话流最末端。
   */
  taskFrozen?: boolean;
  /**
   * 028：本条用户消息实际携带的附件（发送时冻结的登记快照；历史回看与预览
   * 入口共用同一 attachmentId 身份）。旧档缺省＝纯文本消息。
   */
  attachments?: MessageAttachmentView[];
  /** 028 二批：本条消息携带的 `@` 引用（发送时冻结；063 起含四类行内引用）。 */
  references?: MessageReferenceView[];
  /** 063：本条消息显式选中的技能标签（发送时冻结；历史/重启回显同一身份）。 */
  skills?: SkillSelectionView[];
  /** 029 P2：排队条目身份（派发开始即清除标记；撤回转 withdrawn）。 */
  queueItemId?: string;
  queuedForSend?: boolean;
  /** 029 排队撤回：排队消息被撤回（原位转「已撤回，未发送」）。 */
  withdrawn?: boolean;
  /**
   * 029：模型回复被用户主动停止——已收到的增量原位保留为未完成回复，
   * 不伪装成成功，也不显示为模型失败。仅 hemi 消息有效。
   */
  replyStatus?: 'stopped';
  /**
   * 048：本条回应的思考全文与时长（主进程回合回执携带，随档案落盘可回看；
   * 中途停止的轮次由流式缓冲写回并标 interrupted）。不进模型上下文。
   */
  thinking?: TurnThinking;
  /** 056：按到达顺序的段（思考／正文／工具组）；有它时回看照段渲染，缺省走旧形态。 */
  parts?: TurnPart[];
  /** 048：本条回应的模型用量合计（输入/输出/缓存/生成时长）。 */
  usage?: TurnUsage;
};

export type ConfigForm = {
  apiKey: string;
  resourceId: string;
  endpoint: string;
  hasApiKey: boolean;
  keyStoredSecurely: boolean;
};

/** 文本模型（OpenAI 兼容供应商）的配置表单；Key 只写不读。视觉模型（2026-09-20
 * 裁决）也在这张表单里：支持看图就随主脑模型，不带视觉时单独填一个名字。 */
export type TextModelConfigForm = {
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  keyStoredSecurely: boolean;
  /** 033：思考强度档位（default=厂商中档）；设置页与输入工具行拨盘共用。 */
  thinkingLevel: ThinkingLevel;
  supportsVision: boolean;
  visionModel: string;
};

/**
 * 033：思考强度档位选项（设置页下拉与拨盘浮层共用一份文案）。
 * default＝各厂商提供的中间档位（openai: reasoning_effort medium；
 * 二值格式：开思考），与执行器侧 SDK 默认档对齐；「关闭」只在支持关思考的
 * 端点生效（openai 格式降级为不发字段，见主进程映射层）。
 */
export const THINKING_LEVEL_OPTIONS: Array<{
  value: ThinkingLevel;
  label: string;
  hint: string;
}> = [
  { value: 'default', label: '默认', hint: '厂商中档思考，适合日常' },
  { value: 'off', label: '关闭', hint: '不思考，出答案最快' },
  { value: 'low', label: '低', hint: '少量思考，快问快答' },
  { value: 'medium', label: '中', hint: '平衡速度与质量' },
  { value: 'high', label: '高', hint: '想得更周全，等待更久' },
];

/** 语音播报（豆包 TTS）的配置表单；与 ASR 同一把 Key,这里只管播报侧的选项。 */
export type TtsConfigForm = {
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsResourceId: string;
  hasApiKey: boolean;
  keyStoredSecurely: boolean;
};

// IPC 协议类型（含 AsrEvent / UiState / Tts* 等）统一放在 src/shared/protocol.ts，
// 这里 re-export 保持渲染层既有 '@/shared/types' 引用不变。
export * from '@shared/protocol';
