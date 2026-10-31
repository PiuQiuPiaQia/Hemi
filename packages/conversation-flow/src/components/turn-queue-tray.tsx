import type { MessageReferenceView } from '../types/presentation.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, Clock3, GripVertical, Pencil, Play, X } from 'lucide-react';
import type { TurnQueueItemView, TurnQueueState } from '../core/protocol.js';
import { segmentTaggedText } from '../presentation/composer-tokens.js';

type QueueActions = {
  onWithdraw: (id: string) => Promise<void> | void;
  onEdit?: (id: string) => Promise<void> | void;
  onPromote?: (id: string) => Promise<void> | void;
};
const movable = (item: TurnQueueItemView) => !item.operationId && item.dispatchState === 'pending' && !item.error;

/** 展示与派发共用宿主队列；拖动只发送身份操作，顺序的权威来源是宿主快照。
 *  乐观顺序仅存在于「落手→宿主回执落地」的过渡帧，避免 dnd-kit 先弹回旧位再跳到新位的抖动。 */
export function TurnQueueTray({ state, onWithdraw, onEdit, onResume, onPromote, onReorder, onContinue, stoppedIdle = false }: QueueActions & {
  state: TurnQueueState;
  onResume: () => void;
  onReorder?: (inputId: string, overInputId: string, expectedInputIds: string[]) => Promise<boolean | void> | void;
  /** 停止收口（idle）后的「无新任务」态：真续跑（补「继续」回合），不是只解除暂停。 */
  onContinue?: () => void;
  stoppedIdle?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [sorting, setSorting] = useState(false);
  /** 乐观顺序（queueItemId 序列）：拖拽落手后立即按目标顺序渲染，宿主快照追平后回到权威状态。 */
  const [optimisticIds, setOptimisticIds] = useState<string[] | null>(null);
  const dragIds = useRef<string[]>([]);
  /** 渲染用的行序：乐观顺序有效且与快照成员一致时按乐观序，否则按宿主快照序。 */
  const items = useMemo(() => {
    if (!optimisticIds) return state.items;
    const byId = new Map(state.items.map((item) => [item.queueItemId, item]));
    const ordered = optimisticIds.map((id) => byId.get(id)).filter((item): item is TurnQueueItemView => Boolean(item));
    if (ordered.length !== optimisticIds.length) return state.items;
    for (const row of state.items) if (!optimisticIds.includes(row.queueItemId)) ordered.push(row);
    return ordered;
  }, [state.items, optimisticIds]);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  // 宿主顺序追平＝确认，清掉乐观层；快照迟迟不一致（被拒/超时）也回到权威顺序。
  useEffect(() => {
    if (!optimisticIds) return;
    const ids = state.items.map((item) => item.queueItemId);
    const confirmed = ids.length === optimisticIds.length && ids.every((id, index) => id === optimisticIds[index]);
    if (confirmed) { setOptimisticIds(null); return; }
    const fallback = setTimeout(() => setOptimisticIds(null), 3000);
    return () => clearTimeout(fallback);
  }, [state.items, optimisticIds]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const collision = useCallback<CollisionDetection>((args) => {
    const activeIndex = items.findIndex((item) => item.queueItemId === args.active.id);
    const allowed = new Set<string>();
    for (let i = activeIndex; i >= 0 && movable(items[i]); i--) allowed.add(items[i].queueItemId);
    for (let i = activeIndex + 1; i < items.length && movable(items[i]); i++) allowed.add(items[i].queueItemId);
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((container) => allowed.has(String(container.id))) });
  }, [items]);
  const reorder = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !onReorder) return;
    const from = itemsRef.current.findIndex((item) => item.queueItemId === active.id);
    const to = itemsRef.current.findIndex((item) => item.queueItemId === over.id);
    if (from < 0 || to < 0) return;
    // 乐观落位：落手帧就按目标顺序渲染，宿主回执后无缝衔接；被拒或异常立即回弹。
    const nextIds = itemsRef.current.map((item) => item.queueItemId);
    nextIds.splice(to, 0, nextIds.splice(from, 1)[0]);
    setOptimisticIds(nextIds);
    setSorting(true);
    try {
      const accepted = await onReorder(String(active.id), String(over.id), dragIds.current);
      if (accepted === false) setOptimisticIds(null);
    } catch {
      setOptimisticIds(null);
    } finally { setSorting(false); }
  };
  if (!state.items.length && !state.paused) return null;
  // 2026-10-18 用户裁决：手动停止后没有新任务＝只放一个「继续任务」按钮，
  // 不出「待发送消息（0）」空托盘；点击＝真续跑（补「继续」回合），
  // 不是只解除暂停位；停止尚未收口（stopping）时不打扰。
  if (!state.items.length) {
    if (!stoppedIdle) return null;
    return <div className="h24-queue-resume-only">
      <button type="button" className="h24-queue-resume" onClick={onContinue} title="继续：从停止处接着完成当前任务">继续任务</button>
    </div>;
  }
  return <div className="h24-queue-tray" aria-label="待发送消息">
    <button type="button" className="h24-queue-head" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
      <span>待发送</span><span className="h24-queue-count">{state.items.length}</span>{state.paused ? <small>已暂停</small> : null}
      {collapsed ? <ChevronDown className="h24-queue-chevron size-3.5" /> : <ChevronUp className="h24-queue-chevron size-3.5" />}
    </button>
    {collapsed ? null : <div className="h24-queue-body">
      {state.paused ? <div className="h24-queue-paused" role="status"><span>队列已暂停</span><button type="button" className="h24-queue-resume" onClick={onResume}>继续发送</button></div> : null}
      <div className="h24-queue-list">
      <DndContext sensors={sensors} collisionDetection={collision} modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        accessibility={{ screenReaderInstructions: { draggable: '按空格提起消息，上下方向键调整顺序，再按空格放下；Escape 取消。' }, announcements: {
          onDragStart: () => '已提起消息，上下移动调整顺序。',
          onDragOver: ({ over }) => over ? '移动到第 ' + (items.findIndex((item) => item.queueItemId === over.id) + 1) + ' 位。' : undefined,
          onDragEnd: () => '已放下消息。', onDragCancel: () => '已取消排序。',
        } }}
        onDragStart={() => { dragIds.current = items.map((item) => item.queueItemId); }} onDragEnd={(event) => void reorder(event)}>
        <SortableContext items={items.map((item) => item.queueItemId)} strategy={verticalListSortingStrategy}>
          {items.map((item, index) => <QueueRow key={item.queueItemId} item={item} order={index + 1}
            sorting={sorting} sortable={Boolean(onReorder) && items.filter(movable).length > 1}
            onWithdraw={onWithdraw} onEdit={onEdit} onPromote={onPromote} />)}
        </SortableContext>
      </DndContext>
      </div>
    </div>}
  </div>;
}

