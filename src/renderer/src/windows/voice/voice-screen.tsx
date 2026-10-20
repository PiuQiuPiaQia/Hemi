import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  CloudSun,
  Copy,
  FileText,
  FolderInput,
  Globe,
  Image as ImageIcon,
  Link2,
  Menu as MenuIcon,
  Mic,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Table2,
  Play,
  X
} from 'lucide-react'

import { Markdown } from '@/shared/markdown'
import { Menu, MenuItem } from '@/components/menu'
import { useClipboardCopy } from '@/lib/use-clipboard-copy'
import { segmentTaggedText } from '@/windows/voice/lib/composer-tokens'
import { FilePreviewPanel } from '@/windows/voice/file-preview'
import {
  closePreviewTab as closeTabInQueue,
  EMPTY_PREVIEW_TABS,
  isPreviewableArtifact,
  openPreviewTab as openTabInQueue,
  previewTabKey,
  type PreviewTabId,
  type PreviewTabsState,
} from '@/windows/voice/lib/preview-tabs';
import type {
  MessageAttachmentView,
  MessageReferenceView,
  ModelProfilesDirectory,
  SkillSelectionView,
  TurnQueueState,
  SessionState,
  TaskActionName,
  TaskPermissionChoice,
  TaskStateSnapshot,
  ThinkingLevel,
  TranscriptItem,
  TurnPart,
  TurnPhase,
  WorkContextAttachKind,
  WorkContextObjectView,
  WorkContextState,
  WorkspaceState,
  WorkspaceView,
} from '@/shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AppTopBar } from '@/windows/voice/app-top-bar';
import { CallActivityIndicator, CallDock } from '@/windows/voice/call-dock';
import { formatCallElapsed } from '@/windows/voice/lib/call-dock-state';
import { PermissionCard } from '@/windows/voice/task-panel';
import { ScopePopover } from '@/windows/voice/scope-popover';
import { ThinkingLevelStrip } from '@/windows/voice/thinking-level-strip';
import { ConversationSidebar } from '@/windows/voice/sidebar';
import { NavRail } from '@/windows/voice/nav-rail';
import { SKILLS_TOPBAR_SLOT_ID, SkillMarket } from '@/windows/voice/skill-market';
import { WorkflowStudio } from '@/windows/voice/workflow-studio';
import { TextComposer } from '@/windows/voice/text-composer';
import { ThinkingBlock } from '@/windows/voice/thinking-block';
import { TurnParts } from '@/windows/voice/turn-parts';
import { CompactDelegation } from '@/windows/voice/compact-delegation';
import { TaskResultBlock } from '@/windows/voice/result-view';
import { WaitingStatus } from '@/windows/voice/waiting-status';
import { SessionUsage } from '@/windows/voice/session-usage-view';
import type { ConversationDeliverableView, UsageRecord } from '@shared/protocol';
import { ModelSelectorChip } from '@/windows/voice/model-selector';
import { WorkspaceBar, type WorkspaceBarValue } from '@/windows/voice/workspace-bar';
import { TopbarOpenWorkspace } from '@/windows/voice/topbar-open-workspace';
import { TurnQueueTray } from '@/windows/voice/turn-queue-tray';
import { isEditableMessage } from '@/windows/voice/lib/message-edit';
import { groupStageBriefs, visibleStageCount } from '@/windows/voice/lib/stage-briefs';
import { replyCopyTargets } from '@/windows/voice/lib/reply-copy';
import { TranscriptBoundary } from './transcript-boundary';
import { markdownPlainText } from '@/shared/markdown-plain-text';
import { VirtualTranscript, type VirtualTranscriptHandle } from './virtual-transcript';
import { useTranscriptRowState } from './transcript-row-state';

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

type VoiceScreenProps = {
  sessionState: SessionState;
  /** True when the session is a call, i.e. it keeps listening without holding. */
  callActive: boolean;
  /** 对话回合状态（模型那一侧）：thinking / replying / error 改变状态文案。 */
  turnPhase: TurnPhase;
  /** 本回合起点（仅在 thinking/replying 时非空）：回合中途出生的任务卡排到
   * 流式元素之后——「先思考、后派手」的时间线在画面上成立（2026-10-14 用户
   * 裁决）；回合收口后传 null，卡回原位、交代照常排其后。 */
  turnStartedAt: number | null;
  /** 通话计时（Call Dock 显示；callActive 门控由 page 侧保证）。 */
  elapsedSeconds: number;
  /** 024：用户静音（Call Dock 静音键；true 时上行被静音门压制）。 */
  callMuted: boolean;
  /** 024：Call Dock 收起（压缩信息由顶栏 chip 承担）。 */
  dockCollapsed: boolean;
  onToggleCallMute: () => void;
  onExpandDock: () => void;
  /** 024：收起 Dock（顶栏「通话中」按钮在展开态点击时收起）。 */
  onCollapseDock?: () => void;
  /** 016：自动记录成功的轻提示（空串＝不显示）。037：可传记忆提示组件（MemoryNotices）。 */
  memoryNotice?: import('react').ReactNode;
  /** 模型失败的提示；独立通路，不伪装成 Hemi 的话。 */
  turnError: string;
  /** 流式打字机：在途回合已收到的增量文本（空 = 没有在流式）。 */
  streamingReply: string;
  /** 048：在途回合的流式思考（null＝没有思考）；正文首字后 endedAt 定格。 */
  streamingThinking?: { text: string; startedAt: number; endedAt: number | null } | null;
  /** 056：本回合按到达顺序的段（思考／正文／工具组），对话流从上往下照实展示。 */
  /** 048：会话用量账本（空数组＝还没完成过调用，入口隐藏）。 */
  usageRecords?: UsageRecord[];
  /** 048：有对话或任务调用进行中（入口运行点）。 */
  usageRunning?: boolean;
  interimText: string;
  transcripts: TranscriptItem[];
  /** A bound conversation whose authoritative flow has not arrived yet is not an empty conversation. */
  conversationLoading?: boolean;
  timelineGeneration?: number;
  timelineNotice?: string;
  /** 004 任务快照（主进程 TaskManager 全量推送）；null = 尚未收到。 */
  taskState: TaskStateSnapshot | null;
  /** 005：对话流任务卡用的快照表（活跃任务实时 / 历史任务冻结），按卡身份键取。 */
  taskSnaps?: Record<string, TaskStateSnapshot>;
  onTaskAction: (action: TaskActionName, payload?: { choice?: TaskPermissionChoice; taskId?: string; taskKey?: string }) => void;
  /**
   * 043：长按键提示只在该平台长按键已定案时显示（mac=Option；缺省按桥的
   * platform 判定，Windows 侧 false 不渲染键名提示）。
   */
  isMacPlatform?: boolean;
  /** 012：产物打开/定位（卡片成果行）。 */
  onOpenArtifact?: (taskId: string, artifactId: string, intent: 'open' | 'reveal') => void;
  /** 025 v3：fixtures 用——初始直接打开某任务的过程抽屉（按快照表键）。 */
  initialProcessTaskKey?: string;
  /** 008 工作对象来源条。 */
  contextState: WorkContextState;
  contextBusy: boolean;
  contextError: string;
  onAttachContext: (kind: WorkContextAttachKind) => void;
  onRefreshContext: (id: string) => void;
  onRemoveContext: (id: string) => void;
  errorMessage: string;
  onToggleCall: () => void;
  /** 模型失败后的重试。 */
  onRetryTurn: () => void;
  /** 024：文字输入（草稿归 VoicePage，这里只透传编辑与提交）。 */
  textDraft: string;
  onTextDraftChange: (next: string) => void;
  onTextSend: () => void;
  /** 029 R-01：停止当前模型回应（只取消本回合；任务与通话不受影响）。 */
  onStopModelTurn: () => void;
  /** 024 消息编辑：开始/取消原位编辑；「重新发送」＝回卷重跑（zcode 语义）。 */
  editingMessageId: string | null;
  onStartEditMessage: (id: string) => void;
  onCancelEditMessage: () => void;
  onEditResendMessage: (id: string, nextText: string) => void;
  /** 024：「继续讨论」——成果上下文回输入框（草稿保留由 page 侧保证）。 */
  onContinueDiscuss?: (snap: TaskStateSnapshot) => void;
  /** 模型请求实际在途（播放/后台任务不锁）。 */
  textModelBusy: boolean;
  /** 有未提交语音（按住录音/临时稿/定稿未提交）。 */
  textPendingSpeech: boolean;
  /** 主脑模型已配置。 */
  textModelReady: boolean;
  /**
   * 032：主界面就近修复条（语音服务/麦克风问题；模型缺失走输入区既有提示）。
   * 修复后 page 侧回读状态自动撤下；null＝无。
   */
  repairHint?: {
    key: 'asr' | 'microphone';
    title: string;
    detail: string;
    actionLabel: string;
    onAction: () => void;
  } | null;
  onOpenSettings: () => void;
  /** 模型未配置的「去设置」直达（→ 模型与路由）；普通设置入口走 onOpenSettings（→ 通用）。 */
  onOpenModelSettings?: () => void;
  skillMarketOpen?: boolean;
  onOpenSkillMarket?: () => void;
  onCloseSkillMarket?: () => void;
  /** 034 fixtures 专用：技能页内部预置状态（透传给 SkillMarket 的 demo）。产品代码不传。 */
  skillMarketScene?: string;
  /** 059：工作流页（与技能中心平级，R-01）。 */
  workflowStudioOpen?: boolean;
  onOpenWorkflowStudio?: () => void;
  onCloseWorkflowStudio?: () => void;
  /** 015：新建对话（清空对话流，首次发言时定新会话 id）。 */
  onNewConversation: () => void;
  /** 015：历史列表载入会话。 */
  onOpenConversation: (id: string) => void;
  /** 015：会话被删除（当前会话被删时解除绑定，内容保留）。 */
  onConversationRemoved: (id: string) => void;
  /** 024：侧栏双击重命名落盘后上抛（当前会话改名时顶栏标题跟着换）。 */
  onConversationRenamed?: (id: string, title: string) => void;
  /** 024 重构：当前会话 id（侧栏高亮；null＝未落盘新会话）。 */
  currentConversationId: string | null;
  /** 顶栏会话标题。 */
  conversationTitle: string;
  /** 033：思考强度档位（modelForm 同源；拨盘与设置页下拉共用一个值）。 */
  thinkingLevel?: ThinkingLevel;
  /** 033：拨盘选档上抛（page 侧落库并同步表单）。 */
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  /** 026 R-10：「继续讨论」带回的任务级追问对象（输入区上方 chip；发送/移除后清除）。 */
  discussContext?: { taskId: string; title: string } | null;
  onClearDiscussContext?: () => void;
  /** 026 R-10：聚焦输入框的信号（数字递增即聚焦——「继续讨论」闭环用）。 */
  composerFocusToken?: number;
  /** 026 fixtures 用——初始直接打开文件预览（file 面板）。 */
  initialPreviewTaskKey?: string;
  /** 027 fixtures 用——初始的预览 Tab 队列（最后一个为当前项）。 */
  initialPreviewTabs?: PreviewTabId[];
  /** 028：当前会话的附件登记（草稿＋已发送；预览 Tab 元数据与 ＋ 菜单候选）。 */
  attachments?: MessageAttachmentView[];
  /** 输入框仅显示未发送草稿；预览合集中的历史附件不能重新进入准备区。 */
  draftAttachments?: MessageAttachmentView[];
  /** 062：当前会话的交付物投影（flow.artifacts 派生；预览 Tab 元数据与 ＋ 菜单候选）。 */
  flowDeliverables?: {
    conversationId: string;
    generation: number;
    items: ConversationDeliverableView[];
  } | null;
  /** 028：输入区附件操作（粘贴/拖入/移除由 page 持有状态）。 */
  onAttachPaste?: (dataUrl: string) => void;
  onAttachDrop?: (filePath: string) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  /** 028：附件登记失败的提示（托盘内联；空串＝无）。 */
  attachError?: string;
  /** 030：当前会话的已发送用户输入（输入区 ↑/↓ 与历史菜单）。 */
  inputHistory?: string[];
  /** 028 二批：`@` 引用——会话范围、草稿芯片与增删/预览回调。 */
  mentionConversationId?: string | null;
  /** 063：`@` 文件/对话候选的工作区范围（与提交的工作区身份一致）。 */
  mentionWorkspaceId?: string | null;
  draftReferences?: MessageReferenceView[];
  onAddReference?: (candidate: MessageReferenceView) => void;
  onRemoveReference?: (key: string) => void;
  /** 063：整组引用/技能替换（标签同步与撤销恢复）＋技能标签与本地切模反馈。 */
  onSetDraftReferences?: (next: MessageReferenceView[]) => void;
  draftSkills?: SkillSelectionView[];
  onSetDraftSkills?: (next: SkillSelectionView[]) => void;
  modelNotice?: string;
  /** 待发送队列托盘：主进程权威状态；执行中普通发送默认排队。 */
  queueState?: TurnQueueState;
  /** 停止收口后且无排队条目：托盘退位给单个「继续任务」按钮（2026-10-18 裁决）。 */
  queueStoppedIdle?: boolean;
  onWithdrawQueued?: (queueItemId: string) => void;
  onResumeQueue?: () => void;
  /** 「继续任务」按钮（停止后无新任务）：真续跑，补一条「继续」回合。 */
  onContinueStoppedTask?: () => void;
  onEditQueued?: (queueItemId: string) => void;
  queueEditing?: boolean;
  queueEditSaving?: boolean;
  onCancelQueueEdit?: () => void;
  /** 060 R-21：让该条优先（停止当前任务，确认后优先派发）。 */
  onPromoteQueued?: (queueItemId: string) => void;
  onReorderQueued?: (inputId: string, overInputId: string, expectedInputIds: string[]) => Promise<void> | void;
  /** 031：模型配置目录与当前会话选择（输入区选择器与 /model 命令共用）。 */
  modelProfiles?: ModelProfilesDirectory | null;
  currentProfileId?: string | null;
  onSelectModelProfile?: (profileId: string) => void;
  /** 056：模型路由弹窗关闭后通知 page 重读模型目录。 */
  onOpenAutoRoutingSettings?: () => void;
  /** 042：访问范围浮层「管理访问授权」→ 设置 → 电脑与浏览器 → 访问授权。 */
  onOpenAccessSettings?: () => void;
  /** 031 fixtures 用：选择器初始展开（静态取证）。 */
  modelSelectorFixtureOpen?: boolean;
  /** 033：工作区登记状态（上下文栏菜单用；侧栏不做工作区分区——2026-10-01 用户裁决）。 */
  workspaceState?: WorkspaceState | null;
  /** 033：当前会话绑定（view＝已绑定；legacy＝旧会话家目录语义；null＝未知）。 */
  workspaceCurrent?: WorkspaceBarValue | null;
  /** 033：目录失效 → 禁发（提示条在上下文栏，禁用在输入区）。 */
  workspaceSendBlocked?: boolean;
  /** 033 fixtures 用：菜单初始展开（静态取证）。 */
  workspaceFixtureOpen?: boolean;
  /** 066 fixtures 用：顶栏打开方式菜单初始展开（静态取证）。 */
  topbarOpenFixtureOpen?: boolean;
  onWorkspaceSelect?: (id: string) => void;
  onWorkspaceClear?: () => void;
  onWorkspacePickFolder?: () => void;
  /** 049：远端项目添加成功（带最新登记状态；先落状态再绑定，防「已移除的项目」兜底误报）。 */
  onWorkspaceRemoteAdded?: (workspace: WorkspaceView, state: WorkspaceState | null) => void;
  /** 049：远端项目「重试连接」（重新探测）。 */
  onWorkspaceRetryRemote?: (id: string) => void;
  onWorkspaceRemove?: (id: string) => void;
};

