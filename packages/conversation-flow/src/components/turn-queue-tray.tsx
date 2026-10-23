import type { MessageReferenceView } from '../types/presentation.js';
import { useCallback, useRef, useState } from 'react';
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

/** 展示与派发共用宿主队列；拖动只发送身份操作，不在界面另存一份排队顺序。 */
export function TurnQueueTray({ state, onWithdraw, onEdit, onResume, onPromote, onReorder, onContinue, stoppedIdle = false }: QueueActions & {
  state: TurnQueueState;
  onResume: () => void;
  onReorder?: (inputId: string, overInputId: string, expectedInputIds: string[]) => Promise<void> | void;
  /** 停止收口（idle）后的「无新任务」态：真续跑（补「继续」回合），不是只解除暂停。 */
  onContinue?: () => void;
  stoppedIdle?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [sorting, setSorting] = useState(false);
  const dragIds = useRef<string[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const collision = useCallback<CollisionDetection>((args) => {
    const activeIndex = state.items.findIndex((item) => item.queueItemId === args.active.id);
    const allowed = new Set<string>();
    for (let i = activeIndex; i >= 0 && movable(state.items[i]); i--) allowed.add(state.items[i].queueItemId);
    for (let i = activeIndex + 1; i < state.items.length && movable(state.items[i]); i++) allowed.add(state.items[i].queueItemId);
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((container) => allowed.has(String(container.id))) });
  }, [state.items]);
  const reorder = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !onReorder) return;
    setSorting(true);
    try { await onReorder(String(active.id), String(over.id), dragIds.current); }
    finally { setSorting(false); }
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
      {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
      <span>待发送消息（{state.items.length}）</span>{state.paused ? <small>已暂停</small> : null}
    </button>
    {collapsed ? null : <div className="h24-queue-body">
      {state.paused ? <div className="h24-queue-paused" role="status"><span>队列已暂停</span><button type="button" className="h24-queue-resume" onClick={onResume}>继续发送</button></div> : null}
      <div className="h24-queue-list">
      <DndContext sensors={sensors} collisionDetection={collision} modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        accessibility={{ screenReaderInstructions: { draggable: '按空格提起消息，上下方向键调整顺序，再按空格放下；Escape 取消。' }, announcements: {
          onDragStart: () => '已提起消息，上下移动调整顺序。',
          onDragOver: ({ over }) => over ? '移动到第 ' + (state.items.findIndex((item) => item.queueItemId === over.id) + 1) + ' 位。' : undefined,
          onDragEnd: () => '已放下消息。', onDragCancel: () => '已取消排序。',
        } }}
        onDragStart={() => { dragIds.current = state.items.map((item) => item.queueItemId); }} onDragEnd={(event) => void reorder(event)}>
        <SortableContext items={state.items.map((item) => item.queueItemId)} strategy={verticalListSortingStrategy}>
          {state.items.map((item, index) => <QueueRow key={item.queueItemId} item={item} order={index + 1}
            sorting={sorting} sortable={Boolean(onReorder) && state.items.filter(movable).length > 1}
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
  const act = async (action: NonNullable<QueueActions['onPromote']>) => {
    if (locked) return;
    setActing(true);
    try { await action(item.queueItemId); } finally { setActing(false); }
  };
  const waiting = item.dispatchState === 'promoting';
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
        {waiting ? <Clock3 className="size-3" /> : <Play className="size-3" />}<span>{waiting ? '等待交接' : '直接运行'}</span>
      </button>
      <button type="button" className="h24-queue-tool" aria-label="编辑这条" title={item.readOnly?"本次参数已冻结，撤回后可从工作流重新准备":"回到输入框编辑"} disabled={!onEdit || item.readOnly || Boolean(item.operationId) || acting || sorting || waiting || Boolean(item.error)} onClick={() => { if (!onEdit) return; if (item.dispatchState === 'editing') onEdit(item.queueItemId); else void act(onEdit); }}><Pencil className="size-3.5" /></button>
      <button type="button" className="h24-queue-tool" aria-label="撤回这条" title="撤回这条" disabled={locked} onClick={() => void act(onWithdraw)}><X className="size-3.5" /></button>
    </div>
    {item.error ? <span className="h24-queue-error" role="alert">{item.error}</span> : item.dispatchState === 'editing' ? <span className="h24-queue-status">输入框编辑中</span> : null}
  </div>;
}
