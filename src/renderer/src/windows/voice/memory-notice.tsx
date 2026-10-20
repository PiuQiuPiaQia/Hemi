import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Check, CircleAlert, Undo2 } from 'lucide-react';

import type { MemoryChangedEvent, MemoryScopeSelector, WorkspaceState } from '@/shared/types';

/**
 * 037 对话内的记忆提示（视觉基准 designs/2026-10-03-memory「对话内的记忆提示」）：
 * 替代通用的「已更新记忆」，写明具体内容与范围，并给出 查看 / 撤销 / 恢复。
 * 由 `MemoryChangedEvent` 驱动；撤销走 `undoMemoryMutation(operationId)`，
 * 返回冲突时原地换成「没法单独撤销」。
 *
 * 本文件同时承载两处很小的跨页协调状态（模块级，不进 React 树）：
 * - 本窗口记忆页自己发起的变更（不在对话里重复提示）；
 * - 「查看」跳到记忆页时要定位的条目。
 */

export type MemoryNoticeState = 'ok' | 'pending' | 'undone' | 'conflict' | 'err' | 'forgot' | 'partial';

export type MemoryNoticeDetail = { mark: 'ok' | 'fail' | 'keep'; text: string };

type EntrySnapshot = { title: string; body: string; kind: string; sourceRefs: string[] };

export type MemoryNoticeItem = {
  id: string;
  state: MemoryNoticeState;
  /** 成功态动词：记住了 / 记下一条任务经验 / 已恢复。 */
  verb?: string;
  /** 条目标题；事件没带时为 null（退回不点名的文案）。 */
  title: string | null;
  scopeKey: string | null;
  scopeLabel: string;
  operationId: string | null;
  /** 失败原因（err）或撤销没成功的说明。 */
  reason?: string;
  pendingText?: string;
  /** 部分忘记的逐项结果。 */
  detail?: MemoryNoticeDetail[];
  detailOpen?: boolean;
  /** 撤销前留的条目内容，供「恢复」重新写回。 */
  snapshot?: EntrySnapshot | null;
  busy?: boolean;
};

export type MemoryFocusTarget = { scopeKey: string | null; title: string | null };

// ---------------------------------------------------------------- 跨页协调（模块级）

let localMutationDepth = 0;
let localMutationUntil = 0;

/**
 * 记忆页发起变更时包一层：期间到达的 `memory:changed` 属于设置页自己的操作，
 * 对话侧不再提示。广播先于 invoke 回执到达，所以用「进行中」标记而不是事后比对 id。
 */
export async function trackLocalMemoryMutation<T>(action: () => Promise<T>): Promise<T> {
  localMutationDepth += 1;
  try {
    return await action();
  } finally {
    localMutationDepth -= 1;
    // 回执与广播的先后不作假设：收尾后留一小段宽限。
    localMutationUntil = Date.now() + 250;
  }
}

function isLocalMemoryMutation(): boolean {
  return localMutationDepth > 0 || Date.now() < localMutationUntil;
}

const FOCUS_EVENT = 'hemi:memory-focus';
let pendingFocus: MemoryFocusTarget | null = null;