function QueueRow({ item, order, sortable, sorting, onWithdraw, onEdit, onPromote }: QueueActions & {
  item: TurnQueueItemView; order: number; sortable: boolean; sorting: boolean;
}) {
  const [acting, setActing] = useState(false);
  const locked = acting || sorting || item.dispatchState !== 'pending' || Boolean(item.error);
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.queueItemId, disabled: { draggable: !sortable || locked, droppable: !movable(item) },
  });
  const act = async (action: NonNullable<QueueActions['onPromote']>, editing = false) => {
    if (locked && !(editing && item.dispatchState === 'editing' && !acting && !sorting && !item.error)) return;
    setActing(true);
    try { await action(item.queueItemId); } finally { setActing(false); }
  };
  const waiting = item.dispatchState === 'promoting' || item.dispatchState === 'sending';
  return <div ref={setNodeRef} className="h24-queue-item" data-queue-item-id={item.queueItemId} data-state={item.dispatchState}
    data-source={item.inputSource ?? 'text'} data-dragging={isDragging ? 'true' : undefined}
    style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button ref={setActivatorNodeRef} type="button" className="h24-queue-tool h24-queue-drag" {...attributes} {...listeners}
      aria-label={'拖拽排序，第 ' + order + ' 条'} title="拖拽排序；也可按空格和上下方向键" disabled={!sortable || locked}>
      <GripVertical className="size-3.5" />
    </button>
    <div className="h24-queue-content">
      {/* 063：技能/行内引用标签与正式消息同一语义（队列摘要里也按标签回显）。 */}
      <p className="h24-queue-text" title={item.text}>{item.inputSource === 'voice' ? <span className="h24-queue-source">语音 · </span> : null}
        {segmentTaggedText(item.text, { skills: item.skills ?? [], references: (item.references ?? []) as MessageReferenceView[] }).map((segment, index) =>
          segment.type === 'text' ? <span key={index}>{segment.text}</span> : (
            <span
              key={index}
              className="composer-inline-tag h63-msg-tag"
              data-kind={segment.type === 'skill' ? 'skill' : segment.reference.kind}
              title={segment.type === 'skill' ? `技能 · ${segment.skill.name}` : segment.reference.subtitle}
            >
              {segment.text}
            </span>
          ),
        )}
      </p>
    </div>
    <div className="h24-queue-item-actions">
      <button type="button" className="h24-queue-run" aria-label="直接运行" title="直接运行：当前阶段结束后交接，旧任务不再继续" disabled={locked || Boolean(item.operationId) || !onPromote}
        data-waiting={waiting ? 'true' : undefined} onClick={() => onPromote && void act(onPromote)}>
        {waiting ? <Clock3 className="size-3" /> : <Play className="size-3" />}<span>{item.dispatchState === 'sending' ? '正在发送' : waiting ? '等待交接' : '直接运行'}</span>
      </button>
      <button type="button" className="h24-queue-tool" aria-label="编辑这条" title={item.readOnly?"本次参数已冻结，撤回后可从工作流重新准备":"取回输入框编辑"} disabled={!onEdit || item.readOnly || Boolean(item.operationId) || acting || sorting || waiting || Boolean(item.error)} onClick={() => { if (onEdit) void act(onEdit, true); }}><Pencil className="size-3.5" /></button>
      <button type="button" className="h24-queue-tool" aria-label="撤回这条" title="撤回这条" disabled={locked} onClick={() => void act(onWithdraw)}><X className="size-3.5" /></button>
    </div>
    {item.error ? <span className="h24-queue-error" role="alert">{item.error}</span> : null}
  </div>;
}