/** P1 空态：示例任务（点了只填进输入框，不直接发送；文件、联网查询、调研整理各一条；三条正好一行放进 720 阅读列）。 */
const EMPTY_SUGGESTIONS = [
  { icon: FolderInput, text: '按月份归档下载里的截图' },
  { icon: CloudSun, text: '查明天北京的天气' },
  { icon: Table2, text: '对比三款轻薄本，列成表格' },
] as const

export function VoiceScreen({
  sessionState,
  callActive,
  turnPhase,
  turnStartedAt,
  elapsedSeconds,
  callMuted,
  dockCollapsed,
  onToggleCallMute,
  onExpandDock,
  onCollapseDock,
  memoryNotice,
  turnError,
  streamingReply,
  streamingThinking = null,
  usageRecords = [],
  usageRunning = false,
  interimText,
  transcripts,
  conversationLoading = false,
  timelineGeneration = 0,
  timelineNotice,
  taskState,
  taskSnaps: allTaskSnaps,
  onTaskAction,
  // 043：长按键提示只在该平台长按键已定案时显示（mac=Option）。
  isMacPlatform = window.hemiVoice?.platform === 'darwin',
  onOpenArtifact,
  initialProcessTaskKey,
  contextState,
  contextBusy,
  contextError,
  onAttachContext,
  onRefreshContext,
  onRemoveContext,
  errorMessage,
  repairHint,
  onToggleCall,
  onRetryTurn,
  textDraft,
  onTextDraftChange,
  onTextSend,
  onStopModelTurn,
  editingMessageId,
  onStartEditMessage,
  onCancelEditMessage,
  onEditResendMessage,
  onContinueDiscuss,
  textModelBusy,
  textPendingSpeech,
  textModelReady,
  onOpenSettings,
  onOpenModelSettings,
  skillMarketOpen = false,
  onOpenSkillMarket,
  onCloseSkillMarket,
  skillMarketScene,
  workflowStudioOpen,
  onOpenWorkflowStudio,
  onCloseWorkflowStudio,
  onNewConversation,
  onOpenConversation,
  onConversationRemoved,
  onConversationRenamed,
  currentConversationId,
  conversationTitle,
  thinkingLevel = 'default',
  onThinkingLevelChange,
  discussContext = null,
  onClearDiscussContext,
  composerFocusToken,
  initialPreviewTaskKey,
  initialPreviewTabs,
  attachments = [],
  draftAttachments = [],
  flowDeliverables = null,
  onAttachPaste,
  onAttachDrop,
  onRemoveAttachment,
  attachError = '',
  inputHistory = [],
  mentionConversationId = null,
  mentionWorkspaceId = null,
  draftReferences = [],
  onAddReference,
  onRemoveReference,
  onSetDraftReferences,
  draftSkills = [],
  onSetDraftSkills,
  modelNotice = '',
  queueState = { paused: false, items: [] },
  queueStoppedIdle = false,
  onWithdrawQueued,
  onResumeQueue,
  onContinueStoppedTask,
  onEditQueued,
  queueEditing = false,
  queueEditSaving = false,
  onCancelQueueEdit,
  onPromoteQueued,
  onReorderQueued,
  modelProfiles = null,
  currentProfileId = null,
  onSelectModelProfile,
  onOpenAutoRoutingSettings,
  onOpenAccessSettings,
  modelSelectorFixtureOpen = false,
  workspaceState = null,
  workspaceCurrent = null,
  workspaceSendBlocked = false,
  workspaceFixtureOpen = false,
  topbarOpenFixtureOpen = false,
  onWorkspaceSelect,
  onWorkspaceClear,
  onWorkspacePickFolder,
  onWorkspaceRemoteAdded,
  onWorkspaceRetryRemote,
  onWorkspaceRemove,
}: VoiceScreenProps) {
  // Global tasks still feed permission/unread controls. The timeline only consumes its own tasks.
  const taskView = useRef<{ scope: string; values: Record<string, TaskStateSnapshot>; signatures: Map<string, string> }>({ scope: '', values: {}, signatures: new Map() });
  const taskSnaps = useMemo(() => {
    const scope = `${currentConversationId}:${timelineGeneration}`;
    const previous = taskView.current;
    const ids = new Set(transcripts.flatMap(item => [item.taskId, item.taskKey, item.taskSnap?.taskId, item.taskSnap?.key].filter(Boolean)));
    const values: Record<string, TaskStateSnapshot> = {};
    const signatures = new Map<string, string>();
    for (const [key, snap] of Object.entries(allTaskSnaps ?? {})) {
      if (snap.conversationId && snap.conversationId !== currentConversationId) continue;
      if (!snap.conversationId && currentConversationId && !ids.has(snap.taskId) && !ids.has(key)) continue;
      const signature = JSON.stringify(snap);
      signatures.set(key, signature);
      values[key] = previous.scope === scope && previous.signatures.get(key) === signature ? previous.values[key] : snap;
    }
    if (previous.scope === scope && Object.keys(previous.values).length === Object.keys(values).length && Object.keys(values).every(key => values[key] === previous.values[key])) return previous.values;
    taskView.current = { scope, values, signatures };
    return values;
  }, [allTaskSnaps, transcripts, currentConversationId, timelineGeneration]);
  // 窄窗（≤880px）侧栏抽屉：常驻侧栏放不下时收进抽屉，顶栏菜单唤起。
  const [navOpen, setNavOpen] = useState(false);
  const [workspaceAlertSlot, setWorkspaceAlertSlot] = useState<HTMLDivElement | null>(null);
  /** 空态示例任务填入后把焦点交回输入框（与外部的 composerFocusToken 相加，任一变化即聚焦）。 */
  const [suggestionFocus, setSuggestionFocus] = useState(0);
  // 空态＝本会话既无落盘消息、也无任何在途内容。只看 transcripts 时，新对话里
  // 一开口识别气泡就画进对话流顶部，空态引导与居中输入框却还在——气泡孤零零
  // 飘在右上角（2026-10-09 用户实测「识别结果跑偏」）。在途内容一出现即收起空态。
  const conversationEmpty =
    !conversationLoading && !transcripts.length && !interimText && !streamingReply && !streamingThinking && turnPhase !== 'thinking';
  // 025 → 056：任务/子 agent 的执行过程是预览 Tab 队列里的一页（对话流角色行
  // 点击打开，2026-10-15 用户裁决）。冻结档案的快照不在实时快照表里——打开时
  // 定格一份兜底，实时表有同 taskId 的活快照时照旧以实时为准。
  const [processSnaps, setProcessSnaps] = useState<Record<string, TaskStateSnapshot>>({});

  // 027 R-05：多 Tab 应用内预览——Tab 队列 + 当前项；收起（previewOpen=false）
  // 保留已打开 Tab，关闭最后一个 Tab 才清空队列。宽窗右侧并排、窄窗覆盖主列，
  // 均不叠第二层弹窗。
  const [previewTabs, setPreviewTabs] = useState<PreviewTabsState>(() => {
    if (initialPreviewTabs?.length) {
      let state = EMPTY_PREVIEW_TABS;
      for (const tab of initialPreviewTabs) state = openTabInQueue(state, tab);
      return state;
    }
    const key = initialPreviewTaskKey;
    const snap = key ? taskSnaps?.[key] ?? null : null;
    const artifact = snap?.artifacts?.find(isPreviewableArtifact);
    if (snap?.taskId && artifact) {
      const tab: PreviewTabId = { kind: 'artifact', taskId: snap.taskId, artifactId: artifact.id };
      return { tabs: [tab], activeKey: previewTabKey(tab) };
    }
    // 025 fixtures：initialProcessTaskKey 初始打开过程页（现与文件预览同队列）。
    const processKey = initialProcessTaskKey;
    const processSnap = processKey ? taskSnaps?.[processKey] ?? null : null;
    const processId = processSnap?.taskId ?? processSnap?.key ?? processKey ?? null;
    if (processSnap && processId) {
      const tab: PreviewTabId = { kind: 'process', taskId: processId };
      return { tabs: [tab], activeKey: previewTabKey(tab) };
    }
    return EMPTY_PREVIEW_TABS;
  });
  const [previewOpen, setPreviewOpen] = useState(() => previewTabs.tabs.length > 0);

  const openPreviewTab = useCallback((tab: PreviewTabId) => {
    setPreviewOpen(true);
    setPreviewTabs((state) => openTabInQueue(state, tab));
  }, []);
  /** 打开某任务/子 agent 的执行过程 Tab（对话流角色行点击）；冻结快照顺手定格兜底。 */
  const openProcessTab = useCallback((snap: TaskStateSnapshot) => {
    const id = snap.taskId ?? snap.key ?? '';
    if (!id) return;
    setProcessSnaps((current) => ({ ...current, [id]: snap }));
    openPreviewTab({ kind: 'process', taskId: id });
  }, [openPreviewTab]);
  const activatePreviewTab = useCallback((key: string) => {
    setPreviewTabs((state) => ({ ...state, activeKey: key }));
  }, []);
  const closePreviewTab = useCallback((key: string) => {
    setPreviewTabs((state) => closeTabInQueue(state, key));
  }, []);
  // 最后一个 Tab 关闭后收起面板（队列空 ⇒ 无内容可展示）。
  useEffect(() => {
    if (!previewTabs.tabs.length) setPreviewOpen(false);
  }, [previewTabs]);
  // Tab 只属于当前会话：切到别的会话不混入旧会话成果（027 待定事项 4 的本稿口径）。
  useEffect(() => {
    const open = (event: Event) => {
      const invocationId = (event as CustomEvent<{invocationId:string}>).detail?.invocationId;
      if (invocationId) openPreviewTab({kind:'workflow-run',invocationId});
    };
    window.addEventListener('hemi:workflow-preview', open);
    return () => window.removeEventListener('hemi:workflow-preview', open);
  }, [openPreviewTab]);

  const lastConversationRef = useRef(currentConversationId);
  useEffect(() => {
    if (lastConversationRef.current === currentConversationId) return;
    lastConversationRef.current = currentConversationId;
    setPreviewTabs(EMPTY_PREVIEW_TABS);
    setPreviewOpen(false);
    setProcessSnaps({}); // 过程 Tab 同样只属于当前会话
  }, [currentConversationId]);
  // 028：附件元数据索引（预览 Tab 的名字/种类/来源按 attachmentId 查）。
  // 050 R-20 去重：每个任务按 taskId＋正文版本只渲染一份正文——正文在任务行下方的
  // 结果区展示（TaskResultBlock，056 起只有旧任务），其后那条 task-result 回合气泡不再重复出现。
  // 判定不看文字相等、不看 summary 存在与否：回合 id 前缀 task-result: 且对应
  // 任务有正文即隐藏（无正文终态如 denied 的播报兜底文本照常显示）。入史
  // （模型上下文）、落盘与语音播报都不受影响。
  const visibleTranscripts = useMemo(() => {
    const withBody = new Set<string>();
    for (const item of transcripts) {
      if (item.kind !== 'task') continue;
      const key = item.taskId ?? item.taskSnap?.taskId ?? item.taskKey ?? item.taskSnap?.key ?? null;
      const snap = (key ? taskSnaps?.[key] : undefined) ?? item.taskSnap;
      // 056：结果正文只在旧任务（无角色）的一行下方展示——只有那时才隐藏对应气泡。
      if (snap?.resultText?.trim() && !snap.agent) withBody.add(snap.taskId ?? key ?? '');
    }
    // 056：回复段（含在途流式段）里已经原地显示的子 agent，不再另起一行任务条目。
    const inlineCalls = new Set<string>();
    const collect = (parts: TurnPart[] | undefined) => {
      for (const part of parts ?? []) {
        if (part.type === 'tools') for (const call of part.calls) if (call.tool === 'task') inlineCalls.add(call.id);
      }
    };
    for (const item of transcripts) if (item.author === 'hemi' && item.kind !== 'task') collect(item.parts);
    return transcripts.filter((item) => {
      if (item.kind === 'task') {
        const key = item.taskId ?? item.taskSnap?.taskId ?? item.taskKey ?? item.taskSnap?.key ?? null;
        const snap = item.taskFrozen ? item.taskSnap : (key ? taskSnaps?.[key] : undefined) ?? item.taskSnap;
        return !(snap?.agent && snap.toolCallId && inlineCalls.has(snap.toolCallId));
      }
      if (item.author !== 'hemi') return true;
      if (!item.taskId || !withBody.has(item.taskId)) return true;
      return !String(item.id ?? '').startsWith('task-result:');
    });
  }, [transcripts, taskSnaps]);
  // 026 R-09：同任务的连续阶段简报收成一条进展时间线（只动视觉密度）。
  const transcriptEntries = useMemo(() => groupStageBriefs(visibleTranscripts), [visibleTranscripts]);
  const replyCopies = useMemo(() => replyCopyTargets(visibleTranscripts), [visibleTranscripts]);

  /** 060 S2（R-07/R-09）：统一有序渲染——已删除「回合中途任务卡沉底、用户插话提上、
   *  收口后恢复原位」的按作者/出生时间重分区（该规则会让运行中与完成后顺序不一致）。
   *  历史条目一律按 timeline 原序渲染；流式块只作为「当前回合的最新尾部」追加在
   *  末尾（收口投影后由顺序门槛接续，不换位）。 */

  /** 渲染一段转录条目（分区后各段独立判定连续头侧行，不跨流式元素）。 */
  function renderTranscriptEntry(index: number) {
      const entries = transcriptEntries;
      const entry = entries[index];
      // 连续 Hemi 消息只在首条出头侧行（受理语/阶段简报/终态交代
      // 会各自入流，逐条挂头像在视觉上碎；设计稿无此场景，按聊天
      // 惯例合并——任务卡插入即断组）。简报组按组内首条参与判定。
      const item = entry.type === 'stages' ? entry.items[0] : entry.item;
      const prevEntry = index > 0 ? entries[index - 1] : null;
      const prev = prevEntry ? (prevEntry.type === 'stages' ? prevEntry.items[0] : prevEntry.item) : null;
      const continuation =
        item.author === 'hemi' &&
        item.kind !== 'task' &&
        Boolean(prev && prev.author === 'hemi' && prev.kind !== 'task');
      // 037：标记一段 Hemi 输出（回复/任务卡）的首条（data-lead；头像已按走查裁决去掉）。
      const lead = (item.author === 'hemi' || item.kind === 'task') &&
        !(prev && (prev.author === 'hemi' || prev.kind === 'task'));
      if (entry.type === 'stages') {
        const stageSnap = taskSnaps?.[entry.taskId];
        const copyText = replyCopies.get(entry.items[entry.items.length - 1].id);
        return (
          <div key={entry.key} className="contents" data-reply-end={copyText ? 'true' : undefined}>
          <StageBriefsItem
            items={entry.items}
            showRelation={entry.showRelation}
            current={entry.latest && Boolean(stageSnap) && stageSnap?.phase !== 'terminal'}
            afterCard={prev?.kind === 'task'}
            continuation={continuation}
            lead={lead}
            taskTitle={stageSnap?.taskText}
          />
          {copyText ? <ReplyCopyActions text={copyText} /> : null}
          </div>
        );
      }
      const copyText = replyCopies.get(item.id);
      return <div key={item.id} className="contents" data-flow-row={item.id}
        data-flow-kind={item.kind ?? item.author} data-run-id={item.flow?.runId}
        data-input-id={item.flow?.inputId} data-item-id={item.flow?.itemId}
        data-part-ids={JSON.stringify(item.flow?.partIds ?? [])}
        data-task-id={item.taskId} data-task-run={item.taskSnap?.runs}
        data-reply-end={copyText ? 'true' : undefined}
      >{item.kind === 'task' ? (
        <TaskTranscriptItem
          key={item.id}
          item={item}
          taskSnaps={taskSnaps}
          onTaskAction={onTaskAction}
          onOpenProcess={openProcessTab}
          onOpenArtifact={onOpenArtifact}
          onOpenPreview={(taskId, artifactId) => openPreviewTab({ kind: 'artifact', taskId, artifactId })}
          onOpenReportPreview={(snap) => openPreviewTab({ kind: 'artifact', taskId: snap.taskId ?? '', artifactId: null })}
        />
      ) : (
        <ChatTurnItem
          key={item.id}
          item={item}
          continuation={continuation}
          lead={lead}
          showRelation={entry.showRelation}
          taskTitleOf={(taskId) => taskSnaps?.[taskId]?.taskText}
          editing={editingMessageId === item.id}
          busy={textModelBusy}
          onStartEdit={onStartEditMessage}
          onCancelEdit={onCancelEditMessage}
          onEditResend={onEditResendMessage}
          onPreviewAttachment={openAttachmentPreview}
          renderText={renderReplyTextWithLinks}
          renderTask={renderTaskCall}
          onOpenDeliverable={openDeliverablePreview}
        />
      )}{copyText ? <ReplyCopyActions text={copyText} /> : null}</div>;
  }

  const attachmentMetaMap = useMemo(() => {
    const map = new Map<string, MessageAttachmentView>();
    for (const item of attachments) map.set(item.attachmentId, item);
    for (const item of draftAttachments) map.set(item.attachmentId, item);
    return map;
  }, [attachments, draftAttachments]);
  const attachmentMetaOf = useCallback(
    (conversationId: string, attachmentId: string) => {
      const meta = attachmentMetaMap.get(attachmentId);
      return meta && meta.conversationId === conversationId ? meta : undefined;
    },
    [attachmentMetaMap],
  );
  const attachmentOptions = useMemo<PreviewTabId[]>(
    () =>
      [...attachmentMetaMap.values()].map((item) => ({
        kind: 'attachment',
        conversationId: item.conversationId,
        attachmentId: item.attachmentId,
      })),
    [attachmentMetaMap],
  );
  // ---- 062：会话交付物（主/子 agent 的文件交付与本地链接对象进同一预览队列） ----
  const deliverablesOfCurrentConversation = flowDeliverables?.conversationId === currentConversationId
    ? flowDeliverables
    : null;
  const deliverableMetaOf = useCallback(
    (conversationId: string, artifactId: string) =>
      deliverablesOfCurrentConversation?.items.find((item) => item.artifactId === artifactId && conversationId === currentConversationId),
    [deliverablesOfCurrentConversation, currentConversationId],
  );
  /** ＋ 菜单候选已按保留的运行筛选；回卷前仍有效的交付不因代次变化消失。 */
  const deliverableOptions = useMemo<PreviewTabId[]>(() => {
    if (!deliverablesOfCurrentConversation || !currentConversationId) return [];
    return deliverablesOfCurrentConversation.items
      .map((item) => ({ kind: 'deliverable' as const, conversationId: currentConversationId, artifactId: item.artifactId }));
  }, [deliverablesOfCurrentConversation, currentConversationId]);
  /** 交付入口（对话流 chip / 派单卡）→ 右侧预览；重复点击只激活原 Tab。 */
  const openDeliverablePreview = useCallback(
    (artifactId: string) => {
      if (!artifactId || !currentConversationId) return;
      openPreviewTab({ kind: 'deliverable', conversationId: currentConversationId, artifactId });
    },
    [openPreviewTab, currentConversationId],
  );
  // Markdown 本地文件链接：宿主受控解析后进右侧；失败原位 toast 说明原因（R-02/AC-03）。
  const [linkToast, setLinkToast] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!linkToast) return;
    const timer = window.setTimeout(() => setLinkToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [linkToast]);
  const openLocalFileLink = useCallback(
    (href: string) => {
      if (!currentConversationId) return;
      void window.hemiVoice
        ?.resolveConversationLink(currentConversationId, href)
        .then((result) => {
          if (result?.ok && result.artifactId) {
            openPreviewTab({
              kind: 'deliverable',
              conversationId: currentConversationId,
              artifactId: result.artifactId,
              linkPath: result.path ?? undefined,
              linkName: result.name ?? undefined,
            });
            return;
          }
          setLinkToast({ id: Date.now(), text: result?.message || '这个链接打不开' });
        })
        .catch(() => setLinkToast({ id: Date.now(), text: '链接解析失败，稍后再试' }));
    },
    [currentConversationId, openPreviewTab],
  );
  const renderReplyTextWithLinks = useCallback(
    (text: string) => renderReplyText(text, { onLocalLink: openLocalFileLink }),
    [openLocalFileLink],
  );
  /** 028：附件预览入口（草稿托盘、历史 chip、＋ 菜单共用）——进同一宿主队列。 */
  const openAttachmentPreview = useCallback(
    (conversationId: string, attachmentId: string) => {
      openPreviewTab({ kind: 'attachment', conversationId, attachmentId });
    },
    [openPreviewTab],
  );
  // 028：移除未发附件只关闭对应页签（其他页签、队列与收起态不动）。
  const knownAttachmentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(attachmentMetaMap.keys());
    let removed = false;
    for (const id of knownAttachmentIdsRef.current) {
      if (current.has(id)) continue;
      removed = true;
      setPreviewTabs((state) => {
        const tab = state.tabs.find(
          (item) => item.kind === 'attachment' && item.attachmentId === id,
        );
        return tab ? closeTabInQueue(state, previewTabKey(tab)) : state;
      });
    }
    knownAttachmentIdsRef.current = current;
    if (removed) setPreviewOpen((open) => open); // 队列可能已空，交给既有收起效应处理
  }, [attachmentMetaMap]);
  // 056（2026-10-15 用户反馈「对话流顺序错位」）：子 agent 按发起它的 task 调用原地显示——
  // toolCallId → 快照；续用同一会话时快照的 toolCallId 换成新那次调用，旧调用处不再显示。
  const snapByToolCall = useMemo(() => {
    const map = new Map<string, TaskStateSnapshot>();
    // 档案里的冻结快照先放（重启后实时快照表里可能没有旧任务），实时快照覆盖。
    for (const item of transcripts) {
      if (item.kind === 'task' && item.taskSnap?.toolCallId) map.set(item.taskSnap.toolCallId, item.taskSnap);
    }
    for (const snap of Object.values(taskSnaps ?? {})) if (snap.toolCallId) map.set(snap.toolCallId, snap);
    return map;
  }, [taskSnaps, transcripts]);
  const renderTaskCall = useCallback((call: { id: string }) => {
    const snap = snapByToolCall.get(call.id);
    return snap ? (
      <CompactDelegation snap={snap} onAction={onTaskAction} onOpenProcess={() => openProcessTab(snap)} />
    ) : null;
  }, [snapByToolCall, onTaskAction, openProcessTab]);

  // 021 口径（2026-10-07 泄漏修复＋同日补洞）：确认卡只属于任务自己的会话——
  // 与任务卡入列（page.tsx）、语音授权提醒同过滤。无会话身份的任务（新对话
  // 首轮链路未带 id）跟着当前视图走；别的会话的等待不在此弹卡，改走下方
  // 跨会话提示条——等待授权必须始终有一条用户看得见的通道。
  const currentConvId = currentConversationId ?? null;
  // 056：主 agent 自己的确认（agentPermissions）与子 agent 的等待卡合并排队——它们都是
  // 「Hemi 需要你的允许」，同一张卡、同一套 decide（key 定向）。
  const agentWaiting = (taskState?.agentPermissions ?? []).map((entry) => ({
    ...(taskState as TaskStateSnapshot),
    key: entry.key,
    taskId: entry.taskId,
    conversationId: entry.conversationId,
    inputSource: entry.inputSource,
    taskText: '',
    permission: entry.permission,
    tasks: undefined,
  } as TaskStateSnapshot));
  const tasksWithPermission = [...agentWaiting, ...(taskState?.tasks ?? []).filter((task) => task.permission)];
  const convOf = (task: TaskStateSnapshot) => task.conversationId ?? null;
  const waitingTasks = tasksWithPermission.filter(
    (task) => convOf(task) === null || convOf(task) === currentConvId,
  );
  /** 别的会话在等授权（本会话不弹卡，出提示条引路——2026-10-07 用户真机钓出「没弹授权」盲区）。 */
  const foreignWaitingTasks = tasksWithPermission.filter(
    (task) => convOf(task) !== null && convOf(task) !== currentConvId,
  );
  const activeTaskIds = useMemo(
    () =>
      (taskState?.tasks ?? [])
        .filter((task) => task.phase !== 'terminal' && task.taskId)
        .map((task) => task.taskId as string),
    [taskState],
  );
  const isError = turnPhase === 'error' || sessionState === 'error';
  const errorCopy = sessionState === 'error'
    ? errorMessage || '语音服务中断了，可以稍后再试'
    : turnError || '这次没接上，再试一次';

  // 017 R-08：并行任务各自可能等确认——确认卡一次只出一张（最早等待的
  // 先出），其余收成一行「在等」提示（只报名字，各自独立倒计时）。

  const transcriptVirtual = useRef<VirtualTranscriptHandle>(null);
  const [transcriptPinned, setTranscriptPinned] = useState(true);
  const lastUserItemId = useMemo(() => [...transcripts].reverse().find(item => item.author === 'user')?.id ?? null, [transcripts]);
  const rowIdsRef = useRef<string[]>([]);
  const transcriptRowIds = useMemo(() => {
    const next = [...transcriptEntries.map(entry => entry.type === 'stages' ? entry.key : entry.item.id), ...(interimText ? ['interim-speech'] : [])];
    if (next.length === rowIdsRef.current.length && next.every((id, index) => id === rowIdsRef.current[index])) return rowIdsRef.current;
    rowIdsRef.current = next;
    return next;
  }, [transcriptEntries, Boolean(interimText)]);

  // 037：顶栏标题旁的工作区名（旧会话无绑定＝家目录）。P1：默认空间不报——输入区
  // 芯片已写着它，顶栏只在绑了项目（或旧会话家目录）时补这层上下文。
  // 049：远端项目带主机（「atlas · devbox」，设计稿 v2 实施补的点）。
  const workspaceLabel =
    workspaceCurrent?.kind === 'view'
      ? workspaceCurrent.view.type === 'project'
        ? workspaceCurrent.view.host
          ? `${workspaceCurrent.view.name} · ${workspaceCurrent.view.host}`
          : workspaceCurrent.view.name
        : ''
      : workspaceCurrent?.kind === 'legacy'
        ? '家目录'
        : '';

  // 066：本机项目工作区才有顶栏「打开目录」入口——默认空间/旧会话家目录没有
  // 项目含义，远端项目（host）的目录在本地文件管理器里没有对应物，都不显示。
  const openWorkspaceView =
    !skillMarketOpen &&
    !workflowStudioOpen &&
    workspaceCurrent?.kind === 'view' &&
    workspaceCurrent.view.type === 'project' &&
    !workspaceCurrent.view.host
      ? workspaceCurrent.view
      : null;

  // 037：⌘N 新建对话（侧栏按钮上的快捷键提示）。
  const newConversationRef = useRef<() => void>(() => {});
  newConversationRef.current = () => {
    onNewConversation();
    onCloseSkillMarket?.();
    setNavOpen(false);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'n' || event.isComposing) return;
      event.preventDefault();
      newConversationRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [workflowHeading, setWorkflowHeading] = useState("工作流");

  // 待重发队列的头一条（重发必须按序，其余按钮禁用）。

  return (
    <main
      className="voice-shell compact-shell h24-shell min-h-dvh overflow-hidden"
      data-market-open={skillMarketOpen ? 'true' : 'false'}
      data-workflow-open={workflowStudioOpen ? 'true' : 'false'}
    >
      <AppTopBar
        showBrand={false}
        /* 034 v3：技能中心是图标栏平级页面，顶栏只报位置（返回＝rail 首页）。
           037：顶栏只属于对话列——抽屉钮（≤880）、标题、工作区名依次左排。 */
        title={
          <>
            <button
              type="button"
              className="icon-btn h24-nav-toggle"
              onClick={() => setNavOpen((open) => !open)}
              aria-label={navOpen ? '关闭导航' : '打开导航'}
              aria-expanded={navOpen}
              title="导航"
            >
              <MenuIcon className="size-4" />
            </button>
            <h2 className="h24-conversation-title">{skillMarketOpen ? '技能' : workflowStudioOpen ? workflowHeading : conversationTitle}</h2>
            {!skillMarketOpen && !workflowStudioOpen && workspaceLabel ? <span className="h37-topbar-meta">{workspaceLabel}</span> : null}
            {/* 037：技能页的「市场 / 内置 / 已安装」分段控件与导入钮由 SkillMarket portal 进这个槽。 */}
            {workflowStudioOpen ? <div id="h59-editor-title-slot" /> : null}
            {skillMarketOpen ? <div id={SKILLS_TOPBAR_SLOT_ID} className="h37-skills-topbar" /> : null}
          </>
        }
        actions={
          /* 037：未通话时是幽灵按钮「开始通话」；通话中通话条嵌在输入框顶部，
             顶栏不重复——仅当通话条收起时留一个可点回的状态 chip。
             结束通话在通话条的挂断键。
             066：最右是本机项目工作区的「打开目录」split 按钮。 */
          workflowStudioOpen ? <div id="h59-editor-actions-slot" /> : (
            <>
              {callActive && !dockCollapsed ? null : (
                <button
                  type="button"
                  className="h24-call-nav"
                  data-calling={callActive ? 'true' : 'false'}
                  disabled={sessionState === 'requesting'}
                  aria-pressed={callActive}
                  title={callActive ? '展开通话条' : '在当前对话开始实时通话'}
                  onClick={() => {
                    if (!callActive) onToggleCall();
                    else onExpandDock();
                  }}
                >
                  {callActive || sessionState === 'requesting'
                    ? <CallActivityIndicator active={!callMuted} />
                    : <Phone className="size-4" aria-hidden="true" />}
                  <span className="h37-call-nav-label">
                    {callActive ? (callMuted ? '已静音' : '通话中') : sessionState === 'requesting' ? '接通中…' : '开始通话'}
                  </span>
                  {callActive ? <span>{formatCallElapsed(elapsedSeconds)}</span> : null}
                </button>
              )}
              {openWorkspaceView ? <TopbarOpenWorkspace view={openWorkspaceView} fixtureOpen={topbarOpenFixtureOpen} /> : null}
            </>
          )
        }
      />

      {/* 034 v3：图标栏（页面导航）＋工作区并列；技能中心打开时工作区单列
          铺满（CSS 挂在 data-market-open 上），对话列表只在首页页面内出现。 */}
      <div className="h24-frame">
        <NavRail
          page={skillMarketOpen ? 'skills' : workflowStudioOpen ? 'workflows' : 'home'}
          onShowHome={() => {
            onCloseSkillMarket?.();
            onCloseWorkflowStudio?.();
          }}
          onShowSkills={() => {
            onCloseWorkflowStudio?.();
            onOpenSkillMarket?.();
          }}
          onShowWorkflows={onOpenWorkflowStudio ? () => {
            onCloseSkillMarket?.();
            onOpenWorkflowStudio();
          } : undefined}
          onOpenSettings={onOpenSettings}
        />
        <section
          className="h24-workspace"
          data-nav-open={navOpen ? 'true' : 'false'}
          data-preview-open={
            !skillMarketOpen && previewOpen && previewTabs.tabs.length ? 'true' : 'false'
          }
        >
          {/* 抽屉打开时的遮罩（窄窗）；常驻侧栏布局下不渲染命中。 */}
          <button
            type="button"
            className="h24-backdrop"
            aria-label="关闭导航"
            tabIndex={-1}
            onClick={() => setNavOpen(false)}
          />
          {!workflowStudioOpen ? <ConversationSidebar
            onHistoryOpen={() => setNavOpen(false)}
            currentConversationId={currentConversationId}
            conversationVisible={!skillMarketOpen}
            onNewConversation={() => {
              onNewConversation();
              onCloseSkillMarket?.();
              setNavOpen(false);
            }}
            onOpenConversation={(id) => {
              onOpenConversation(id);
              onCloseSkillMarket?.();
              setNavOpen(false);
            }}
            onConversationRemoved={onConversationRemoved}
            onConversationRenamed={onConversationRenamed}
          /> : null}

          {skillMarketOpen ? <SkillMarket onBack={() => onCloseSkillMarket?.()} pendingApproval={waitingTasks.length > 0} demo={skillMarketScene} /> : null}

          {/* 059：工作流页（与技能中心平级）；main 区在两页打开时都隐藏。 */}
          {workflowStudioOpen ? (
            <WorkflowStudio
              onNavigate={() => setNavOpen(false)}
              onTitleChange={setWorkflowHeading}
              taskState={taskState} onTaskAction={onTaskAction}
              conversationId={currentConversationId} currentProfileId={currentProfileId} modelProfiles={modelProfiles} onOpenConversation={onOpenConversation}
              onClosePreview={()=>setPreviewOpen(false)}
              onOpenDefinitionPreview={(workflowId, revision) => openPreviewTab({ kind: 'workflow-definition', workflowId, revision })}
            />
          ) : null}

          <section className="h24-main" hidden={skillMarketOpen || workflowStudioOpen} data-empty={conversationEmpty ? 'true' : undefined}>
            {foreignWaitingTasks.length ? (
              // 跨会话等待引路条（2026-10-07）：别的会话的任务在等授权时，本会话
              // 顶部给一条去路——否则卡只在自己的会话出现，用户在这边什么都
              // 看不到，任务就在看不见的地方超时。
              <div className="h37-perm-notice" role="status">
                <span className="h37-perm-notice-dot" aria-hidden="true" />
                <span className="h37-perm-notice-text">
                  {foreignWaitingTasks.length > 1
                    ? `${foreignWaitingTasks[0].taskText} 等 ${foreignWaitingTasks.length} 个任务在等授权`
                    : `${foreignWaitingTasks[0].taskText} 在等你的授权`}
                </span>
                <button
                  type="button"
                  className="h37-perm-notice-go"
                  onClick={() => {
                    const target = foreignWaitingTasks[0].conversationId;
                    if (target) onOpenConversation(target);
                  }}
                >
                  去处理
                </button>
              </div>
            ) : null}
            {waitingTasks.length ? (
              <PermissionCard
                snap={waitingTasks[0]}
                queuedTitles={waitingTasks.slice(1).map((task) => task.taskText)}
                onDecide={(choice) =>
                  onTaskAction('decide', {
                    choice,
                    taskId: waitingTasks[0].taskId ?? waitingTasks[0].key ?? undefined,
                  })
                }
                onStop={() =>
                  onTaskAction('stop', {
                    taskId: waitingTasks[0].taskId ?? waitingTasks[0].key ?? undefined,
                  })
                }
              />
            ) : null}

            {/* 滚动区与「回到底部」按钮同层包装——跳底按钮锚到这里，悬在输入区上方。
                is-empty：设计稿 blank 态把引导推到画布底部、紧贴输入区。 */}
            <div className="relative flex min-h-0 flex-1 flex-col h24-stream-wrap">
              <ScrollArea
                className="transcript-scroll min-h-0 flex-1"
                data-transcript-scroll
              >
                {timelineNotice ? <p className="h24-reply-status" role="status">{timelineNotice}</p> : null}
                <div className="conversation-list h24-reading">
                  <TranscriptBoundary key={`${currentConversationId}:${timelineGeneration}`}><VirtualTranscript
                    key={`${currentConversationId ?? 'new'}:${timelineGeneration}`}
                    ref={transcriptVirtual}
                    rowIds={transcriptRowIds}
                    editingId={editingMessageId}
                    onPinnedChange={setTranscriptPinned}
                    lastUserId={lastUserItemId}
                    loading={conversationLoading}
                    getRowText={(index, state) => {
                      const entry = transcriptEntries[index];
                      if (!entry) return interimText;
                      if (entry.type === 'stages') return entry.items.map(item => markdownPlainText(item.text)).join('\n\n');
                      const item = entry.item;
                      if (item.author === 'user' || item.kind === 'task') return item.text;
                      if (!item.parts?.length) return markdownPlainText(item.text);
                      return item.parts.flatMap((part, index) => {
                        if (part.type === 'text') return [markdownPlainText(part.text)];
                        const key = (part as { partId?: string }).partId ?? `${part.type}-${index}`;
                        if (part.type === 'thinking' && state?.get(`${key}/thinking-expanded`)) return [part.text];
                        if (part.type === 'file-delivery') return [part.name];
                        return [];
                      }).join('\n\n');
                    }}
                    renderRow={index => index < transcriptEntries.length ? renderTranscriptEntry(index) : (
                      <article className="h24-user-message" aria-live="polite">
                        <p className="h24-user-bubble is-interim">
                          {interimText}<span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                        </p>
                      </article>
                    )}
                  /></TranscriptBoundary>
                </div>
              </ScrollArea>

              <button
                type="button"
                className="jump-btn panel-jump"
                data-visible={transcriptPinned ? 'false' : 'true'}
                onClick={() => transcriptVirtual.current?.scrollToBottom()}
                tabIndex={transcriptPinned ? -1 : 0}
              >
                <ArrowDown className="size-3.5" />
                回到底部
              </button>

              {/* 等授权时对话流蒙高斯模糊（2026-10-07 用户裁决）——聚焦授权卡，
                  替代旧「任务卡降不透明度」；只做视觉，滚动等交互不禁用。 */}
              {waitingTasks.length ? <div className="h37-perm-frost" aria-hidden="true" /> : null}
            </div>

            {/* 037：记忆提示（「记住了：…」/「已忘记：…」+ 查看 / 撤销），每条自带 role=status。 */}
            {typeof memoryNotice === 'string' && memoryNotice ? (
              <p className="h24-memory-notice" data-legacy="true" role="status">
                {memoryNotice}
              </p>
            ) : memoryNotice ? (
              <div className="h24-memory-notice">{memoryNotice}</div>
            ) : null}

            {isError ? (
              <div className="h24-turn-error" role="alert">
                <span className="h24-turn-error-text">{errorCopy}</span>
                {turnPhase === 'error' ? (
                  <button type="button" className="btn-retry" onClick={onRetryTurn}>
                    <RotateCcw className="size-3.5" />
                    重试
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* 空态引导只看本会话有没有内容（005 起任务卡进对话流，全局守卫会误杀）。
                P1：引导与输入框成组居中（上方滚动区与下方 spacer 平分余量），首条消息后
                spacer 收起、输入框沉到底部。 */}
            {conversationEmpty ? (
              <div className="h24-empty" aria-label="功能引导">
                <span className="h37-orb" data-live="true" style={{ '--orb': '40px' } as CSSProperties} aria-hidden="true" />
                <p className="h24-empty-greeting">今天想做什么？</p>
                <p className="h24-empty-hint">直接说，或交给 Hemi 一件事——语音、文字都行。</p>
              </div>
            ) : null}

            <div className="h24-composer">
              {/* 033：工作区目录失效提示条的槽位（芯片本体在输入工具行，经 portal 渲染到这）。 */}
              <div className="h37-workspace-alert-slot" ref={setWorkspaceAlertSlot} />
              {/* 032：就近修复条（语音服务/麦克风）——问题在相关入口旁说明并直达设置。 */}
              {repairHint ? (
                <div className="h24-repair-strip" role="status" data-key={repairHint.key}>
                  <span className="h24-repair-symbol" aria-hidden="true">!</span>
                  <div>
                    <strong>{repairHint.title}</strong>
                    <span>{repairHint.detail}</span>
                  </div>
                  <button type="button" onClick={repairHint.onAction}>
                    {repairHint.actionLabel}
                    <span aria-hidden="true"> ›</span>
                  </button>
                </div>
              ) : null}
              {/* 待发送托盘：排序、阶段交接、编辑、撤回和暂停后继续。 */}
              <TurnQueueTray
                state={queueState}
                stoppedIdle={queueStoppedIdle}
                onContinue={onContinueStoppedTask}
                onWithdraw={(id) => onWithdrawQueued?.(id)}
                onEdit={(id) => onEditQueued?.(id)}
                onResume={() => onResumeQueue?.()}
                onPromote={(id) => onPromoteQueued?.(id)}
                onReorder={onReorderQueued}
              />
              {/* 026 R-10：「继续讨论」带回的追问对象（发送前可见、可移除；不清空草稿）。 */}
              {discussContext ? (
                <div className="h24-discuss-context">
                  <Link2 className="size-3" aria-hidden="true" />
                  <span className="h24-discuss-context-label" title={discussContext.title}>
                    接着聊：{discussContext.title}
                  </span>
                  <button
                    type="button"
                    className="h24-discuss-context-clear"
                    aria-label="移除追问对象"
                    title="移除追问对象"
                    onClick={onClearDiscussContext}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ) : null}
              {/* 008：本次对话附带的对象（chips 收在输入区上方）。 */}
              {contextState.objects.length || contextError ? (
                <div className="context-carry">
                  <span className="context-carry-label">本次附带</span>
                  <ContextChips
                    objects={contextState.objects}
                    busy={contextBusy}
                    onRefresh={onRefreshContext}
                    onRemove={onRemoveContext}
                  />
                  {contextError ? <span className="context-error">{contextError}</span> : null}
                </div>
              ) : null}
              <TextComposer
                value={textDraft}
                onChange={onTextDraftChange}
                onSend={onTextSend}
                queueEditing={queueEditing}
                queueEditSaving={queueEditSaving}
                onCancelQueueEdit={onCancelQueueEdit}
                busy={textModelBusy}
                pendingSpeech={textPendingSpeech}
                modelReady={textModelReady}
                callActive={callActive}
                onOpenSettings={onOpenModelSettings ?? onOpenSettings}
                focusToken={(composerFocusToken ?? 0) + suggestionFocus}
                sendBlocked={workspaceSendBlocked}
                sendBlockedHint={
                  workspaceCurrent?.kind === 'view' && workspaceCurrent.view.host
                    ? '连不上服务器，恢复连接后才能发送'
                    : undefined
                }
                fresh={!transcripts.length}
                attachments={draftAttachments}
                attachError={attachError}
                header={
                  callActive && !dockCollapsed ? (
                    <CallDock
                      sessionState={sessionState}
                      turnPhase={turnPhase}
                      streamingReply={streamingReply}
                      thinkingSince={streamingThinking && streamingThinking.endedAt == null ? streamingThinking.startedAt : null}
                      interimText={interimText}
                      elapsedSeconds={elapsedSeconds}
                      muted={callMuted}
                      onToggleMute={onToggleCallMute}
                      onEndCall={onToggleCall}
                    />
                  ) : null
                }
                trailing={
                  // P2（031 用户裁决同位）：提交簇＝[按住说话提示][模型]，紧贴发送键。
                  <div className="text-composer-submit">
                    {/* 043：长按键提示平台化（win 的快照快捷键未定案时不显示键名）。 */}
                    {isMacPlatform ? (
                      <span className="h24-shortcut-hint" role="status" title="按住 Option 说话，松开发送">
                        <Mic aria-hidden="true" />
                        <span>按住说话</span>
                        <kbd aria-label="Option">⌥</kbd>
                      </span>
                    ) : null}
                    {onSelectModelProfile ? (
                      <ModelSelectorChip
                        directory={modelProfiles}
                        currentProfileId={currentProfileId}
                        onSelect={onSelectModelProfile}
                        onOpenAutoRoutingSettings={onOpenAutoRoutingSettings}
                        fixtureOpen={modelSelectorFixtureOpen}
                      />
                    ) : null}
                  </div>
                }
                onAttachPaste={onAttachPaste}
                onAttachDrop={onAttachDrop}
                onRemoveAttachment={onRemoveAttachment}
                onPreviewAttachment={openAttachmentPreview}
                onStopTurn={onStopModelTurn}
                inputHistory={inputHistory}
                mentionConversationId={mentionConversationId}
                mentionWorkspaceId={mentionWorkspaceId}
                references={draftReferences}
                skills={draftSkills}
                onSetReferences={onSetDraftReferences}
                onSetSkills={onSetDraftSkills}
                modelNotice={modelNotice}
                onAddReference={onAddReference}
                onRemoveReference={onRemoveReference}
                onPreviewReference={(reference) => {
                  if (reference.kind === 'artifact' && reference.taskId) {
                    openPreviewTab({ kind: 'artifact', taskId: reference.taskId, artifactId: reference.artifactId ?? null });
                  } else if (reference.kind === 'attachment' && reference.attachmentId) {
                    openPreviewTab({
                      kind: 'attachment',
                      conversationId: mentionConversationId ?? '',
                      attachmentId: reference.attachmentId,
                    });
                  }
                }}
                modelProfiles={modelProfiles}
                onSelectModelProfile={onSelectModelProfile}
                tasksRunning={(taskState?.tasks ?? []).some((task) => task.phase !== 'terminal')}
                toolbar={
                  <>
                    <ContextAttachButton busy={contextBusy} error={contextError} onAttach={onAttachContext} />
                    <span className="h37-tool-sep" aria-hidden="true" />
                    {/* 033：工作区——发送前可见当前任务在哪个目录工作（v2 默认优先）。 */}
                    <WorkspaceBar
                      state={workspaceState}
                      current={workspaceCurrent}
                      sendBlocked={workspaceSendBlocked}
                      fixtureOpen={workspaceFixtureOpen}
                      alertSlot={workspaceAlertSlot}
                      onSelect={(id) => onWorkspaceSelect?.(id)}
                      onClear={() => onWorkspaceClear?.()}
                      onPickFolder={() => onWorkspacePickFolder?.()}
                      onRemoteAdded={
                        onWorkspaceRemoteAdded
                          ? (workspace, state) => onWorkspaceRemoteAdded(workspace, state)
                          : undefined
                      }
                      onRetryRemote={(id) => onWorkspaceRetryRemote?.(id)}
                      onRemove={(id) => onWorkspaceRemove?.(id)}
                    />
                    {/* 033：思考强度拨盘（设置页「正在使用」同源）。041：全局一档，自动路由下也可改。 */}
                    <ThinkingLevelStrip
                      level={thinkingLevel}
                      onChange={(level) => onThinkingLevelChange?.(level)}
                    />
                    {/* 042：访问范围浮层（盾牌只读入口，替换 005 三档拨盘）；
                        只列持续授权＋进行中任务的本任务授权，「管理」直达设置访问授权区。 */}
                    <ScopePopover
                      activeTaskIds={activeTaskIds}
                      onManage={onOpenAccessSettings ?? onOpenSettings}
                    />
                  </>
                }
              />
              {/* 048：居中用量预览，悬浮或键盘聚焦展开。 */}
              <SessionUsage records={usageRecords} running={usageRunning} />
              {conversationEmpty ? (
                <div className="h24-suggestions" aria-label="可以这样开始">
                  {EMPTY_SUGGESTIONS.map(({ icon: Icon, text }) => (
                    <button
                      key={text}
                      type="button"
                      className="h24-suggestion"
                      onClick={() => {
                        onTextDraftChange(text);
                        setSuggestionFocus((value) => value + 1);
                      }}
                    >
                      <Icon aria-hidden="true" />
                      <span>{text}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="h24-empty-spacer" aria-hidden="true" />
          </section>

          {/* 027 R-05：多 Tab 应用内预览面板——工作区的第三格（宽窗 ≥1180px 并排；
              窄窗覆盖主列）。Tab 切换只换当前对象，对话滚动位置与草稿不动。
              056：执行过程也是这里的一种 Tab（对话流角色行点击打开）。 */}
          {!skillMarketOpen && previewOpen && previewTabs.tabs.length ? (
            <FilePreviewPanel
              tabs={previewTabs.tabs}
              activeKey={previewTabs.activeKey ?? previewTabKey(previewTabs.tabs[0])}
              snapOf={(taskId) => taskSnaps?.[taskId] ?? processSnaps[taskId]}
              attachmentMetaOf={attachmentMetaOf}
              attachmentOptions={attachmentOptions}
              deliverableMetaOf={deliverableMetaOf}
              deliverableOptions={deliverableOptions}
              onActivate={activatePreviewTab}
              onOpenTab={openPreviewTab}
              onCloseTab={closePreviewTab}
              onCollapse={() => setPreviewOpen(false)}
              onContinueDiscuss={
                onContinueDiscuss
                  ? (snap) => {
                      setPreviewOpen(false);
                      onContinueDiscuss(snap);
                    }
                  : undefined
              }
              onTaskAction={onTaskAction}
            />
          ) : null}
          {/* 062：本地文件链接解析失败的反馈（无上下文弹窗，底部 toast 原位说明）。 */}
          {linkToast
            ? createPortal(
              <div className="h37-toast h37-toast-card" role="status" key={linkToast.id} data-tone="err">
                <CircleAlert aria-hidden="true" />
                <span>{linkToast.text}</span>
              </div>,
              document.body,
            )
            : null}
        </section>
      </div>
    </main>
  );
}

/**
 * 008 工作对象来源条：已附加对象的 chips（类型图标 + 标题 + 范围 + 采集时间，
 * 可刷新/移除）。范围文案由主进程给出（正文前 N 字 / 仅标题与链接 / 窗口/
 * 区域截图…），这里不加工——诚实范围是 R-02/R-03 的验收点。
 */
function ContextChips({
  objects,
  busy,
  onRefresh,
  onRemove,
}: {
  objects: WorkContextObjectView[];
  busy: boolean;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const kindIcon = (object: WorkContextObjectView) => {
    if (object.kind === 'web') return <Globe className="size-3.5" />;
    if (object.kind === 'image') return <ImageIcon className="size-3.5" />;
    return <FileText className="size-3.5" />;
  };

  return (
    <>
      {objects.map((object) => (
        <span
          key={object.id}
          className="context-chip"
          title={`${object.title}${object.detail ? `\n${object.detail}` : ''}\n${object.scope} · ${formatTime(object.capturedAt)} 采集`}
        >
          <span className="context-chip-icon">{kindIcon(object)}</span>
          <span className="context-chip-title">{object.title}</span>
          <span className="context-chip-scope">{object.scope}</span>
          <button
            type="button"
            className="context-chip-btn"
            onClick={() => onRefresh(object.id)}
            disabled={busy}
            aria-label={`刷新 ${object.title}`}
            title="重新采集"
          >
            <RotateCcw className="size-3" />
          </button>
          <button
            type="button"
            className="context-chip-btn"
            onClick={() => onRemove(object.id)}
            disabled={busy}
            aria-label={`移除 ${object.title}`}
            title="移除"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </>
  );
}

/** 008 附加入口——回形针 icon + 内联菜单（选中文件 / 截取窗口或区域）。
 *  采集出错与进行中状态都收在 icon 的悬浮提示里，不占版面。
 *  2026-10-06：迁移到统一 Menu 组件。 */
function ContextAttachButton({
  busy,
  error,
  onAttach
}: {
  busy: boolean
  error: string
  onAttach: (kind: WorkContextAttachKind) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const menuItems: Array<{
    kind: WorkContextAttachKind
    label: string
    hint: string
    icon: typeof Globe
  }> = [
    // 063：按用户裁决移除「截取窗口或区域」入口——系统截图仍可粘贴/拖入，
    // 桌面视觉工具按既有能力另走；此菜单只保留工作对象的文件入口。
    { kind: 'file', label: '选中文件', hint: '添加为工作对象，后续对话会继续携带，直到移除', icon: FileText },
  ]

  const hint = error || (busy ? '正在获取内容…' : '附加当前对象')

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="h37-tool"
        disabled={busy}
        aria-label={hint}
        aria-expanded={menuOpen}
        title={hint}
        onClick={() => setMenuOpen((prev) => !prev)}
      >
        <Plus aria-hidden="true" />
      </button>

      {menuOpen && (
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={triggerRef}
          placement="anchor-up"
          className="h37-attach-menu"
          autoFocusFirst={false}
        >
          {menuItems.map((item, index) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              className="h37-menu-item h37-attach-item"
              onClick={() => {
                setMenuOpen(false)
                onAttach(item.kind)
              }}
              tabIndex={-1}
              autoFocus={index === 0}
            >
              <span className="h37-attach-item-head">
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
              </span>
              <small className="h37-attach-item-hint">{item.hint}</small>
            </button>
          ))}
        </Menu>
      )}
    </div>
  )
}

/** 026 R-09：轻量同任务标识（任务名胶囊；查不到退通用词）。 */
function TaskRelation({ title }: { title?: string }) {
  return (
    <span className="h24-task-relation" title="属于这个任务">
      <Link2 className="size-3" aria-hidden="true" />
      {title?.trim() || '所属任务'}
    </span>
  );
}

/**
 * 026 R-09：同一任务的连续阶段简报收成一条进展时间线——每条一行、弱于正式
 * 回答；运行中最新一条高亮为「当前」。超过 STAGE_FOLD_AT 条只留最近几条，
 * 更早的折叠可展开。复制入口统一由回答末尾承载。
 */
function StageBriefsItem({
  items,
  showRelation,
  current,
  afterCard,
  continuation,
  lead,
  taskTitle,
}: {
  items: TranscriptItem[];
  showRelation: boolean;
  current: boolean;
  /** 紧跟自己的任务卡：收近间距，读作卡的下文。 */
  afterCard: boolean;
  continuation: boolean;
  lead: boolean;
  taskTitle?: string;
}) {
  const [expanded, setExpanded] = useTranscriptRowState<boolean>("stage-expanded", false);
  const shown = visibleStageCount(items.length, expanded);
  const hidden = items.length - shown;
  return (
      <article
        className="h24-hemi-message h24-stage-briefs"
        data-after-card={afterCard && !showRelation ? 'true' : undefined}
        data-continuation={continuation ? 'true' : undefined}
        data-lead={lead ? 'true' : undefined}
      >
        {showRelation ? <TaskRelation title={taskTitle} /> : null}
        {hidden > 0 || expanded ? (
          <button
            type="button"
            className="h24-stage-fold"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight aria-hidden="true" />
            {expanded ? '收起较早的进展' : `更早 ${hidden} 条进展`}
          </button>
        ) : null}
        <ol className="h24-stage-list" aria-label="任务进展">
          {items.slice(items.length - shown).map((item, index, list) => (
            <li
              key={item.id}
              className="h24-stage-item"
              data-current={current && index === list.length - 1 ? 'true' : undefined}
              title={new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
            >
              <Markdown text={item.text} />
            </li>
          ))}
        </ol>
      </article>
  );
}

/** 复制整轮正文，沿用剪贴板桥、成功图标和失败提示。 */
function ReplyCopyActions({ text }: { text: string }) {
  const { copy, toastNode } = useClipboardCopy();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <>
    <div className="h24-msg-actions h24-reply-actions">
      <button
        type="button"
        className="h24-msg-copy"
        aria-label={copied ? '已复制' : '复制完整回答'}
        title={copied ? '已复制' : '复制完整回答'}
        data-copied={copied ? 'true' : undefined}
        onClick={() => void copy(text).then(setCopied)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
    {toastNode}
  </>;
}

/**
 * 024 消息形态（设计稿 v4 定稿）：用户消息为右对齐气泡（无头像行，气泡下
 * 「编辑」与状态），Hemi 回复为绿底 H 方块头像 + 名字行 + 开放正文。
 * 编辑框原位替换气泡（右对齐同形）；「重新发送」＝回卷重跑（2026-10-10 仿
 * zcode 语义改版）：这条之后的内容整段撤下、从这条重新提问（lib/message-edit.ts）。
 */
/** 回复正文：Markdown＋末尾证据脚注弱化（050）；062 起可带本地文件链接处理。 */
function renderReplyText(text: string, { onLocalLink }: { onLocalLink?: (href: string) => void } = {}) {
  const { body, note } = splitEvidenceNote(text);
  return (
    <>
      <Markdown text={body} onLocalLink={onLocalLink} />
      {note ? <p className="h50-evidence-note">{note}</p> : null}
    </>
  );
}

/**
 * 050 R-15：续问依据行（模型按 system 路由规则写在回复末行）——拆出正文，
 * 按 12 号淡色常显；正文里没有这行时原样返回。
 */
function splitEvidenceNote(text: string): { body: string; note: string | null } {
  const raw = String(text ?? '');
  const match = raw.match(/\n?\s*(依据上面「[^」]+」的结果整理，未重新查询)\s*$/);
  if (!match) return { body: raw, note: null };
  return { body: raw.slice(0, match.index).trimEnd(), note: match[1] };
}

function ChatTurnItem({
  item,
  continuation = false,
  lead = false,
  showRelation = true,
  taskTitleOf,
  editing,
  busy,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  onPreviewAttachment,
  renderText,
  renderTask,
  onOpenDeliverable,
}: {
  item: TranscriptItem;
  /** 056：回复段里的 task 调用原地渲染子 agent 一行。 */
  renderTask?: (call: { id: string }) => ReactNode;
  /** 062 回复正文渲染（默认无链接态；带 onLocalLink 的版本由 VoiceScreen 注入）。 */
  renderText?: (text: string) => ReactNode;
  /** 062：交付文件入口点击 → 右侧预览。 */
  onOpenDeliverable?: (artifactId: string, name: string) => void;
  /** 连续 Hemi 消息的续条：不重复头像行（受理/简报/终态各自入流时合并）。 */
  continuation?: boolean;
  /** 037：一段 Hemi 输出的首条（data-lead）。 */
  lead?: boolean;
  /** 026 R-09：上一条已属同一任务（紧跟任务卡/同任务简报）时不重复挂标识。 */
  showRelation?: boolean;
  /** 026 R-09：按 taskId 取任务名（渲染轻量同任务标识；查不到退通用词）。 */
  taskTitleOf?: (taskId: string) => string | undefined;
  editing: boolean;
  busy: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onEditResend: (id: string, nextText: string) => void;
  /** 028：历史附件 chip 点击 → 预览宿主（与草稿附件同一入口）。 */
  onPreviewAttachment?: (conversationId: string, attachmentId: string) => void;
}) {
  const [editDraft, setEditDraft] = useTranscriptRowState<string>("edit-draft", item.text);
  // 进入编辑时以当前文本为底稿；消息文本被并发改写（罕见）时同步一次。
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (editing !== wasEditing.current) setEditDraft(item.text);
    wasEditing.current = editing;
  }, [editing, item.text, setEditDraft]);
  // 026 R-11：就近复制（用户/助手消息通用）——反馈短暂可见，不打断选中与编辑。
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // 2026-10-08：复制走主进程桥（页面剪贴板被权限闸门拦，此前复制是坏的），
  // 并补 toast 成/败反馈——只有图标变化不够醒，失败时更是完全无感。
  const { copy: copyViaToast, toastNode: copyToastNode } = useClipboardCopy();
  const copyMessage = async () => {
    const ok = await copyViaToast(item.text);
    setCopied(ok);
  };

  const editable = isEditableMessage(item) && !busy && !editing;

  // —— 用户消息：右对齐气泡（设计稿 user-message）——
  if (item.author === 'user') {
    return (
      <>
        <article className="h24-user-message">
        {editing ? (
          <div className="h24-edit-form">
            <textarea
              className="h24-edit-input"
              value={editDraft}
              rows={3}
              aria-label="编辑消息"
              spellCheck={false}
              onChange={(event) => setEditDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelEdit();
                }
              }}
            />
            <div className="h24-edit-footer">
              <span className="h24-edit-note">重新发送会把这条之后的内容撤掉，从这条重新开始。</span>
              <div className="h24-edit-actions">
                <button type="button" className="h24-edit-cancel" onClick={onCancelEdit}>
                  取消
                </button>
                <button
                  type="button"
                  className="h24-resend-btn"
                  disabled={!editDraft.trim()}
                  onClick={() => onEditResend(item.id, editDraft)}
                >
                  重新发送
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 063：行内标签（技能＋四类引用）随正文原位回显；旧三类引用芯片在下方。 */}
            <p className="h24-user-bubble">
              {segmentTaggedText(item.text, { skills: item.skills ?? [], references: item.references ?? [] }).map((segment, index) =>
                segment.type === 'text' ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <span
                    key={index}
                    className="composer-inline-tag h63-msg-tag"
                    data-kind={segment.type === 'skill' ? 'skill' : segment.reference.kind}
                    title={segment.type === 'skill'
                      ? `技能 · ${segment.skill.name}${segment.skill.source === 'project' ? ' · 项目技能' : ' · 技能库'}`
                      : segment.reference.subtitle}
                  >
                    {segment.text}
                  </span>
                ),
              )}
            </p>
            {/* 028 R-04：历史回看能分清本条消息实际携带的附件（点击进预览宿主）。 */}
            {item.references?.length ? (
              <div className="h24-msg-attachments" aria-label="本条消息的引用">
                {item.references.map((reference) => (
                  <span key={reference.key} className="h24-msg-attachment" title={`${reference.name} · ${reference.subtitle}`}>
                    <Link2 className="size-3" aria-hidden="true" />
                    <span>{reference.name}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {item.attachments?.length ? (
              <div className="h24-msg-attachments" aria-label="本条消息的附件">
                {item.attachments.map((attachment) => {
                  // 图片附件带缩略图（与输入框托盘同形态）：小图点击进预览。
                  const thumb =
                    attachment.kind === 'image' && attachment.thumbnailUrl && attachment.status !== 'failed'
                      ? attachment.thumbnailUrl
                      : null;
                  return (
                    <button
                      key={attachment.attachmentId}
                      type="button"
                      className={`h24-msg-attachment${thumb ? ' h24-msg-attachment-image' : ''}`}
                      title={attachment.originPath || attachment.name}
                      aria-label={thumb ? `预览图片附件 ${attachment.name}` : undefined}
                      onClick={
                        onPreviewAttachment
                          ? () => onPreviewAttachment(attachment.conversationId, attachment.attachmentId)
                          : undefined
                      }
                    >
                      {thumb ? (
                        <img
                          className="h24-attach-thumb"
                          src={thumb}
                          alt={attachment.name}
                          draggable={false}
                        />
                      ) : (
                        <>
                          {attachment.kind === 'image' ? (
                            <ImageIcon className="size-3" aria-hidden="true" />
                          ) : (
                            <FileText className="size-3" aria-hidden="true" />
                          )}
                          <span>{attachment.name}</span>
                          {attachment.status === 'failed' ? <small>原文件不可用</small> : null}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="h24-user-actions">
              {/* 037 细节：复制 / 编辑统一为 24px 图标钮（悬停出现，title 提示）；已复制换勾。 */}
              <button
                type="button"
                className="h24-msg-copy"
                aria-label={copied ? '已复制' : '复制这条消息'}
                title={copied ? '已复制' : '复制'}
                data-copied={copied ? 'true' : undefined}
                onClick={() => void copyMessage()}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </button>
              {item.queuedForSend ? <span className="h24-user-status is-pending">排队中</span> : null}
              {item.editedAt ? <span className="h24-user-status">已编辑</span> : null}
              {item.withdrawn ? <span className="h24-user-status">已撤回，未发送</span> : null}
              {editable ? (
                <button
                  type="button"
                  className="h24-edit-btn"
                  aria-label="编辑这条消息"
                  title="编辑"
                  onClick={() => onStartEdit(item.id)}
                >
                  <Pencil aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </>
        )}
      </article>
      {copyToastNode}
    </>
    );
  }

  // —— Hemi 回复：开放式正文（026 R-02：无头像/名标行；连续回复天然连排）。
  // 026 R-09：带 taskId 的阶段简报/终态交代挂轻量同任务标识，并发与回看不串台。
  // 2026-10-07 会话审计：kind='error'＝回合失败留痕——正文是失败原因，弱化着色、
  // 不带复制操作（不是 Hemi 说的话）。
  if (item.kind === 'error') {
    return (
      <article
        className="h24-hemi-message"
        data-error="true"
        data-continuation={continuation ? 'true' : undefined}
        data-lead={lead ? 'true' : undefined}
      >
        <span className="h24-reply-failed" role="status">
          这轮没答上来
        </span>
        <div className="chat-copy assistant-copy">
          <Markdown text={item.text} />
        </div>
      </article>
    );
  }
  return (
    <>
      <article
        className="h24-hemi-message"
        data-continuation={continuation ? 'true' : undefined}
        data-lead={lead ? 'true' : undefined}
      >
      {item.taskId && showRelation ? <TaskRelation title={taskTitleOf?.(item.taskId)} /> : null}
      {/* 029 R-02：被用户停止的未完成回复——增量原位保留，明确标注，不伪装成失败。 */}
      {item.replyStatus === 'stopped' ? (
        <span className="h24-reply-stopped" role="status">
          未完成 · 已停止
        </span>
      ) : null}
      {item.live && !item.parts?.length && !item.text ? <WaitingStatus /> : null}
      {item.live && item.text && !item.parts?.some((part) => part.type !== 'text') ? <span className="h24-reply-status" role="status">回应中</span> : null}
      {/* 056：有按序的段（思考／正文／工具组）就照接口返回的先后从上往下排；旧档走 048 形态。 */}
      {item.parts?.length ? (
        <TurnParts
          parts={item.parts}
          live={item.live}
          renderText={renderText ?? ((text: string) => renderReplyText(text))}
          renderTask={renderTask}
          onOpenDeliverable={onOpenDeliverable}
        />
      ) : (
        <>
          {/* 048：思考折叠头（档案回看可展开；中断轮显示「思考已中断」）。 */}
          {item.thinking ? (
            <ThinkingBlock
              state={item.thinking.interrupted ? 'interrupted' : 'done'}
              text={item.thinking.text}
              durationMs={item.thinking.durationMs}
            />
          ) : null}
          {item.text.trim() ? (
            <div className="chat-copy assistant-copy">{(renderText ?? renderReplyText)(item.text)}</div>
          ) : null}
        </>
      )}
      </article>
      {copyToastNode}
    </>
  );
}

/**
 * 005 → 056：对话流里的任务条目。2026-10-15 用户裁决「遵守主流对话流样式」——任务一律
 * 显示成一行（Claude Code 的 Task 块，见 compact-delegation），不再出任务卡。
 * 055 及以前没有角色的旧任务：结果正文、成果与文件改动当年只在卡里交代（对话流的
 * task-result 气泡被 050 R-20 去重隐藏），回看时在这一行下方原样展示结果区。056 子 agent
 * 的报告由主 agent 验收转述，不在这里重复。活跃任务用实时快照，终态后用冻结快照。
 */
function TaskTranscriptItem({
  item,
  taskSnaps,
  nowTick,
  onTaskAction,
  onOpenProcess,
  onOpenArtifact,
  onOpenPreview,
  onOpenReportPreview,
}: {
  item: TranscriptItem;
  taskSnaps?: Record<string, TaskStateSnapshot>;
  nowTick?: number;
  onTaskAction: (action: TaskActionName, payload?: { choice?: TaskPermissionChoice; taskId?: string; taskKey?: string }) => void;
  /** 025 v3：打开/收起该任务的过程抽屉。 */
  onOpenProcess?: (snap: TaskStateSnapshot) => void;
  onOpenArtifact?: (taskId: string, artifactId: string, intent: 'open' | 'reveal') => void;
  /** 026 R-05：可预览文件的应用内阅读。 */
  onOpenPreview?: (taskId: string, artifactId: string) => void;
  /** 027 R-04：结果正文进右侧阅读区。 */
  onOpenReportPreview?: (snap: TaskStateSnapshot) => void;
}) {
  // 卡身份：taskId 优先（2026-09-23 唯一标识收敛）。冻结项（taskFrozen）的
  // 快照表里可能已被活卡覆盖——冻结项一律用自己内嵌的 taskSnap（并入瞬间状态）。
  const snapKey =
    item.taskId ?? item.taskSnap?.taskId ?? item.taskKey ?? item.taskSnap?.key ?? (item.taskSeq != null ? `s${item.taskSeq}` : null);
  const snap = item.taskFrozen
    ? item.taskSnap ?? undefined
    : (snapKey ? taskSnaps?.[snapKey] : undefined) ?? item.taskSnap ?? undefined;
  if (!snap) return null;
  const legacyResult = !snap.agent && snap.phase === 'terminal' && !snap.verifying
    && Boolean(snap.resultText?.trim() || snap.artifacts?.length || snap.fileChanges?.files?.length);
  const taskId = snap.taskId ?? '';
  return (
    <>
      <CompactDelegation
        snap={snap}
        nowTick={nowTick}
        onAction={item.taskFrozen ? undefined : onTaskAction}
        onOpenProcess={onOpenProcess ? () => onOpenProcess(snap) : undefined}
      />
      {legacyResult ? (
        <div className="h56-delegation-result">
          <TaskResultBlock
            snap={snap}
            frozen={Boolean(item.taskFrozen)}
            onOpenBodyWide={onOpenReportPreview ? () => onOpenReportPreview(snap) : undefined}
            onOpenArtifact={onOpenArtifact ? (artifactId, intent) => onOpenArtifact(taskId, artifactId, intent) : undefined}
            onOpenPreview={onOpenPreview ? (artifactId) => onOpenPreview(taskId, artifactId) : undefined}
          />
        </div>
      ) : null}
    </>
  );
}
