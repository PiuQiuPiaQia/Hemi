import {useConversationBridge,useConversationEnvironment,useConversationEnvironmentId} from './lib/conversation-bridge';
import { DesktopConversationFlow } from './conversation-flow';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AttachmentCard } from './attachment-card';
import { RunActivity } from './run-activity';
import { TurnErrorNotice } from './turn-error-notice';
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
import { PreviewResizer, loadPreviewWidth } from '@/windows/voice/preview-resizer'
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
import { ScopePopover } from '@/windows/voice/scope-popover';
import { ThinkingLevelStrip } from '@/windows/voice/thinking-level-strip';
import { ConversationSidebar } from '@/windows/voice/sidebar';
import { NavRail } from '@/windows/voice/nav-rail';
import { useConversationNav } from './lib/use-conversation-nav';
import {SkinWelcomeAvatar} from '@/components/skin-watermark';
import {useThemeScene} from '@/appearance/scene';
import { SKILLS_TOPBAR_SLOT_ID, SkillMarket } from '@/windows/voice/skill-market';
import { WorkflowStudio } from '@/windows/voice/workflow-studio';
import { TextComposer } from '@/windows/voice/text-composer';
import { SessionUsage } from '@/windows/voice/session-usage-view';
import type { ConversationDeliverableView, UsageRecord } from '@shared/protocol';
import { DeliverableContext } from './deliverable-card';
import { ModelSelectorChip } from '@/windows/voice/model-selector';
import { WorkspaceBar, type WorkspaceBarValue } from '@/windows/voice/workspace-bar';
import { TopbarOpenWorkspace } from '@/windows/voice/topbar-open-workspace';
import { TurnQueueTray } from '@/windows/voice/turn-queue-tray';
import { markdownPlainText } from '@/shared/markdown-plain-text';

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

