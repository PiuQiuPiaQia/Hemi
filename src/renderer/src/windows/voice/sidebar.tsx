import {EmptyState, ErrorState} from '@hemi/ui';
import {ConversationList, ConversationRow} from '@hemi/conversation-flow/navigation';
import {useConversationBridge} from './lib/conversation-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import {SkinWatermark} from '@/components/skin-watermark';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';

import type { ConversationSummary } from '@/shared/types';
import { useConversationList } from './lib/use-conversation-list';
import { ConversationContextMenu } from '@/windows/voice/conversation-context-menu';
import { ConversationHistoryDialog } from '@/windows/voice/conversation-history-dialog';
import { newConversationShortcut } from '@/windows/voice/lib/platform-format';
import {
  displayTitle,
  groupByRecency,
  pickRecent,
  reorderWithinGroup,
} from '@/windows/voice/lib/conversation-format';

/**
 * 024 全页面重构：对话优先布局的左侧导航——新建对话、最近会话、设置。
 * 最近列表直接读 conversation IPC（与历史弹窗同源）；「查看全部」仍走
 * 历史弹窗（删除的两步确认在那边，侧栏行不提供删除——2026-10-07 起
 * 右键菜单也可删，两步确认改在菜单内完成，与弹窗同口径）。窄窗口下由壳层
 * 收进抽屉。
 *
 * 2026-09-26：行内增强——双击重命名（原位输入，空标题回退派生标题）与
 * 拖拽排序（@dnd-kit，顺序全量落 order-index.json：未排过的会话按时间在
 * 前，手动排过的稳定在后）。损坏行不参与排序与重命名。
 * 026 R-12（2026-09-27 用户裁决）：会话行不展示重命名/拖拽按钮——双击标题
 * 原位重命名，整行拖动排序（指针 4px 起动距离不影响单击；键盘经行焦点
 * 空格+方向键拖动，无可见控件）。编辑输入框不嵌在按钮里。
 * 2026-10-05：行右键弹菜单（复制会话 ID / 重命名），重命名复用双击的
 * 原位编辑；损坏行菜单里重命名置灰、复制 ID 仍可用。2026-10-07：菜单加
 * 删除（危险项两步确认，与历史弹窗同口径）；损坏行删除照常可用——它是
 * 清掉损坏档案文件的唯一界面途径。
 *
 * 034 v3（2026-10-02 用户裁决）：应用级入口（技能市场、设置、悬浮球）全部
 * 移出侧栏——技能中心/设置进左侧图标栏（nav-rail），悬浮球开关挪设置页；
 * 本组件只剩首页页面内的对话列表面板。
 *
 * P1（2026-10-08 用户裁决「可以分组，也可以拖拽」）：最近会话按更新时间分
 * 「今天 / 昨天 / 7 天内 / 更早」；每组一个独立 DndContext，只能组内拖动，
 * 落盘时组员按新序填回它们在全量手动序里的原位（组外会话不动）。
 */

/** 侧栏列出的会话条数（P2：对标 Codex 列全量、可滚动；与存储上限 MAX_SESSIONS 同值）。
 *  「查看全部」弹窗仍是搜索与批量删除的入口。 */
const RECENT_LIMIT = 50;

