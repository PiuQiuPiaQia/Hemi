export type ModelRecoveryView = {
  id: string;
  phase: 'waiting' | 'offline' | 'connecting' | 'recovered' | 'expired' | 'stopped' | 'failed';
  attempt: number;
  attemptsMade?: number;
  firstFailureAt: number;
  deadlineAt: number;
  updatedAt: number;
  nextRetryAt: number | null;
  notBefore?: number;
  summary?: string;
  /** Host-captured position at the first failure; subsequent output cannot move it. */
  anchor?: {itemId: string; afterPartId: string | null};
  history?: Array<{ at: number; phase: string; attempt: number; summary?: string }>;
};
/** Display-only contracts extracted from Hemi; no runtime or service imports. */
export type TranscriptItem = {
  recovery?: ModelRecoveryView;
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
  author: "user" | "hemi";
  /**
   * 024：本条消息的输入来源。用户消息建档时写入一次；旧档缺省按 'voice'
   * 处理——只有文字消息可编辑重发。
   */
  inputSource?: "voice" | "text";
  /** 024 消息编辑：用户消息被编辑的时间戳（存在即显示「已编辑」）。 */
  editedAt?: number;
  /** Restore a rejected edit without replacing its authoritative message text. */
  editDraft?: { revision: string; text: string };
  /**
   * 005：任务卡作为对话流的一等公民（用户 2026-09-19 裁决「任务框跟着对话走」）——
   * kind='task' 的条目在流内原位渲染任务卡，历史对话与任务卡交错排布；
   * taskSeq 关联主进程 TaskManager 的快照（活跃任务用实时快照，终态后用冻结快照）。
   * 2026-10-07 会话审计：kind='error'＝聊天回合失败留痕（正文是失败原因）——
   * 原位渲染但不进模型上下文（lib/message-edit 的过滤约定）。
   */
  kind?: "task" | "error";
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
  replyStatus?: "stopped" | "awaiting-user";
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
  /** Display-only messages of this dispatch; never injected into the parent's transcript. */
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
  bodySource?:
    | "executor"
    | "fallback-report"
    | "legacy-delivery"
    | "legacy-result"
    | null;
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
    proposedVerdict: "complete" | "partial" | "unknown";
    summary?: string;
    checks: Array<{
      target: string;
      status: "satisfied" | "unsatisfied" | "unknown";
      evidence: string;
    }>;
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

export type InputSource = "voice" | "text";

export type TaskWorkspaceSnapshot = {
  id: string | null;
  type: "default" | "project" | null;
  name: string;
  dir: string;
  /** 049：远端工作区的 SSH 目标（旧档案无此字段＝本机）。 */
  host?: string;
  /** 049：远端 $HOME（快照冻结；路径归一与显示用）。 */
  remoteHome?: string;
};

export type TaskPhase =
  | "idle"
  | "preparing"
  | "running"
  | "waiting"
  | "stopping"
  | "terminal";

export type TaskOutcome =
  | "complete"
  | "stopped"
  | "denied"
  | "blocked"
  | "partial"
  | "unknown"
  | "startfailed"
  | "reportfailed";

export type RunActivityView = {
  runId?: string;
  phase: "running" | "waiting-background" | "waiting-resource";
  since: number | null;
  jobs: Array<{
    id: string;
    toolCallId?: string;
    command: string;
    description?: string;
    commandTruncated?: boolean;
    lastOutputAt?: number | null;
    deadlineAt?: number; outputBytes?: number; earliestOutput?: number;
    startedAt: number;
    endedAt: number | null;
    status: string;
    code: number | null;
    output: string;
  }>;
  resources: Array<{
    toolCallId: string;
    tool: string;
    since: number;
    resource: { host: string; scope: string; mode: string };
    blockers: Array<{
      tool?: string;
      description?: string;
      owner?: { conversationId?: string } | string;
    }>;
  }>;
};

export type TaskPermissionRequest = {
  id: string;
  summary: string;
  tool: string;
  args: Record<string, unknown>;
  /** 005：自动审查档透传的判定理由（review 改判 ask 时有值），确认卡与日志展示。 */
  note?: string | null;
  /** 042：卡面种类（grant＝授权卡三选一，action＝风险确认卡两钮）。 */
  kind?: "grant" | "action";
  /** 042：本卡的选项值（与按钮一一对应；缺省按 action 两钮渲染）。 */
  options?: string[];
  /** 018：请求发出时刻（审批等待计时起点，宿主记录用）。 */
  askedAt?: number;
  remainingMs: number;
};

export type TaskEventLogLine = {
  at: number;
  text: string;
};

export type TaskSourceRef = {
  title: string;
  url: string;
  visited: boolean;
};

export type TaskFileChanges = {
  files: Array<{
    path: string;
    fromPath?: string;
    kind: "A" | "M" | "D" | "R";
    add: number | null;
    del: number | null;
    source: "tool" | "git";
    attribution: "task" | "uncertain";
    /** 050 R-22：有「首次修改前 vs 最终」的 Diff 快照（无＝不显示入口）。 */
    diffAvailable?: boolean;
  }>;
  /** 非 git 目录只有工具记录，界面标「命令改动未完整统计」。 */
  coverage: "tools" | "tools+git";
  /** 快照失败/超时原因（降级如实可见）。 */
  degraded: string | null;
  /** 未列入的临时文件数。 */
  tempExcluded: number;
};

export type TaskVerification = {
  verdict: "complete" | "partial" | "unknown";
  evidence: string[];
  unchecked: string[];
  at: number;
};

export type TaskArtifact = {
  id: string;
  kind: "file" | "link";
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
  role?: "main" | "attachment";
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

export type TaskArtifactAvailability = {
  state:
    | "unchecked"
    | "ok"
    | "missing"
    | "unreadable"
    | "undecodable"
    | "unsupported";
  reason?: string;
  checkedAt?: number;
};

export type TaskDelivery = {
  schemaVersion: 1;
  /** 呈现载体：card=结果卡 / report=报告网页 / file=主成果是文件。 */
  form: "card" | "report" | "file";
  /** 内容结构：四类卡 + 报告。 */
  kind: "summary" | "comparison" | "checklist" | "receipt" | "report";
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

export type DeliveryBlock =
  | { type: "p"; text: string }
  | {
      type: "metrics";
      items: Array<{
        label: string;
        value: string;
        unit?: string;
        note?: string;
      }>;
    }
  | { type: "table"; caption?: string; columns: string[]; rows: string[][] }
  | {
      type: "checklist";
      groups: Array<{
        title?: string;
        items: Array<{ text: string; note?: string }>;
      }>;
    }
  | { type: "section"; title: string; blocks: DeliveryBlock[] }
  | { type: "image"; artifactId: string; caption?: string };

export type DeliverySource = {
  id: string;
  title: string;
  url?: string;
  note?: string;
};

export type ToolCallRecord = {
  tool: string;
  startedAt: number | null;
  durationMs: number | null;
  isError: boolean;
  /** executed / not-executed / null（无上报的工具）。 */
  actionState: "executed" | "not-executed" | null;
  /**
   * 021 R-12：browser_act 步级摘要（有界脱敏——targetText 只取元素行前 24 字）。
   * status 为 done/low-confidence/blocked/verify-failed/circuit 系列/error/aborted；
   * reason 为结构化失败原因；steps 每步含操作/两类置信度/耗时/目标元素文本；
   * verifyRounds 为每轮 DONE 核验结果（0.2.2 复盘批次）。
   */
  browser?: BrowserControlRecord | null;
};

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
  verifyRounds: Array<{
    stable: boolean;
    satisfied: number | null;
    error: string | null;
  }>;
  evidence: { title: string; url: string } | null;
};

export type TaskApprovalStats = { count: number; totalWaitMs: number };

export type MessageAttachmentView = {
  attachmentId: string;
  conversationId: string;
  name: string;
  kind: "text" | "image";
  sizeBytes: number;
  status: "ready" | "failed";
  /** 失败原因／读取提示（status=failed 时给用户看）。 */
  message?: string;
  source: "picker" | "drop" | "paste";
  /** 文件类附件的来源路径（粘贴图片为空串）。 */
  originPath?: string;
  registeredAt: number;
  /** 图片附件的小缩略图（data URL，长边 ≤144px，登记时生成；随消息入档，跨重启仍可显示）。 */
  thumbnailUrl?: string;
  /** 粘贴图片的受控暂存路径（重启后预览读取的回退寻址，主进程只认暂存区内的图片）。 */
  stagedPath?: string;
};

export type MessageReferenceView = {
  kind:
    | "attachment"
    | "artifact"
    | "context"
    | "workflow"
    | "file"
    | "folder"
    | "conversation";
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

export type SkillSelectionView = {
  token: string;
  name: string;
  source: "library" | "project";
  skillId: string;
  /** 选择时的短说明快照（详情气泡展示；不以此代替执行校验）。 */
  description?: string;
};

export type TurnThinking = {
  text: string;
  durationMs: number;
  interrupted?: boolean;
  truncated?: boolean;
};

export type TurnPart =
  | {
      type: "thinking";
      text: string;
      startedAt: number;
      endedAt: number | null;
      interrupted?: boolean;
    }
  | { type: "text"; text: string }
  | { type: "tools"; calls: TurnToolCall[] }
  /** 会话成果：同一回合去重，后续回合更新仍可见；同一文件复用预览身份。 */
  | {
      type: "file-delivery";
      artifactId: string;
      name: string;
      host?: string | null;
      description?: string;
      conversationId?: string;
      linkPath?: string;
      contentVersion?: number;
      size?: number;
    }
  /** 059 执行卡：参数＋进展同卡（flow 的 workflow-card part 投影）。 */
  | {
      type: "workflow-card";
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
        nodes?: Record<string, {status?: string; error?: string; outputs?: Record<string, unknown>; log?: Array<{at: number; tool: string; kind: string; isError?: boolean}>}>;
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

export type TurnToolCall = {
  id: string;
  tool: string;
  args: Record<string, string | number | boolean>;
  state: "running" | "done" | "error" | "stopped";
  output?: string;
  outputTruncated?: boolean;
};

export type WorkflowExecutionModel =
  | { mode: "fixed"; modelKey: string }
  | { mode: "auto" };

export interface WorkflowInteractionProjection {
  interactionId: string;
  nodeId: string;
  title: string;
  status: "open" | "responded" | "expired" | "cancelled";
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
    source: "user" | "timeout";
  } | null;
}

export interface WorkflowInteractionField {
  fieldId: string;
  key: string;
  label: string;
  type: "text" | "choice" | "file" | "files";
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

export type TaskActionName = "stop" | "decide";

export type TaskPermissionChoice = "deny" | "once" | "task" | "persistent";

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

export type RoleModelSlot =
  | "main"
  | "explorer"
  | "oracle"
  | "fixer"
  | "designer"
  | "fallback";

export type ModelProviderView = {
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

export type OAuthProvider = "openai" | "anthropic" | "github-copilot" | "bigmodel";

export type ModelProviderApi =
  | "openai-completions"
  | "anthropic-messages"
  | "openai-responses";

export type ModelEntryView = {
  unavailableReason?: string;
  id: string;
  modelKey: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  supportsVision: boolean;
  visionModel: string;
};

export type ThinkingLevel = "default" | "off" | "low" | "medium" | "high";

export interface WorkflowInputParameter {
  key: string;
  label?: string;
  type: WorkflowParameterType;
  required?: boolean;
  options?: Array<string>;
  defaultValue?: unknown;
  /** 相对日期规则（如 'last-week'），启动时按工作区时区冻结为具体值。 */
  defaultRule?: string;
  description?: string;
}

export type WorkflowParameterType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "date"
  | "file"
  | "files"
  | "directory";

export interface WorkflowDocument {
  nodes: Array<WorkflowNode>;
  edges: Array<WorkflowEdge>;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  meta: { position: { x: number; y: number } };
  data: {
    title?: string;
    /** 画布展示摘要；执行仍以 goal 为准。 */
    description?: string;
    /** agent/skill/browser/desktop 必填任务目标。 */
    goal?: string;
    acceptance?: string;
    /** hemi-input：参数 schema 单源。 */
    parameters?: Array<WorkflowInputParameter>;
    /** hemi-skill：引用的 Skill（name＋version 快照核对）。 */
    skillRefs?: Array<{ name: string; version?: string }>;
    /** hemi-browser：目标 URL 或 URL 绑定。 */
    targetUrl?: string;
    targetBinding?: WorkflowBinding;
    /** hemi-desktop：应用身份。 */
    applicationRef?: string;
    /** hemi-condition：比较配置。 */
    condition?: {
      fieldRef: WorkflowBinding;
      operator: string;
      value?: unknown;
    };
    /** hemi-human-input：内容（{{nodeId.key}} 变量）、字段、操作与等待。 */
    content?: string;
    fields?: Array<HumanInputField>;
    actions?: Array<HumanInputAction>;
    wait?: HumanInputWait;
    /** 任务节点输入绑定。 */
    inputBindings?: Array<WorkflowBinding>;
    /** 任务节点输出声明。 */
    outputSchema?: {
      type: "object";
      properties: Record<
        string,
        { type: string; description?: string; default?: unknown }
      >;
    };
    /** hemi-deliver：展示说明与产物绑定。 */
    summary?: string;
    artifacts?: Array<{ label?: string; binding: WorkflowBinding }>;
  };
}

export type WorkflowNodeType =
  | "hemi-input"
  | "hemi-agent"
  | "hemi-skill"
  | "hemi-browser"
  | "hemi-desktop"
  | "hemi-condition"
  | "hemi-human-input"
  | "hemi-deliver";

export type WorkflowBinding =
  | { kind: "parameter"; key: string; type?: string; acceptType?: string }
  | {
      kind: "node-output";
      nodeId: string;
      key: string;
      type?: string;
      acceptType?: string;
    };

export interface HumanInputField {
  /** 稳定字段身份（改 key 不换 fieldId）。 */
  fieldId?: string;
  key: string;
  label?: string;
  type: HumanInputFieldType;
  required?: boolean;
  config?: {
    /** text：自定义预填文本。 */
    prefillText?: string;
    /** text：上游正文预填绑定。 */
    prefillBinding?: WorkflowBinding;
    /** choice：手动选项。 */
    options?: Array<string>;
    /** choice：上游 array[string] 选项来源（运行时冻结列表）。 */
    optionsBinding?: WorkflowBinding;
  };
}

export type HumanInputFieldType = "text" | "choice" | "file" | "files";

export interface HumanInputAction {
  actionId: string;
  label: string;
  /** 至多一个主按钮。 */
  primary?: boolean;
  /** 该操作额外必填的字段 key（与字段自身 required 取并集）。 */
  requiredKeys?: Array<string>;
}

export type HumanInputWait =
  | { mode: "forever" }
  | { mode: "timeout"; timeoutMs: number };

export interface WorkflowEdge {
  sourceNodeID: string;
  targetNodeID: string;
  /** 条件节点为 'yes' | 'else'，其余节点省略。 */
  sourcePortID?: string;
}

export type ArtifactPreviewResult = {
  ok: boolean;
  kind?: "text" | "image";
  markdown?: boolean;
  text?: string;
  dataUrl?: string;
  message?: string;
  code?: string;
};

export type SlashCandidatesResult = {
  commands: Array<{id: 'model'; name: string; description: string}>;
  skills: Array<{skillId: string; name: string; description: string; source: 'library' | 'project'}>;
  skillsError?: string;
};