type VoiceScreenProps = {
  /** Host-specific controls occupy existing conversation slots. */
  topBarActions?: import('react').ReactNode;
  workspaceControl?: import('react').ReactNode;
  scopeControl?: import('react').ReactNode;
  composerBanner?: import('react').ReactNode;

  sessionState: SessionState;
  /** True when the session is a call, i.e. it keeps listening without holding. */
  callActive: boolean;
  /** 对话回合状态（模型那一侧）：thinking / replying / error 改变状态文案。 */
  turnPhase: TurnPhase;
  /** 本回合起点（仅在 thinking/replying 时非空）：回合中途出生的任务卡排到
   * 流式元素之后——「先思考、后派手」的时间线在画面上成立（2026-10-14 用户
   * 裁决）；回合收口后传 null，卡回原位、交代照常排其后。 */
  turnStartedAt: number | null;
  runActivity?: import('@shared/protocol').RunActivityView | null;
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
  retryTurnBusy?: boolean;
  retryTurnBlocked?: string;
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
  /** 语音识别服务已配置；控制语音输入与通话入口的显示。 */
  voiceModelReady: boolean;
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
  topBarActions, workspaceControl, scopeControl, composerBanner,
  sessionState,
  callActive,
  turnPhase,
  turnStartedAt,
  runActivity,
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
  retryTurnBusy = false,
  retryTurnBlocked,
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
  voiceModelReady,
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
  const bridge = useConversationBridge();
  const environmentId = useConversationEnvironmentId();
  const botEnvironment = useConversationEnvironment() === 'bot';
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
  // 窄窗：对话图标悬浮预览列表；点击图标或顶栏菜单可保持展开。
  const navPage = skillMarketOpen ? 'skills' : workflowStudioOpen ? 'workflows' : 'home';
  const conversationNav = useConversationNav(navPage);
  const navOpen = conversationNav.open;
  const [workspaceAlertSlot, setWorkspaceAlertSlot] = useState<HTMLDivElement | null>(null);
  /** 空态示例任务填入后把焦点交回输入框（与外部的 composerFocusToken 相加，任一变化即聚焦）。 */
  const [suggestionFocus, setSuggestionFocus] = useState(0);
  // 空态＝本会话既无落盘消息、也无任何在途内容。只看 transcripts 时，新对话里
  // 一开口识别气泡就画进对话流顶部，空态引导与居中输入框却还在——气泡孤零零
  // 飘在右上角（2026-10-09 用户实测「识别结果跑偏」）。在途内容一出现即收起空态。
  const conversationEmpty =
    !conversationLoading && !transcripts.length && !interimText && !streamingReply && !streamingThinking && turnPhase !== 'thinking';
  useThemeScene(skillMarketOpen||workflowStudioOpen?'other':conversationEmpty?'home':'reading',Boolean(textDraft.trim())||callActive);
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

  // 预览面板宽度：从 localStorage 恢复，拖动时实时更新
  const [previewWidth, setPreviewWidth] = useState(() => loadPreviewWidth());

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
  const flowTaskSnaps = useMemo(() => {
    const frozen = Object.fromEntries(transcripts.flatMap(item => item.taskSnap ? [[item.taskSnap.taskId ?? item.taskSnap.key ?? item.id, item.taskSnap]] : []));
    return { ...frozen, ...taskSnaps };
  }, [transcripts, taskSnaps]);
  const latestError = transcripts.at(-1)?.kind === 'error' ? transcripts.at(-1) : null;

  /** 060 S2（R-07/R-09）：统一有序渲染——已删除「回合中途任务卡沉底、用户插话提上、
   *  收口后恢复原位」的按作者/出生时间重分区（该规则会让运行中与完成后顺序不一致）。
   *  历史条目一律按 timeline 原序渲染；流式块只作为「当前回合的最新尾部」追加在
   *  末尾（收口投影后由顺序门槛接续，不换位）。 */

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
      void bridge
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
  // Model failures live at their timeline position, including after a restart.
  // Keep the composer notice for speech/pre-dispatch failures only.
  const isError = sessionState === 'error' || (turnPhase === 'error' && !latestError && !textModelBusy);
  const errorCopy = sessionState === 'error'
    ? errorMessage || '语音服务中断了，可以稍后再试'
    : turnError || '这次没接上，再试一次';

  // 017 R-08：并行任务各自可能等确认——确认卡一次只出一张（最早等待的
  // 先出），其余收成一行「在等」提示（只报名字，各自独立倒计时）。

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

  // Local conversations always expose their actual directory, including default and legacy chats.
  const openWorkspaceView =
    !skillMarketOpen &&
    !workflowStudioOpen &&
    workspaceCurrent?.kind === 'view' && !workspaceCurrent.view.host
      ? workspaceCurrent.view
      : !skillMarketOpen && !workflowStudioOpen && workspaceCurrent?.kind === 'legacy'
        ? { id: 'legacy-home', type: 'default' as const, name: '家目录', dir: '', status: 'ok' as const }
        : null;

  // 037：⌘N 新建对话（侧栏按钮上的快捷键提示）。
  const newConversationRef = useRef<() => void>(() => {});
  newConversationRef.current = () => {
    onNewConversation();
    onCloseSkillMarket?.();
    conversationNav.close();
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
    <DeliverableContext.Provider value={{ conversationId: currentConversationId, onOpen: openDeliverablePreview, onOpenLink: openLocalFileLink }}>
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
              onClick={conversationNav.toggle}
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
          topBarActions ?? (workflowStudioOpen ? <div id="h59-editor-actions-slot" /> : (
            <>
              {!voiceModelReady || (callActive && !dockCollapsed) ? null : (
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
          ))
        }
      />

      {/* 034 v3：图标栏（页面导航）＋工作区并列；技能中心打开时工作区单列
          铺满（CSS 挂在 data-market-open 上），对话列表只在首页页面内出现。 */}
      <div className="h24-frame">
        <NavRail
          page={navPage}
          homePreviewProps={conversationNav.triggerProps}
          onShowHome={() => {
            if (navPage === 'home' && conversationNav.collapsed) conversationNav.toggle();
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
          data-nav-preview={conversationNav.previewOnly ? 'true' : undefined}
          data-preview-open={
            !skillMarketOpen && previewOpen && previewTabs.tabs.length ? 'true' : 'false'
          }
          style={{
            '--h24-preview-w': `${previewWidth}px`,
          } as React.CSSProperties}
        >
          {/* 抽屉打开时的遮罩（窄窗）；常驻侧栏布局下不渲染命中。 */}
          <button
            type="button"
            className="h24-backdrop"
            aria-label="关闭导航"
            tabIndex={-1}
            onClick={conversationNav.close}
          />
          {!workflowStudioOpen ? <ConversationSidebar
            interactionProps={conversationNav.sidebarProps}
            onHistoryOpen={conversationNav.close}
            currentConversationId={currentConversationId}
            conversationVisible={!skillMarketOpen}
            onNewConversation={() => {
              onNewConversation();
              onCloseSkillMarket?.();
              conversationNav.close();
            }}
            onOpenConversation={(id) => {
              onOpenConversation(id);
              onCloseSkillMarket?.();
              conversationNav.close();
            }}
            onConversationRemoved={onConversationRemoved}
            onConversationRenamed={onConversationRenamed}
          /> : null}

          {skillMarketOpen ? <SkillMarket onBack={() => onCloseSkillMarket?.()} pendingApproval={waitingTasks.length > 0} demo={skillMarketScene} /> : null}

          {/* 059：工作流页（与技能中心平级）；main 区在两页打开时都隐藏。 */}
          {workflowStudioOpen ? (
            <WorkflowStudio
              onNavigate={conversationNav.close}
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
            <DesktopConversationFlow
              environmentId={environmentId}
              conversationId={currentConversationId} generation={timelineGeneration ?? 0}
              messages={visibleTranscripts} taskSnaps={flowTaskSnaps} waitingTasks={waitingTasks}
              loading={conversationLoading} notice={timelineNotice} interimText={interimText}
              busy={textModelBusy} retryBusy={retryTurnBusy} retryBlocked={retryTurnBlocked}
              editingMessageId={editingMessageId} models={modelProfiles}
              active={!skillMarketOpen && !workflowStudioOpen}
              onTaskAction={onTaskAction} onStartEdit={onStartEditMessage} onCancelEdit={onCancelEditMessage}
              onEdit={onEditResendMessage} onRetry={onRetryTurn} onOpenProcess={openProcessTab}
              onOpenLink={openLocalFileLink} onModelSettings={onOpenAutoRoutingSettings}
              onPreview={target => {
                if (target.kind === 'attachment' && currentConversationId) openAttachmentPreview(currentConversationId, target.id);
                else if (target.kind === 'artifact' && target.taskId) {
                  if (target.intent === 'open' || target.intent === 'reveal') onOpenArtifact?.(target.taskId, target.id, target.intent);
                  else openPreviewTab({ kind: 'artifact', taskId: target.taskId, artifactId: target.id || null });
                } else openDeliverablePreview(target.id);
              }}
            />

            {/* 037：记忆提示（「记住了：…」/「已忘记：…」+ 查看 / 撤销），每条自带 role=status。 */}
            {composerBanner}
            {typeof memoryNotice === 'string' && memoryNotice ? (
              <p className="h24-memory-notice" data-legacy="true" role="status">
                {memoryNotice}
              </p>
            ) : memoryNotice ? (
              <div className="h24-memory-notice">{memoryNotice}</div>
            ) : null}

            {isError ? (
              <div className="h24-turn-error">
                <TurnErrorNotice message={errorCopy} speech={sessionState === 'error'} />
              </div>
            ) : null}

            {/* 空态引导只看本会话有没有内容（005 起任务卡进对话流，全局守卫会误杀）。
                P1：引导与输入框成组居中（上方滚动区与下方 spacer 平分余量），首条消息后
                spacer 收起、输入框沉到底部。 */}
            {conversationEmpty ? (
              <div className="h24-empty" aria-label="功能引导">
                <span className="h37-orb" data-live="true" style={{ '--orb': '40px' } as CSSProperties} aria-hidden="true"><SkinWelcomeAvatar /></span>
                <p className="h24-empty-greeting">今天想做什么？</p>
                <p className="h24-empty-hint">{botEnvironment?'交给 Hemi 一件事，文件与命令在云服务器上运行。':'直接说，或交给 Hemi 一件事——语音、文字都行。'}</p>
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
              <RunActivity key={currentConversationId} active={!skillMarketOpen && !workflowStudioOpen} activity={runActivity} />
              <TextComposer
                value={textDraft}
                onChange={onTextDraftChange}
                onSend={onTextSend}
                queueEditing={queueEditing}
                queueEditSaving={queueEditSaving}
                onCancelQueueEdit={onCancelQueueEdit}
                busy={textModelBusy}
                waiting={Boolean(runActivity?.phase.startsWith('waiting-'))}
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
                      waiting={runActivity?.phase === 'waiting-background' ? 'background' : runActivity?.phase === 'waiting-resource' ? 'resource' : null}
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
                    {voiceModelReady && isMacPlatform ? (
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
                    <AttachmentAddButton busy={contextBusy} error={contextError} onAttach={onAttachContext} />
                    <span className="h37-tool-sep" aria-hidden="true" />
                    {/* 033：工作区——发送前可见当前任务在哪个目录工作（v2 默认优先）。 */}
                    {workspaceControl ?? <WorkspaceBar
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
                    />}
                    {/* 033：思考强度拨盘（设置页「正在使用」同源）。041：全局一档，自动路由下也可改。 */}
                    <ThinkingLevelStrip
                      level={thinkingLevel}
                      onChange={(level) => onThinkingLevelChange?.(level)}
                    />
                    {/* 042：访问范围浮层（盾牌只读入口，替换 005 三档拨盘）；
                        只列持续授权＋进行中任务的本任务授权，「管理」直达设置访问授权区。 */}
                    {scopeControl ?? <ScopePopover
                      activeTaskIds={activeTaskIds}
                      onManage={onOpenAccessSettings ?? onOpenSettings}
                    />}
                  </>
                }
              />
              {/* 048：居中用量预览，悬浮或键盘聚焦展开。 */}
              <SessionUsage records={usageRecords} running={usageRunning} />
              {conversationEmpty ? (
                <div className="h24-suggestions" aria-label="可以这样开始">
                  {(botEnvironment?[{icon:FolderInput,text:'查看当前目录的项目结构'},{icon:CloudSun,text:'检查服务器的磁盘使用情况'},{icon:Table2,text:'整理项目说明文档'}]:EMPTY_SUGGESTIONS).map(({ icon: Icon, text }) => (
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
            <>
              <PreviewResizer
                width={previewWidth}
                onWidthChange={setPreviewWidth}
                sidebarWidth={224}
                mainMinWidth={540}
                marketOpen={skillMarketOpen}
              />
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
            </>
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
    </DeliverableContext.Provider>
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

/** The picker, drop and paste paths all add message attachments. */
function AttachmentAddButton({
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
    { kind: 'file', label: '选中文件', hint: '图片、PDF、Word、Excel、PPT，添加到本条消息', icon: FileText },
  ]

  const hint = error || (busy ? '正在添加附件…' : '添加附件')

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