export function ConversationSidebar({
  currentConversationId,
  conversationVisible = true,
  onNewConversation,
  onOpenConversation,
  onConversationRemoved,
  onConversationRenamed,
  onHistoryOpen,
  interactionProps,
}: {
  /** 当前会话 id（null＝未落盘新会话）；命中项高亮并在切换后触发列表刷新。 */
  currentConversationId: string | null;
  conversationVisible?: boolean;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onConversationRemoved: (id: string) => void;
  /** 024：重命名落盘后上抛（当前会话改名时顶栏标题跟着换）。 */
  onConversationRenamed?: (id: string, title: string) => void;
  onHistoryOpen?: () => void;
  interactionProps?: Pick<ComponentProps<'aside'>, 'id' | 'onPointerEnter' | 'onPointerLeave' | 'onFocusCapture' | 'onBlurCapture'>;
}) {
  const bridge = useConversationBridge();
  const { list, setList, error, setError, loadList, setPinned } = useConversationList(true, conversationVisible ? currentConversationId : null);
  /** 行内重命名：editingId 命中的行渲染输入框。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 037 动效：列表里新出现的会话行闪一次浅绿（首载不算）。 */
  const knownIdsRef = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const ids = list.sessions.map((session) => session.id);
    const known = knownIdsRef.current;
    if (!known && !ids.length) return; // 首次读取前的空表不算基线
    knownIdsRef.current = new Set(ids);
    if (!known) return;
    const fresh = ids.filter((id) => !known.has(id));
    if (!fresh.length) return;
    setFreshIds(new Set(fresh));
    const timer = window.setTimeout(() => setFreshIds(new Set()), 1600);
    return () => window.clearTimeout(timer);
  }, [list.sessions]);

  // 刷新时机：挂载、会话切换（新会话首次发言定 id 后标题会变）、窗口重新
  // 聚焦、档案变更广播。前两项单独不够：新会话 id 定格触发的刷新跑在 800ms
  // 防抖落盘之前，语音场景窗口又不失焦——广播补上落盘后的那一环
  // （2026-10-07 新会话不进侧栏的根因）。
  useEffect(() => {
    void loadList();
  }, [loadList, currentConversationId]);

  const commitRename = useCallback(
    async (id: string, title: string) => {
      setEditingId(null);
      try {
        const result = await bridge?.renameConversation?.(id, title);
        if (result?.ok) onConversationRenamed?.(id, result.session.title);
      } catch {
        // 落盘失败：列表重载即回到旧标题，不打断用户
      }
      await loadList();
    },
    [loadList, onConversationRenamed],
  );

  // 2026-10-07：右键菜单删除（两步确认在菜单里）。主进程删完会广播
  // conversation:changed 触发 loadList，这里显式重读一次兜底；删的是当前
  // 会话时上抛 onConversationRemoved 由页面解除绑定并清对话流。
  const commitDelete = useCallback(
    async (id: string) => {
      try {
        await bridge?.removeConversation(id);
        onConversationRemoved(id);
        setError('');
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : '删除失败');
      }
      await loadList();
    },
    [loadList, onConversationRemoved],
  );

  const handleDragEnd = useCallback(
    (groupIds: string[], event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const nextIds = reorderWithinGroup(
        list.sessions.map((session) => session.id),
        groupIds,
        String(active.id),
        String(over.id),
      );
      if (!nextIds) return;
      const byId = new Map(list.sessions.map((session) => [session.id, session]));
      const next = nextIds.map((id) => byId.get(id)!);
      setList((prev) => ({ ...prev, sessions: next })); // 乐观更新，落盘失败靠 focus 刷新兜底
      void bridge?.reorderConversations?.(nextIds);
    },
    [list.sessions],
  );

  // 拖拽有 4px 起动距离：单击开对话、双击进重命名都不受影响。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const recents = pickRecent(list.sessions, RECENT_LIMIT);
  const groups = groupByRecency(recents);
  const notice = error || list.storageError;
  // 043：快捷键提示平台化（mac ⌘N / Windows Ctrl+N），键盘处理语义不变。
  const platform = bridge?.platform ?? 'darwin';
  const newShortcut = newConversationShortcut(platform);

  const historyTrigger = (
    <ConversationHistoryDialog
      onOpen={onOpenConversation}
      onRemoved={onConversationRemoved}
      onRenamed={(id, title) => {
        onConversationRenamed?.(id, title);
        void loadList(); // 弹窗里改的名同步回侧栏列表，不等聚焦刷新
      }}
      triggerLabel="查看全部"
      onShow={onHistoryOpen}
    />
  );

  return (
    <aside className="h24-sidebar" aria-label="主导航" {...interactionProps}>
      <SkinWatermark />
      <button
        type="button"
        className="h24-sidebar-new"
        onClick={onNewConversation}
        aria-label="新建对话"
        aria-keyshortcuts={newShortcut.ariaKeyshortcuts}
      >
        <Plus className="size-4" aria-hidden="true" />
        <span>新建对话</span>
        <kbd aria-hidden="true">{newShortcut.label}</kbd>
      </button>

      {/* 「查看全部」挂在第一个分组标题右侧；没有会话或读档出错时退回「最近对话」标题。 */}
      {notice || !groups.length ? (
        <>
          <SidebarHeading label="最近对话" history={historyTrigger} />
          {notice ? <ErrorState className="h24-sidebar-note" role="status" description={notice}/> : <EmptyState className="h24-sidebar-note" description="还没有存下的会话。聊过几句后自动保存。"/>}
        </>
      ) : (
        <ConversationList as="nav" className="h24-sidebar-nav" label="最近会话" groupClassName="h24-sidebar-group" groups={groups.map(group=>({key:group.key,label:group.label,items:group.sessions}))}
          renderHeading={(group,index)=><SidebarHeading label={group.label} history={index===0?historyTrigger:null}/>}
          wrapGroupItems={(group,rows)=>{
            const groupIds=group.items.filter(session=>!session.corrupt).map(session=>session.id);
            return <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={event=>handleDragEnd(groupIds,event)}><SortableContext items={groupIds} strategy={verticalListSortingStrategy}>{rows}</SortableContext></DndContext>;
          }}
          renderItem={session=><SidebarRow session={session} current={session.id===currentConversationId} fresh={freshIds.has(session.id)} editing={editingId===session.id} draft={draft} onDraftChange={setDraft}
            onStartEdit={()=>{setEditingId(session.id);setDraft(displayTitle(session.title));}}
            onCancelEdit={()=>setEditingId(null)} onCommitEdit={title=>void commitRename(session.id,title)} onRemove={()=>void commitDelete(session.id)} onTogglePin={()=>void setPinned(session.id,!session.pinned)} onOpen={()=>{if(!session.corrupt)onOpenConversation(session.id);}}/>}
        />
      )}
    </aside>
  );
}