/** 「查看」：登记要定位的条目，记忆页挂载或已在场时取走。 */
export function requestMemoryFocus(target: MemoryFocusTarget) {
  pendingFocus = target;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

export function takeMemoryFocus(): MemoryFocusTarget | null {
  const target = pendingFocus;
  pendingFocus = null;
  return target;
}

export function onMemoryFocusRequest(callback: () => void): () => void {
  window.addEventListener(FOCUS_EVENT, callback);
  return () => window.removeEventListener(FOCUS_EVENT, callback);
}

export function parseMemoryScopeKey(scopeKey: string | null): MemoryScopeSelector | null {
  if (scopeKey === 'global/user') return { kind: 'global', target: 'user' };
  if (scopeKey === 'global/facts') return { kind: 'global', target: 'facts' };
  if (scopeKey?.startsWith('workspace/')) return { kind: 'workspace', workspaceId: scopeKey.slice('workspace/'.length) };
  return null;
}

/** 提示里的范围名：关于你 / 全局约定 / 工作区名（默认空间、已登记项目）。 */
export function memoryScopeLabel(scopeKey: string | null, workspaces: WorkspaceState | null): string {
  if (!scopeKey) return '';
  if (scopeKey === 'global/user') return '关于你';
  if (scopeKey === 'global/facts') return '全局约定';
  const id = scopeKey.startsWith('workspace/') ? scopeKey.slice('workspace/'.length) : scopeKey;
  if (workspaces?.default.id === id) return workspaces.default.name || '默认空间';
  return workspaces?.projects.find((project) => project.id === id)?.name ?? '工作区记忆';
}

// ---------------------------------------------------------------- 事件 → 提示

/**
 * 事件的可选扩展字段：当前主进程只发 scopeKey/operationId/revision/epoch/entrySummary；
 * 这里按「有就用」读取 action/title/origin/conversationId，主进程补上后无需再改渲染层。
 */
type MemoryChangedEventLike = MemoryChangedEvent & {
  action?: string;
  title?: string | null;
  origin?: string;
  conversationId?: string | null;
};

export function noticeFromMemoryEvent(
  event: MemoryChangedEventLike,
  scopeLabelOf: (scopeKey: string | null) => string,
): Omit<MemoryNoticeItem, 'id'> | null {
  // 撤销/恢复的广播不带范围；清空没有条目摘要——都不是「记住/忘记了一条」。
  if (!event?.scopeKey) return null;
  const summary = event.title ?? event.entrySummary;
  if (!summary && !event.action) return null;
  // 没有 action 字段时按摘要判断：删除广播的摘要是条目 id（mem-…），其余是标题。
  const removed = event.action
    ? event.action === 'remove' || event.action === 'forget'
    : /^mem-[0-9a-f-]{8,}$/i.test(summary ?? '');
  if (event.action === 'clear') return null;
  const base = {
    scopeKey: event.scopeKey,
    scopeLabel: scopeLabelOf(event.scopeKey),
    operationId: event.operationId ?? null,
  };
  if (removed) {
    return { ...base, state: 'forgot', title: event.title ?? null };
  }
  return {
    ...base,
    state: 'ok',
    verb: event.origin === 'task' ? '记下一条任务经验' : '记住了',
    title: summary ?? null,
  };
}

const MAX_NOTICES = 3;
let noticeSeq = 0;

export function useMemoryNotices(options: {
  scopeLabelOf: (scopeKey: string | null) => string;
  /** 「查看 / 去记忆页」：打开设置的记忆页。定位目标已由本 hook 登记。 */
  onOpenMemoryPage: () => void;
  /** 当前会话 id（事件带 conversationId 时只收本会话的）。 */
  currentConversationId?: () => string | null;
}) {
  const [items, setItems] = useState<MemoryNoticeItem[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** 本 hook 自己发起的撤销/恢复：它们的广播不再生成新提示。 */
  const selfBusy = useRef(0);

  const patch = useCallback((id: string, next: Partial<MemoryNoticeItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const push = useCallback((notice: Omit<MemoryNoticeItem, 'id'>) => {
    noticeSeq += 1;
    const id = `mn-${noticeSeq}`;
    setItems((prev) => [...prev, { ...notice, id }].slice(-MAX_NOTICES));
    return id;
  }, []);

  /** 自上次 clear 以来是否收到过事件驱动的提示（旧通路兜底时避免重复）。 */
  const sawEvent = useRef(false);

  const clear = useCallback(() => {
    sawEvent.current = false;
    setItems([]);
  }, []);

  /**
   * 旧通路兜底：对话回合的 `memoryChanged`（主进程尚未对这条路径广播 MemoryChangedEvent）。
   * 本回合已经有事件驱动的提示时不再补一条不点名的「已更新记忆」。
   */
  const pushLegacy = useCallback((notice: Omit<MemoryNoticeItem, 'id'>) => {
    if (sawEvent.current) return null;
    return push(notice);
  }, [push]);

  useEffect(() => {
    const unsubscribe = window.hemiVoice?.onMemoryChanged?.((raw: MemoryChangedEvent) => {
      const event = raw as MemoryChangedEventLike;
      if (selfBusy.current > 0 || isLocalMemoryMutation()) return;
      if (event.origin === 'settings') return;
      const current = optionsRef.current.currentConversationId?.() ?? null;
      if (event.conversationId && current && event.conversationId !== current) return;
      const notice = noticeFromMemoryEvent(event, optionsRef.current.scopeLabelOf);
      if (notice) {
        sawEvent.current = true;
        push(notice);
      }
    });
    return () => unsubscribe?.();
  }, [push]);

  const runSelf = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    selfBusy.current += 1;
    try {
      return await action();
    } finally {
      // 广播可能晚于回执一拍到达。
      window.setTimeout(() => {
        selfBusy.current -= 1;
      }, 250);
    }
  }, []);

  const view = useCallback((item: MemoryNoticeItem) => {
    requestMemoryFocus({ scopeKey: item.scopeKey, title: item.state === 'forgot' ? null : item.title });
    optionsRef.current.onOpenMemoryPage();
  }, []);

  const undo = useCallback(async (item: MemoryNoticeItem) => {
    const bridge = window.hemiVoice;
    if (!bridge || !item.operationId || item.busy) return;
    patch(item.id, { busy: true, reason: undefined });
    try {
      const result = await runSelf(async () => {
        // 撤销「记住」前先留一份内容，供「恢复」写回；同时拿到版本做冲突保护。
        let snapshot: EntrySnapshot | null = null;
        let expectedAfterVersion: number | undefined;
        const scope = parseMemoryScopeKey(item.scopeKey);
        if (item.state === 'ok' && scope && item.title) {
          const listed = await bridge.listMemoryEntries({ scope, query: item.title, limit: 20 });
          const hit = listed?.data?.entries.find((entry) => entry.title === item.title);
          if (hit) {
            snapshot = { title: hit.title, body: hit.body, kind: hit.kind, sourceRefs: hit.sourceRefs };
            expectedAfterVersion = hit.version;
          }
        }
        const outcome = await bridge.undoMemoryMutation({ operationId: item.operationId as string, expectedAfterVersion });
        return { outcome, snapshot };
      });
      const { outcome, snapshot } = result;
      if (outcome?.ok) {
        if (item.state === 'forgot') {
          const restored = (outcome.data as { entry?: { title?: string } } | undefined)?.entry?.title;
          patch(item.id, { busy: false, state: 'ok', verb: '已恢复', title: restored ?? item.title, operationId: null });
        } else {
          patch(item.id, { busy: false, state: 'undone', snapshot, operationId: null });
        }
      } else if (outcome?.code === 'conflict') {
        patch(item.id, { busy: false, state: 'conflict' });
      } else {
        patch(item.id, { busy: false, reason: `撤销没成功：${outcome?.message ?? outcome?.code ?? '未知原因'}` });
      }
    } catch (error) {
      patch(item.id, { busy: false, reason: `撤销没成功：${error instanceof Error ? error.message : String(error)}` });
    }
  }, [patch, runSelf]);

  const restore = useCallback(async (item: MemoryNoticeItem) => {
    const bridge = window.hemiVoice;
    const scope = parseMemoryScopeKey(item.scopeKey);
    if (!bridge || !scope || !item.snapshot || item.busy) return;
    const snapshot = item.snapshot;
    patch(item.id, { busy: true, reason: undefined });
    try {
      const outcome = await runSelf(() => bridge.mutateMemoryEntry({ scope, action: 'add', ...snapshot }));
      if (outcome?.ok) {
        patch(item.id, { busy: false, state: 'ok', verb: '已恢复', operationId: outcome.operationId ?? null, snapshot: null });
      } else {
        patch(item.id, { busy: false, reason: `恢复没成功：${outcome?.message ?? outcome?.code ?? '未知原因'}` });
      }
    } catch (error) {
      patch(item.id, { busy: false, reason: `恢复没成功：${error instanceof Error ? error.message : String(error)}` });
    }
  }, [patch, runSelf]);

  const toggleDetail = useCallback((item: MemoryNoticeItem) => {
    patch(item.id, { detailOpen: !item.detailOpen });
  }, [patch]);

  return { items, push, pushLegacy, clear, view, undo, restore, toggleDetail };
}

// ---------------------------------------------------------------- 展示

type NoticeHandlers = {
  onView?: (item: MemoryNoticeItem) => void;
  onUndo?: (item: MemoryNoticeItem) => void;
  onRestore?: (item: MemoryNoticeItem) => void;
  onRetry?: (item: MemoryNoticeItem) => void;
  onToggleDetail?: (item: MemoryNoticeItem) => void;
};

const DETAIL_MARK: Record<MemoryNoticeDetail['mark'], string> = { ok: '✓', fail: '✕', keep: '·' };

function Subject({ item, fallback }: { item: MemoryNoticeItem; fallback: string }) {
  return (
    <>
      {item.title ? <b>{item.title}</b> : fallback}
      {item.scopeLabel ? <span className="h37-mn-scope"> · {item.scopeLabel}</span> : null}
    </>
  );
}

export function MemoryNotice({ item, onView, onUndo, onRestore, onRetry, onToggleDetail }: { item: MemoryNoticeItem } & NoticeHandlers) {
  const tone = item.state === 'conflict' || item.state === 'partial'
    ? 'warn'
    : item.state === 'err'
      ? 'danger'
      : item.state === 'pending'
        ? 'pending'
        : item.state === 'undone'
          ? 'undone'
          : 'ok';

  let icon = <Check aria-hidden="true" />;
  let text: ReactNode = null;
  const actions: Array<{ label: string; run?: () => void }> = [];

  switch (item.state) {
    case 'ok':
      text = item.title
        ? <>{item.verb ?? '记住了'}：<Subject item={item} fallback="" /></>
        : <>已更新记忆{item.scopeLabel ? <span className="h37-mn-scope"> · {item.scopeLabel}</span> : null}</>;
      actions.push({ label: '查看', run: onView && (() => onView(item)) });
      if (item.operationId) actions.push({ label: '撤销', run: onUndo && (() => onUndo(item)) });
      break;
    case 'pending':
      icon = <i className="h37-spinner" aria-hidden="true" />;
      text = item.pendingText ?? '正在保存…';
      break;
    case 'undone':
      icon = <Undo2 aria-hidden="true" />;
      text = <>已撤销：<Subject item={item} fallback="这条记忆" /></>;
      if (item.snapshot) actions.push({ label: '恢复', run: onRestore && (() => onRestore(item)) });
      break;
    case 'conflict':
      icon = <CircleAlert aria-hidden="true" />;
      text = <>没法单独撤销：{item.title ? <b>{item.title}</b> : '这条记忆'} 之后在记忆页改过。可以去记忆页直接改或删。</>;
      actions.push({ label: '去记忆页', run: onView && (() => onView(item)) });
      break;
    case 'err':
      icon = <CircleAlert aria-hidden="true" />;
      text = (
        <>
          这条记忆未保存：<Subject item={item} fallback="" />
          <br />
          {item.reason ? `${item.reason}，` : ''}你的原话还在对话里。
        </>
      );
      if (onRetry) actions.push({ label: '重试', run: () => onRetry(item) });
      break;
    case 'forgot':
      text = (
        <>
          已忘记：<Subject item={item} fallback="一条记忆" />
          <br />
          <span className="h37-mn-scope">原始聊天与任务档案保留。</span>
        </>
      );
      if (item.operationId) actions.push({ label: '撤销', run: onUndo && (() => onUndo(item)) });
      break;
    case 'partial':
      icon = <CircleAlert aria-hidden="true" />;
      text = (
        <>
          只忘掉了一部分：<Subject item={item} fallback="" />
          {item.detailOpen && item.detail?.length ? (
            <ul className="h37-mn-detail">
              {item.detail.map((line) => (
                <li key={line.text} data-mark={line.mark}>
                  <i aria-hidden="true">{DETAIL_MARK[line.mark]}</i>
                  {line.text}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
      if (item.detail?.length) actions.push({ label: item.detailOpen ? '收起' : '详情', run: onToggleDetail && (() => onToggleDetail(item)) });
      if (onRetry) actions.push({ label: '重试', run: () => onRetry(item) });
      break;
  }

  // 撤销/恢复没成功时的补充说明（err 态的原因已并入正文）。
  const hint = item.state !== 'err' && item.reason ? item.reason : '';

  return (
    <div className="h37-mn" data-tone={tone} role="status" aria-busy={item.busy || undefined}>
      {icon}
      <span className="h37-mn-text">
        {text}
        {hint ? <span className="h37-mn-hint">{hint}</span> : null}
      </span>
      {actions.length ? (
        <span className="h37-mn-acts">
          {actions.map((action) => (
            <button key={action.label} type="button" disabled={item.busy || !action.run} onClick={action.run}>
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** 一组提示（最近的在下）。空列表不渲染任何节点，不占布局。 */
export function MemoryNotices({ items, ...handlers }: { items: MemoryNoticeItem[] } & NoticeHandlers) {
  if (!items.length) return null;
  return (
    <div className="h37-mn-stack">
      {items.map((item) => (
        <MemoryNotice key={item.id} item={item} {...handlers} />
      ))}
    </div>
  );
}