function SidebarHeading({ label, history }: { label: string; history: React.ReactNode }) {
  return (
    <div className="h24-sidebar-heading">
      <span>{label}</span>
      {history}
    </div>
  );
}

/** 单条最近会话行（026 R-12）：打开/重命名/拖动三个独立控件；损坏行只读。 */
function SidebarRow({
  session,
  current,
  fresh,
  editing,
  draft,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onRemove,
  onTogglePin,
  onOpen,
}: {
  session: ConversationSummary;
  current: boolean;
  fresh: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (next: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommitEdit: (title: string) => void;
  /** 右键菜单确认删除后回调（两步确认在菜单里完成）。 */
  onRemove: () => void;
  onTogglePin: () => void;
  onOpen: () => void;
}) {
  const sortable = useSortable({ id: session.id, disabled: Boolean(session.corrupt) || editing });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  /** 右键菜单落点（null＝收起）；dnd PointerSensor 只认主键，右键不会误触拖拽。 */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);


  const corrupt = Boolean(session.corrupt);

  return (
    // 026 R-12（用户裁决）：行是容器 div，无可见重命名/拖拽控件——单击打开、
    // 双击重命名、整行拖动（监听挂行容器，指针 4px 起动距离保住单击；
    // 键盘经行焦点空格+方向键排序）。编辑输入框不嵌在按钮里。
    <div
      ref={setNodeRef}
      className="h24-sidebar-item"
      data-current={current ? 'true' : 'false'}
      data-dragging={isDragging ? 'true' : undefined}
      data-fresh={fresh ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      data-corrupt={corrupt ? 'true' : undefined}
      style={transform ? { transform: CSS.Transform.toString(transform), transition } : undefined}
      onContextMenu={(event) => {
        // 编辑输入框里保留系统右键（复制/粘贴），只在行上弹自定义菜单
        if (editing) return;
        event.preventDefault();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
      {...(corrupt || editing ? {} : attributes)}
      {...(corrupt || editing ? {} : listeners)}
    >
      <ConversationRow item={session} current={current} onOpen={onOpen} editing={editing} draft={draft} onDraftChange={onDraftChange} onCancelEdit={onCancelEdit} onCommitEdit={onCommitEdit} onStartEdit={onStartEdit}/>

      <ConversationContextMenu
        session={session}
        point={menuAt}
        onRename={onStartEdit}
        onDelete={onRemove}
        onTogglePin={onTogglePin}
        onClose={() => setMenuAt(null)}
      />
    </div>
  );
}
