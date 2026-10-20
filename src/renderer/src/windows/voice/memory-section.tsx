import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  Code,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  Inbox,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Brain,
} from 'lucide-react';

import type {
  MemoryEntryView,
  MemoryMutationResult,
  MemoryScopeSelector,
  MemoryState,
  MemoryStatus,
  WorkspaceState,
} from '@/shared/types';
import { onMemoryFocusRequest, takeMemoryFocus, trackLocalMemoryMutation } from '@/windows/voice/memory-notice';
import { copyTextViaBridge } from '@/lib/use-clipboard-copy';

/**
 * 037 设置页·记忆区块（视觉基准 requirements/040-visual-system/designs/2026-10-03-memory）：
 * 范围分段（关于你 / 全局约定 / 工作区记忆＋工作区选择器）→ 工具行（搜索、添加、页级 ⋯）
 * → 列表（行内编辑、行 ⋯：移动 / 复制 / 删除）→ 自动记录开关；原文（高级）为下钻页。
 *
 * 状态反馈（R-16）：首次加载 >300ms 才出骨架；读取失败给重试；编辑中外部变更只出提示条、
 * 不覆盖草稿；保存冲突（version 不一致）出琥珀条三选一；有未保存修改时切范围 / 离开先弹
 * 三选一对话框；开关 pending >300ms 才显示「保存中」，失败滑回原值。
 * 删除 / 移动后 toast 可撤销 5 秒（undoMemoryMutation）；清空不可撤销，确认框写明条数。
 */

type ScopeTab = 'user' | 'facts' | 'workspace';

type WorkspaceOption = {
  id: string;
  name: string;
  tag?: '默认' | '已移除';
  /** 列表上方的灰条说明（未绑定 / 已移除）。 */
  note?: string;
  /** 能否作为「移到」目标。 */
  movable: boolean;
  moveHint: string;
};

type ListData = {
  scopeKey: string;
  query: string;
  entries: MemoryEntryView[];
  total: number;
  nextCursor: number | null;
  revision: number;
  epoch: number;
  looseCount: number;
  syncedAt: number;
};

type EditorState = {
  /** 'new' = 添加；否则是条目 id。 */
  id: string;
  baseTitle: string;
  baseBody: string;
  title: string;
  body: string;
  expectedVersion?: number;
  conflict?: { title: string; body: string; version: number; updatedAt: number; shown: boolean } | null;
  saving?: boolean;
  error?: string;
};

type MenuState =
  | { kind: 'page'; anchor: HTMLElement }
  | { kind: 'ws'; anchor: HTMLElement }
  | { kind: 'entry'; anchor: HTMLElement; entry: MemoryEntryView };

type DialogState =
  | { kind: 'delete'; entry: MemoryEntryView }
  | { kind: 'move'; entry: MemoryEntryView; target: string | null }
  | { kind: 'clear'; count: number; revision: number }
  | { kind: 'leave'; onLeave: () => void; onStay?: () => void };

type ToastState = { id: number; text: string; undo?: () => Promise<void>; tone?: 'err' };

type SwitchState = { on: boolean | null; pending: boolean; showPending: boolean; saved: boolean; error: string; lastTarget: boolean | null };

const SCOPE_LABELS: Record<Exclude<ScopeTab, 'workspace'>, string> = {
  user: '关于你',
  facts: '全局约定',
};

const KIND_LABELS: Record<string, string> = {
  feedback: '协作反馈',
  experience: '任务经验',
  reference: '参考',
};

const TITLE_MAX = 200;
const BODY_MAX = 2000;

function scopeOf(tab: ScopeTab, workspaceId: string): MemoryScopeSelector | null {
  if (tab === 'user') return { kind: 'global', target: 'user' };
  if (tab === 'facts') return { kind: 'global', target: 'facts' };
  if (!workspaceId) return null;
  return { kind: 'workspace', workspaceId };
}

function scopeKeyOf(scope: MemoryScopeSelector | null): string | null {
  if (!scope) return null;
  if (scope.kind === 'global') return `global/${scope.target}`;
  return `workspace/${scope.workspaceId}`;
}

function scopeFromKey(key: string): MemoryScopeSelector | null {
  if (key === 'global/user') return { kind: 'global', target: 'user' };
  if (key === 'global/facts') return { kind: 'global', target: 'facts' };
  if (key.startsWith('workspace/')) return { kind: 'workspace', workspaceId: key.slice('workspace/'.length) };
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 「今天 14:02」「昨天 09:10」「9月28日」「2025年9月28日」。 */
export function formatMemoryTime(ts: number, now = Date.now()): string {
  if (!ts) return '更早';
  const d = new Date(ts);
  const startOfToday = new Date(new Date(now).toDateString()).getTime();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (ts >= startOfToday) return `今天 ${hm}`;
  if (ts >= startOfToday - 24 * 3600 * 1000) return `昨天 ${hm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 来源引用：`conversation:<id>` / `task:<id>` / 自由文本。 */
function describeSource(refs: string[]): string | null {
  const ref = refs.find((item) => typeof item === 'string' && item.trim());
  if (!ref) return null;
  const match = /^(conversation|chat|task|call)[:/](.*)$/i.exec(ref.trim());
  // 自由文本（如「10月3日对话「…」」）原样接在「来自」后面。
  if (!match) return `来自 ${ref.trim()}`;
  const kind = match[1].toLowerCase();
  const label = kind === 'task' ? '任务' : kind === 'call' ? '通话' : '对话';
  const rest = match[2].trim();
  // 只有像人话的部分才加引号展示，纯 id 不展示。
  return /[^\x20-\x7e]|\s/.test(rest) ? `来自${label}「${rest}」` : `来自${label}`;
}

/** 来源里结尾的「原话」单独强调（设计稿用强调色；暂无跳回原对话的入口，所以不做成链接）。 */
function renderSource(text: string): ReactNode {
  const match = /^(.*?)\s*(「[^「」]*」)$/.exec(text);
  if (!match) return text;
  return (
    <>
      {match[1]} <span className="h37-mem-src-q">{match[2]}</span>
    </>
  );
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + q.length)}</mark>
      {text.slice(index + q.length)}
    </>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reasonOf(result: { message?: string; code?: string } | null | undefined, fallback: string): string {
  return (result?.message ?? (result?.code ? `${fallback}（${result.code}）` : fallback)).replace(/[。.]$/, '');
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const isNarrow = () => window.matchMedia?.('(max-width: 600px)').matches ?? false;

/** 删除 / 移出：先淡出 140ms in，再合拢 200ms move。 */
async function collapseOut(element: HTMLElement | null | undefined) {
  if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return;
  const height = element.getBoundingClientRect().height;
  element.style.overflow = 'hidden';
  await element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).finished.catch(() => {});
  await element.animate([{ height: `${height}px` }, { height: '0px' }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).finished.catch(() => {});
}

// ---------------------------------------------------------------- 离开守卫（设置页接线点）

let leaveGuard: (() => Promise<boolean>) | null = null;
let draftProbe: (() => boolean) | null = null;

/** 记忆页是否有未保存的编辑（条目编辑器或原文）。 */
export function hasUnsavedMemoryDraft(): boolean {
  return draftProbe?.() ?? false;
}

/**
 * 离开记忆页前调用（切设置页、关闭设置）：没有未保存修改直接返回 true；
 * 有的话弹「还有修改没保存」三选一，用户选「放弃 / 保存并离开」返回 true，「继续编辑」返回 false。
 */
export function confirmMemoryLeave(): Promise<boolean> {
  return leaveGuard ? leaveGuard() : Promise.resolve(true);
}

// ---------------------------------------------------------------- fixtures 预设（截图不可交互）

export type MemorySectionPreset = {
  tab?: ScopeTab;
  workspaceId?: string;
  query?: string;
  /** 展开的条目标题。 */
  expanded?: string[];
  editor?: { title: string; draftTitle?: string; draftBody?: string; conflict?: { title: string; body: string } } | { add: true; draftTitle?: string; draftBody?: string };
  external?: boolean;
  menu?: 'page' | 'ws' | { entry: string };
  dialog?: 'clear' | 'leave' | { delete: string } | { move: string; to?: string };
  toast?: { text: string; undo?: boolean };
  raw?: boolean;
  switchError?: string;
};

let fixturePreset: MemorySectionPreset | null = null;

/** 仅供 fixtures：在挂载前设定要摆出的状态。 */
export function setMemorySectionPreset(preset: MemorySectionPreset | null) {
  fixturePreset = preset;
}

// ---------------------------------------------------------------- 弹层：菜单 / 对话框 / toast

type MenuItem =
  | { kind: 'item'; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; tag?: string; current?: boolean; onSelect: () => void }
  | { kind: 'sep' }
  | { kind: 'foot'; text: string };

function MemoryMenu({ anchor, label, items, onClose }: { anchor: HTMLElement; label: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [sheet] = useState(isNarrow);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback((refocus = true) => {
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(), prefersReducedMotion() ? 0 : 140);
    if (refocus) anchor.focus({ preventScroll: true });
  }, [anchor]);

  useLayoutEffect(() => {
    if (sheet) return;
    const rect = anchor.getBoundingClientRect();
    const menu = ref.current;
    const width = menu?.offsetWidth ?? 200;
    const height = menu?.offsetHeight ?? 160;
    const below = rect.bottom + 4 + height <= window.innerHeight - 8;
    const top = below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height);
    // 右对齐触发器；左侧放不下时左对齐。
    let left = rect.right - width;
    let originX = 'right';
    if (left < 8) {
      left = Math.min(rect.left, window.innerWidth - width - 8);
      originX = 'left';
    }
    setPos({ top, left, origin: `${below ? 'top' : 'bottom'} ${originX}` });
  }, [anchor, sheet]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return createPortal(
    <>
      <div className="h37-mem-catch" data-sheet={sheet || undefined} data-closing={closing || undefined} onMouseDown={() => close()} />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="h37-menu h37-mem-menu"
        data-sheet={sheet || undefined}
        data-closing={closing || undefined}
        style={sheet ? undefined : { top: pos?.top ?? -9999, left: pos?.left ?? -9999, ['--transform-origin' as string]: pos?.origin }}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => {
          if (item.kind === 'sep') return <div key={`sep-${index}`} className="h37-menu-sep" role="separator" />;
          if (item.kind === 'foot') return <div key={`foot-${index}`} className="h37-mem-menu-foot">{item.text}</div>;
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="h37-menu-item"
              data-danger={item.danger || undefined}
              data-current={item.current || undefined}
              disabled={item.disabled}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              {item.icon}
              <span className="h37-mem-menu-label">{item.label}</span>
              {item.tag ? <span className="h37-tag h37-mem-tag">{item.tag}</span> : null}
              {item.current ? <Check className="h37-mem-tick" aria-label="当前" /> : null}
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

function MemoryDialog({
  title,
  children,
  onCancel,
  foot,
  labelledBy,
}: {
  title: string;
  children?: ReactNode;
  onCancel: () => void;
  foot: ReactNode;
  labelledBy: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const primary = ref.current?.querySelector<HTMLButtonElement>('[data-primary="true"]:not(:disabled)')
      ?? ref.current?.querySelector<HTMLButtonElement>('.h37-dialog-foot button:not(:disabled)');
    primary?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      className="h37-scrim h37-mem-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={ref}
        className="h37-dialog h37-mem-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h3 id={labelledBy}>{title}</h3>
        {children}
        <div className="h37-dialog-foot">{foot}</div>
      </div>
    </div>,
    document.body,
  );
}

function MemoryToast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(onDone, toast.undo ? 5000 : 2600);
    return () => window.clearTimeout(timer);
  }, [toast, onDone]);
  return createPortal(
    <div className="h37-toast h37-toast-card" role="status" data-tone={toast.tone} key={toast.id}>
      {toast.tone === 'err' ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
      <span>{toast.text}</span>
      {toast.undo ? (
        <button
          type="button"
          className="h37-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await toast.undo?.();
          }}
        >
          撤销
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- 主组件

export function MemorySection() {
  const presetRef = useRef<MemorySectionPreset | null>(fixturePreset);
  const preset = presetRef.current;

  const [tab, setTab] = useState<ScopeTab>(preset?.tab ?? 'user');
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState(preset?.workspaceId ?? 'default');
  const [query, setQuery] = useState(preset?.query ?? '');
  const [appliedQuery, setAppliedQuery] = useState(preset?.query ?? '');
  const [list, setList] = useState<ListData | null>(null);
  const [loadError, setLoadError] = useState<{ scopeKey: string; message: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [counts, setCounts] = useState<{ user: number | null; facts: number | null; loose: number }>({ user: null, facts: null, loose: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [external, setExternal] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawDirty, setRawDirty] = useState(false);
  const [exitSummary, setExitSummary] = useState<SwitchState>({ on: null, pending: false, showPending: false, saved: false, error: '', lastTarget: null });
  const [now, setNow] = useState(() => Date.now());

  const entryRefs = useRef(new Map<string, HTMLDivElement>());
  const titleInputRef = useRef<HTMLInputElement>(null);
  const localBusy = useRef(0);
  const toastSeq = useRef(0);
  const presetApplied = useRef(false);
  const focusTarget = useRef<{ scopeKey: string | null; title: string | null } | null>(null);
  const rawSaveRef = useRef<(() => Promise<boolean>) | null>(null);

  const scope = useMemo(() => scopeOf(tab, workspaceId), [tab, workspaceId]);
  const scopeKey = scopeKeyOf(scope);
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const scopeLabel = tab === 'workspace' ? (workspace?.name ?? workspaceId) : SCOPE_LABELS[tab];

  const labelOfKey = useCallback((key: string) => {
    if (key === 'global/user') return SCOPE_LABELS.user;
    if (key === 'global/facts') return SCOPE_LABELS.facts;
    const id = key.slice('workspace/'.length);
    return workspaces.find((w) => w.id === id)?.name ?? id;
  }, [workspaces]);

  const showToast = useCallback((text: string, extra: Partial<Omit<ToastState, 'id' | 'text'>> = {}) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, ...extra });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const flash = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setFlashIds((prev) => new Set([...prev, ...ids]));
    window.setTimeout(() => {
      setFlashIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }, 1400);
  }, []);

  /** 设置页自己的写操作：本地标记（对话侧不提示）＋列表自己刷新（不等广播）。 */
  const mutate = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    localBusy.current += 1;
    try {
      return await trackLocalMemoryMutation(action);
    } finally {
      window.setTimeout(() => {
        localBusy.current -= 1;
      }, 250);
    }
  }, []);

  // ---------------------------------------------------------------- 读取

  const refreshCounts = useCallback(async () => {
    const bridge = window.hemiVoice;
    if (!bridge?.listMemoryEntries) return;
    const [user, facts] = await Promise.all([
      bridge.listMemoryEntries({ scope: { kind: 'global', target: 'user' }, limit: 1 }).catch(() => null),
      bridge.listMemoryEntries({ scope: { kind: 'global', target: 'facts' }, limit: 1 }).catch(() => null),
    ]);
    setCounts({
      user: user?.ok && user.data ? user.data.total : null,
      facts: facts?.ok && facts.data ? facts.data.total : null,
      loose: facts?.ok && facts.data ? facts.data.loose.count : 0,
    });
  }, []);

  const loadSeq = useRef(0);
  const load = useCallback(async (mode: 'switch' | 'silent' | 'refresh' = 'switch') => {
    if (!scope || !scopeKey) return;
    const bridge = window.hemiVoice;
    if (!bridge?.listMemoryEntries) return;
    loadSeq.current += 1;
    const seq = loadSeq.current;
    if (mode === 'switch') setLoadingKey(scopeKey);
    if (mode === 'refresh') setRefreshing(true);
    try {
      const result = await bridge.listMemoryEntries({ scope, query: appliedQuery, limit: 50 });
      if (seq !== loadSeq.current) return;
      if (!result?.ok || !result.data) {
        setLoadError({ scopeKey, message: reasonOf(result, '读取失败') });
        return;
      }
      const data = result.data;
      setLoadError(null);
      setExternal(false);
      setList((prev) => {
        // 静默刷新：变化的行闪一次浅绿。
        if (prev && prev.scopeKey === scopeKey && mode !== 'switch') {
          const before = new Map(prev.entries.map((e) => [e.id, e.version]));
          const changed = data.entries.filter((e) => before.get(e.id) !== e.version).map((e) => e.id);
          if (changed.length) window.setTimeout(() => flash(changed), 0);
        }
        return {
          scopeKey,
          query: appliedQuery,
          entries: data.entries,
          total: data.total,
          nextCursor: data.nextCursor,
          revision: data.revision,
          epoch: data.epoch,
          looseCount: data.loose.count,
          syncedAt: Date.now(),
        };
      });
      if (scopeKey === 'global/facts' && !appliedQuery) {
        setCounts((prev) => ({ ...prev, facts: data.total, loose: data.loose.count }));
      } else if (scopeKey === 'global/user' && !appliedQuery) {
        setCounts((prev) => ({ ...prev, user: data.total }));
      }
    } catch (error) {
      if (seq !== loadSeq.current) return;
      setLoadError({ scopeKey, message: `读取失败：${errorText(error)}` });
    } finally {
      if (seq === loadSeq.current) {
        setLoadingKey(null);
        setRefreshing(false);
      }
    }
  }, [scope, scopeKey, appliedQuery, flash]);

  useEffect(() => {
    void load('switch');
  }, [load]);

  // 首次加载 / 切范围超过 300ms 才出骨架。
  useEffect(() => {
    if (!loadingKey) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), 300);
    return () => window.clearTimeout(timer);
  }, [loadingKey]);

  // 搜索：输入停 200ms 后再查。
  useEffect(() => {
    if (query === appliedQuery) return;
    const timer = window.setTimeout(() => setAppliedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [query, appliedQuery]);

  const loadMore = async () => {
    if (!scope || !list || list.nextCursor === null) return;
    const result = await window.hemiVoice?.listMemoryEntries({ scope, query: list.query, cursor: list.nextCursor, limit: 50 }).catch(() => null);
    if (!result?.ok || !result.data) {
      showToast(`没加载出来：${reasonOf(result, '读取失败')}`, { tone: 'err' });
      return;
    }
    const data = result.data;
    setList((prev) => (prev && prev.scopeKey === scopeKey
      ? { ...prev, entries: [...prev.entries, ...data.entries.filter((e) => !prev.entries.some((p) => p.id === e.id))], nextCursor: data.nextCursor, total: data.total }
      : prev));
  };

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  useEffect(() => {
    void window.hemiVoice?.getWorkspaceState?.().then((state: WorkspaceState | undefined) => {
      if (!state) return;
      const options: WorkspaceOption[] = [
        { id: state.default.id, name: state.default.name || '默认空间', tag: '默认', movable: true, moveHint: '没有选项目时的对话' },
        ...state.projects.filter((p) => p.status === 'ok').map((p) => ({ id: p.id, name: p.name, movable: true, moveHint: '只在这个工作区用到' })),
        ...state.projects.filter((p) => p.status === 'missing').map((p) => ({
          id: p.id,
          name: p.name,
          tag: '已移除' as const,
          movable: false,
          moveHint: '',
          note: '这个项目已从 Hemi 移除，记忆还留着。新任务不会用到，不需要可以清空。',
        })),
      ];
      setWorkspaces(options);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    void window.hemiVoice?.getMemoryStatus?.().then((status: MemoryStatus | undefined) => {
      setExitSummary((prev) => ({ ...prev, on: status?.exitSummaryEnabled ?? true }));
    }).catch(() => {
      setExitSummary((prev) => ({ ...prev, on: true }));
    });
  }, []);

  // 「刚刚同步」→「HH:MM 同步」：每分钟刷新一次显示。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 外部变更：编辑中只出提示条；否则静默刷新并闪变化的行。
  const editorOpen = editor !== null;
  useEffect(() => {
    const unsubscribe = window.hemiVoice?.onMemoryChanged?.((info: { scopeKey: string | null }) => {
      if (localBusy.current > 0) return;
      void refreshCounts();
      if (info.scopeKey && scopeKey && info.scopeKey !== scopeKey) return;
      if (editorOpen) setExternal(true);
      else void load('silent');
    });
    return () => unsubscribe?.();
  }, [scopeKey, editorOpen, load, refreshCounts]);

  // ---------------------------------------------------------------- 草稿与离开守卫

  const editorDirty = !!editor && (editor.title !== editor.baseTitle || editor.body !== editor.baseBody);
  const dirty = editorDirty || (rawOpen && rawDirty);

  const editorRef = useRef(editor);
  editorRef.current = editor;

  const saveEditorRef = useRef<() => Promise<boolean>>(async () => true);

  /** 有未保存修改时先弹三选一；proceed 在「放弃」或「保存成功」后执行。 */
  const guard = useCallback((proceed: () => void, onStay?: () => void) => {
    if (!dirty) {
      proceed();
      return;
    }
    setDialogError('');
    setDialog({ kind: 'leave', onLeave: proceed, onStay });
  }, [dirty]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    draftProbe = () => dirtyRef.current;
    leaveGuard = () => new Promise<boolean>((resolve) => {
      if (!dirtyRef.current) {
        resolve(true);
        return;
      }
      setDialogError('');
      setDialog({ kind: 'leave', onLeave: () => resolve(true), onStay: () => resolve(false) });
    });
    return () => {
      draftProbe = null;
      leaveGuard = null;
    };
  }, []);

  const resetForScopeChange = () => {
    setEditor(null);
    setExternal(false);
    setExpanded(new Set());
    setQuery('');
    setAppliedQuery('');
    setRawOpen(false);
    setRawDirty(false);
  };

  const switchTab = (next: ScopeTab) => {
    if (next === tab) return;
    guard(() => {
      resetForScopeChange();
      setTab(next);
    });
  };

  const switchWorkspace = (nextId: string) => {
    if (nextId === workspaceId && tab === 'workspace') return;
    guard(() => {
      resetForScopeChange();
      setTab('workspace');
      setWorkspaceId(nextId);
    });
  };

  // ---------------------------------------------------------------- 「查看」定位（来自对话提示）

  const applyFocus = useCallback((target: { scopeKey: string | null; title: string | null } | null) => {
    if (!target?.scopeKey) return;
    const next = scopeFromKey(target.scopeKey);
    if (!next) return;
    focusTarget.current = target;
    guard(() => {
      resetForScopeChange();
      if (next.kind === 'global') setTab(next.target);
      else {
        setTab('workspace');
        setWorkspaceId(next.workspaceId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard]);

  useEffect(() => {
    applyFocus(takeMemoryFocus());
    return onMemoryFocusRequest(() => applyFocus(takeMemoryFocus()));
  }, [applyFocus]);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target || !list || list.scopeKey !== target.scopeKey) return;
    focusTarget.current = null;
    const hit = target.title ? list.entries.find((e) => e.title === target.title) : null;
    if (!hit) return;
    setExpanded((prev) => new Set(prev).add(hit.id));
    flash([hit.id]);
    window.setTimeout(() => entryRefs.current.get(hit.id)?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }), 60);
  }, [list, flash]);

  // ---------------------------------------------------------------- 编辑

  const openEditor = (entry: MemoryEntryView | null) => {
    const start = () => {
      setMenu(null);
      setEditor(entry
        ? { id: entry.id, baseTitle: entry.title, baseBody: entry.body, title: entry.title, body: entry.body, expectedVersion: entry.version }
        : { id: 'new', baseTitle: '', baseBody: '', title: '', body: '' });
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    };
    if (editor && editor.id !== (entry?.id ?? 'new')) guard(start);
    else start();
  };

  const saveEditor = useCallback(async (override?: Partial<EditorState>): Promise<boolean> => {
    const current = editorRef.current ? { ...editorRef.current, ...override } : null;
    if (!current || !scope) return false;
    const title = current.title.trim();
    if (!title) {
      setEditor({ ...current, error: '标题不能为空' });
      return false;
    }
    setEditor({ ...current, saving: true, error: '' });
    try {
      const result: MemoryMutationResult | undefined = await mutate(() => window.hemiVoice.mutateMemoryEntry(current.id === 'new'
        ? { scope, action: 'add', title, body: current.body }
        : { scope, action: 'replace', entryId: current.id, expectedVersion: current.expectedVersion, title, body: current.body }));
      if (result?.ok) {
        const saved = (result.data as { entry?: MemoryEntryView } | undefined)?.entry;
        setEditor(null);
        await load('silent');
        void refreshCounts();
        if (saved?.id) {
          flash([saved.id]);
          if (saved.body) setExpanded((prev) => new Set(prev).add(saved.id));
        }
        return true;
      }
      if (result?.code === 'conflict' && result.current && typeof result.current === 'object') {
        const latest = result.current as MemoryEntryView;
        setEditor({ ...current, saving: false, conflict: { title: latest.title, body: latest.body, version: latest.version, updatedAt: latest.updatedAt, shown: false } });
        return false;
      }
      setEditor({ ...current, saving: false, error: `没保存上：${reasonOf(result, '保存失败')}。草稿还在。` });
      return false;
    } catch (error) {
      setEditor({ ...current, saving: false, error: `没保存上：${errorText(error)}。草稿还在。` });
      return false;
    }
  }, [scope, mutate, load, refreshCounts, flash]);
  saveEditorRef.current = () => saveEditor();

  const cancelEditor = () => {
    if (editorDirty) guard(() => setEditor(null), () => titleInputRef.current?.focus());
    else setEditor(null);
  };

  // ---------------------------------------------------------------- 条目动作

  const removeLocally = (entryId: string) => {
    setList((prev) => (prev ? { ...prev, entries: prev.entries.filter((e) => e.id !== entryId), total: Math.max(0, prev.total - 1) } : prev));
  };

  const doDelete = async (entry: MemoryEntryView) => {
    if (!scope) return;
    setDialogBusy(true);
    setDialogError('');
    try {
      const result = await mutate(() => window.hemiVoice.forgetMemoryEntry({ scope, entryId: entry.id, expectedVersion: entry.version }));
      if (!result?.ok) {
        setDialogError(result?.code === 'conflict' ? '这条记忆刚在别处改过，没有删除。刷新后再试。' : `没删掉：${reasonOf(result, '删除失败')}`);
        return;
      }
      setDialog(null);
      await collapseOut(entryRefs.current.get(entry.id));
      removeLocally(entry.id);
      void refreshCounts();
      const operationId = result.operationId;
      showToast(`已删除「${entry.title}」`, operationId ? {
        undo: async () => {
          const undone = await mutate(() => window.hemiVoice.undoMemoryMutation({ operationId }));
          setToast(null);
          if (undone?.ok) {
            await load('silent');
            void refreshCounts();
            const restored = (undone.data as { entry?: { id?: string } } | undefined)?.entry?.id;
            if (restored) flash([restored]);
          } else {
            showToast(`没撤销成功：${reasonOf(undone, '撤销失败')}`, { tone: 'err' });
          }
        },
      } : {});
    } catch (error) {
      setDialogError(`没删掉：${errorText(error)}`);
    } finally {
      setDialogBusy(false);
    }
  };

  const doMove = async (entry: MemoryEntryView, targetKey: string) => {
    const toScope = scopeFromKey(targetKey);
    if (!scope || !toScope) return;
    setDialogBusy(true);
    setDialogError('');
    try {
      const result = await mutate(() => window.hemiVoice.moveMemoryEntry({ fromScope: scope, entryId: entry.id, expectedVersion: entry.version, toScope }));
      if (!result?.ok) {
        setDialogError(result?.code === 'conflict' ? '这条记忆刚在别处改过，没有移动。刷新后再试。' : `没移过去：${reasonOf(result, '移动失败')}`);
        return;
      }
      setDialog(null);
      await collapseOut(entryRefs.current.get(entry.id));
      removeLocally(entry.id);
      void refreshCounts();
      const operationId = result.operationId;
      const moved = (result.data as { entry?: MemoryEntryView } | undefined)?.entry;
      showToast(`已把「${entry.title}」移到「${labelOfKey(targetKey)}」`, operationId ? {
        undo: async () => {
          // 撤销＝反向移动一次（store 的 undo 覆盖 move），带移动后的版本防覆盖。
          const undone = await mutate(() => window.hemiVoice.undoMemoryMutation({ operationId, expectedAfterVersion: moved?.version }));
          setToast(null);
          if (undone?.ok) {
            await load('silent');
            void refreshCounts();
            flash([entry.id]);
          } else {
            showToast(undone?.code === 'conflict' ? '没法撤销：它在新范围里又被改过' : `没撤销成功：${reasonOf(undone, '撤销失败')}`, { tone: 'err' });
          }
        },
      } : {});
    } catch (error) {
      setDialogError(`没移过去：${errorText(error)}`);
    } finally {
      setDialogBusy(false);
    }
  };

  const doClear = async (count: number, revision: number) => {
    if (!scope) return;
    setDialogBusy(true);
    setDialogError('');
    try {
      const result = await mutate(() => window.hemiVoice.clearMemoryScope({ scope, expectedRevision: revision }));
      if (!result?.ok) {
        setDialogError(result?.code === 'conflict' ? '这个范围刚有新变更，没有清空。刷新后确认条数再试。' : `没清空：${reasonOf(result, '清空失败')}`);
        return;
      }
      setDialog(null);
      const nodes = Array.from(entryRefs.current.values());
      await Promise.all(nodes.map((node) => collapseOut(node)));
      await load('silent');
      void refreshCounts();
      showToast(`已清空「${scopeLabel}」的 ${count} 条记忆`);
    } catch (error) {
      setDialogError(`没清空：${errorText(error)}`);
    } finally {
      setDialogBusy(false);
    }
  };

  const copyEntry = async (entry: MemoryEntryView) => {
    // 2026-10-08：复制走主进程桥（页面剪贴板被权限闸门拦，此前实际是坏的）。
    const ok = await copyTextViaBridge(entry.body ? `${entry.title}\n${entry.body}` : entry.title);
    showToast(ok ? '已复制' : '没复制成功', ok ? {} : { tone: 'err' });
  };

  // ---------------------------------------------------------------- 开关

  const setSwitch = async (target: boolean) => {
    const previous = exitSummary.on ?? true;
    setExitSummary((prev) => ({ ...prev, on: target, pending: true, saved: false, error: '', lastTarget: target }));
    const slow = window.setTimeout(() => setExitSummary((prev) => (prev.pending ? { ...prev, showPending: true } : prev)), 300);
    try {
      const status = await window.hemiVoice?.setMemoryExitSummary({ enabled: target });
      const confirmed = status?.exitSummaryEnabled ?? target;
      setExitSummary((prev) => ({ ...prev, on: confirmed, pending: false, showPending: false, saved: confirmed === target, error: confirmed === target ? '' : '没保存上，已恢复原来的设置' }));
    } catch (error) {
      // 失败滑回原值并写明原因，不假装成功（R-16/AC-16）。
      setExitSummary((prev) => ({ ...prev, on: previous, pending: false, showPending: false, saved: false, error: `没保存上：${errorText(error)}` }));
    } finally {
      window.clearTimeout(slow);
    }
  };

  useEffect(() => {
    if (!exitSummary.saved) return;
    const timer = window.setTimeout(() => setExitSummary((prev) => ({ ...prev, saved: false })), 2000);
    return () => window.clearTimeout(timer);
  }, [exitSummary.saved]);

  // ---------------------------------------------------------------- fixtures 预设

  useEffect(() => {
    if (!preset || presetApplied.current || !list || list.scopeKey !== scopeKey) return;
    presetApplied.current = true;
    const byTitle = (title: string) => list.entries.find((e) => e.title === title) ?? null;
    if (preset.expanded?.length) {
      setExpanded(new Set(preset.expanded.map((t) => byTitle(t)?.id).filter((id): id is string => !!id)));
    }
    if (preset.editor) {
      if ('add' in preset.editor) {
        setEditor({ id: 'new', baseTitle: '', baseBody: '', title: preset.editor.draftTitle ?? '', body: preset.editor.draftBody ?? '' });
      } else {
        const hit = byTitle(preset.editor.title);
        if (hit) {
          const conflict = preset.editor.conflict;
          setEditor({
            id: hit.id,
            baseTitle: hit.title,
            baseBody: hit.body,
            title: preset.editor.draftTitle ?? hit.title,
            body: preset.editor.draftBody ?? hit.body,
            expectedVersion: hit.version,
            conflict: conflict ? { title: conflict.title, body: conflict.body, version: hit.version + 1, updatedAt: Date.now() - 4 * 60_000, shown: true } : null,
          });
        }
      }
    }
    if (preset.external) setExternal(true);
    if (preset.raw) setRawOpen(true);
    if (preset.switchError) setExitSummary((prev) => ({ ...prev, error: preset.switchError ?? '' }));
    if (preset.toast) showToast(preset.toast.text, preset.toast.undo ? { undo: async () => setToast(null) } : {});
    if (preset.dialog === 'clear') setDialog({ kind: 'clear', count: list.total, revision: list.revision });
    else if (preset.dialog === 'leave') setDialog({ kind: 'leave', onLeave: () => {} });
    else if (preset.dialog && 'delete' in preset.dialog) {
      const hit = byTitle(preset.dialog.delete);
      if (hit) setDialog({ kind: 'delete', entry: hit });
    } else if (preset.dialog && 'move' in preset.dialog) {
      const hit = byTitle(preset.dialog.move);
      if (hit) setDialog({ kind: 'move', entry: hit, target: preset.dialog.to ?? null });
    }
    if (preset.menu) {
      window.setTimeout(() => {
        if (preset.menu === 'page' || preset.menu === 'ws') {
          const anchor = document.querySelector<HTMLElement>(preset.menu === 'page' ? '[data-mem-trigger="page"]' : '[data-mem-trigger="ws"]');
          if (anchor) setMenu({ kind: preset.menu, anchor });
        } else if (preset.menu) {
          const hit = byTitle(preset.menu.entry);
          const anchor = hit ? entryRefs.current.get(hit.id)?.querySelector<HTMLElement>('[data-mem-trigger="entry"]') : null;
          if (hit && anchor) setMenu({ kind: 'entry', anchor, entry: hit });
        }
      }, 60);
    }
  }, [preset, list, scopeKey, showToast]);

  // ---------------------------------------------------------------- 渲染片段

  const ready = list && list.scopeKey === scopeKey && list.query === appliedQuery ? list : null;
  const shownList = ready ?? (list && list.scopeKey === scopeKey ? list : null);
  const error = loadError && loadError.scopeKey === scopeKey ? loadError : null;
  const total = shownList?.total ?? 0;
  const syncedLabel = shownList
    ? (now - shownList.syncedAt < 60_000 ? '刚刚同步' : `${formatMemoryTime(shownList.syncedAt, now).replace(/^今天 /, '')} 同步`)
    : '';

  const moveOptions = useMemo(() => {
    const options: Array<{ key: string; name: string; hint: string }> = [
      { key: 'global/user', name: SCOPE_LABELS.user, hint: '你的称呼、习惯和偏好' },
      { key: 'global/facts', name: SCOPE_LABELS.facts, hint: '所有工作区都会用到' },
      ...workspaces.filter((w) => w.movable).map((w) => ({ key: `workspace/${w.id}`, name: w.name, hint: w.moveHint })),
    ];
    return options;
  }, [workspaces]);

  const renderEditor = () => {
    if (!editor) return null;
    const isNew = editor.id === 'new';
    const stateText = editorDirty ? '未保存' : isNew ? `保存到「${scopeLabel}」` : '没有改动';
    const canSave = editorDirty && !!editor.title.trim() && !editor.saving;
    return (
      <div className="h37-mem-editor" role="form" aria-label={isNew ? '添加记忆' : '编辑记忆'} key={`editor-${editor.id}`}>
        {editor.conflict ? (
          <div className="h37-mem-banner" data-tone="warn" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="h37-mem-grow">这条记忆已更新，你的修改尚未保存。</span>
            <span className="h37-mem-banner-acts">
              <button type="button" className="h37-btn h37-btn-sm" onClick={() => setEditor({ ...editor, conflict: editor.conflict ? { ...editor.conflict, shown: !editor.conflict.shown } : null })}>
                {editor.conflict.shown ? '收起最新内容' : '查看最新内容'}
              </button>
              <button
                type="button"
                className="h37-btn h37-btn-sm"
                onClick={() => {
                  const latest = editor.conflict;
                  if (!latest) return;
                  setEditor({ ...editor, baseTitle: latest.title, baseBody: latest.body, title: latest.title, body: latest.body, expectedVersion: latest.version, conflict: null });
                }}
              >
                用最新内容
              </button>
              <button
                type="button"
                className="h37-btn h37-btn-sm h37-mem-strong"
                disabled={editor.saving}
                onClick={() => void saveEditor({ expectedVersion: editor.conflict?.version, conflict: null })}
              >
                保留我的修改并保存
              </button>
            </span>
            <div className="h37-collapse h37-mem-latest" data-open={editor.conflict.shown}>
              <div>
                <div className="h37-mem-latest-body">
                  <b>{editor.conflict.title}</b>
                  {editor.conflict.body ? <p>{editor.conflict.body}</p> : null}
                  <span>{formatMemoryTime(editor.conflict.updatedAt)} 在别处更新</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <input
          ref={titleInputRef}
          className="h37-input h37-mem-title-input"
          value={editor.title}
          maxLength={TITLE_MAX}
          placeholder="标题（一句话）"
          aria-label="记忆标题"
          onChange={(event) => setEditor({ ...editor, title: event.target.value, error: '' })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSave) void saveEditor();
            } else if (event.key === 'Escape' && !editorDirty) {
              event.preventDefault();
              setEditor(null);
            }
          }}
        />
        <textarea
          className="h37-textarea h37-mem-body-input"
          value={editor.body}
          maxLength={BODY_MAX}
          rows={3}
          spellCheck={false}
          placeholder="补充说明（可留空）"
          aria-label="记忆正文"
          onChange={(event) => setEditor({ ...editor, body: event.target.value, error: '' })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (canSave) void saveEditor();
            } else if (event.key === 'Escape' && !editorDirty) {
              event.preventDefault();
              setEditor(null);
            }
          }}
        />
        {editor.error ? <p className="h37-error-text" role="alert">{editor.error}</p> : null}
        <div className="h37-mem-editor-foot">
          <span className="h37-mem-state" data-dirty={editorDirty || undefined}>{stateText}</span>
          <span className="h37-mem-grow" />
          <span className="h37-mem-count">{editor.body.length} / {BODY_MAX}</span>
          <button type="button" className="h37-btn h37-btn-ghost" onClick={cancelEditor}>取消</button>
          <button type="button" className="h37-btn h37-btn-primary" data-primary="true" disabled={!canSave} onClick={() => void saveEditor()}>
            {editor.saving ? '保存中…' : isNew ? '添加' : '保存'}
          </button>
        </div>
      </div>
    );
  };

  const renderEntry = (entry: MemoryEntryView) => {
    if (editor && editor.id === entry.id) return renderEditor();
    const open = expanded.has(entry.id);
    const kind = KIND_LABELS[entry.kind];
    const when = formatMemoryTime(entry.updatedAt, now);
    const source = describeSource(entry.sourceRefs);
    const q = shownList?.query ?? '';
    return (
      <div
        key={entry.id}
        ref={(node) => {
          if (node) entryRefs.current.set(entry.id, node);
          else entryRefs.current.delete(entry.id);
        }}
        className={`h37-mem-entry${flashIds.has(entry.id) ? ' h37-flash' : ''}`}
        data-open={open || undefined}
        data-entry-id={entry.id}
      >
        <div className="h37-mem-entry-top">
          <button
            type="button"
            className="h37-mem-entry-head"
            aria-expanded={open}
            onClick={() => setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(entry.id)) next.delete(entry.id);
              else next.add(entry.id);
              return next;
            })}
          >
            <ChevronDown className="h37-mem-chev" aria-hidden="true" />
            <span className="h37-mem-entry-t">
              <b>{highlight(entry.title, q)}</b>
              <span>
                {kind ? <i className="h37-tag h37-mem-tag">{kind}</i> : null}
                {when}
                {entry.body ? <span className="h37-mem-more"> · 有补充说明</span> : null}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="h37-btn h37-btn-ghost h37-btn-icon h37-mem-icon"
            aria-label={`编辑「${entry.title}」`}
            title="编辑"
            onClick={() => openEditor(entry)}
          >
            <Pencil aria-hidden="true" />
          </button>
          <button
            type="button"
            className="h37-btn h37-btn-ghost h37-btn-icon h37-mem-icon"
            aria-label={`「${entry.title}」的更多操作`}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'entry' && menu.entry.id === entry.id}
            data-mem-trigger="entry"
            title="更多"
            onClick={(event) => setMenu({ kind: 'entry', anchor: event.currentTarget, entry })}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
        <div className="h37-collapse" data-open={open}>
          <div>
            <div className="h37-mem-entry-body">
              {entry.body ? <p>{highlight(entry.body, q)}</p> : null}
              <span className="h37-mem-src">{renderSource(source ?? '手动添加')} · 更新于 {when}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderLoose = () => {
    if (tab !== 'facts' || !shownList || shownList.looseCount <= 0 || appliedQuery) return null;
    return (
      <div className="h37-group h37-mem-loose">
        <div className="h37-row">
          <span className="h37-tile"><Inbox aria-hidden="true" /></span>
          <span className="h37-row-text">
            <b>{shownList.looseCount} 条旧内容待整理</b>
            <span>迁移自旧版全局记忆。归类之前，任何工作区都不会用到它们。</span>
          </span>
          <span className="h37-row-end">
            <button type="button" className="h37-btn h37-btn-secondary" onClick={() => guard(() => { setEditor(null); setRawOpen(true); })}>整理</button>
          </span>
        </div>
      </div>
    );
  };

  const renderList = () => {
    if (error) {
      return (
        <div className="h37-group h37-enter" key={`err-${scopeKey}`}>
          <div className="h37-mem-state-box" data-tone="err" role="alert">
            <span className="h37-tile"><CircleAlert aria-hidden="true" /></span>
            <b>「{scopeLabel}」的记忆没读出来</b>
            <span>{error.message}。你的记忆还在，稍后再试一次。</span>
            <button type="button" className="h37-btn h37-btn-secondary" onClick={() => void load('switch')}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </div>
        </div>
      );
    }
    if (!shownList) {
      if (!showSkeleton) return <div className="h37-mem-placeholder" aria-hidden="true" />;
      return (
        <div key="sk" aria-busy="true">
          <div className="h37-mem-list-meta">读取中……</div>
          <div className="h37-group">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h37-mem-sk">
                <i className="h37-skeleton" />
                <i className="h37-skeleton" />
              </div>
            ))}
          </div>
        </div>
      );
    }
    const searching = !!shownList.query.trim();
    const adding = editor?.id === 'new';
    let body: ReactNode;
    if (!shownList.entries.length && !adding) {
      body = searching ? (
        <div className="h37-mem-state-box">
          <b>没有找到「{shownList.query}」</b>
          <span>只搜了「{scopeLabel}」。换个词，或切到其他范围再搜。</span>
          <button type="button" className="h37-btn h37-btn-secondary" onClick={() => { setQuery(''); setAppliedQuery(''); }}>清除搜索</button>
        </div>
      ) : (
        <div className="h37-mem-state-box">
          <span className="h37-tile" data-tone="g"><Brain aria-hidden="true" /></span>
          <b>「{scopeLabel}」还没有记忆</b>
          <span>对话里说「记住……」会存在这里；也可以手动添加。</span>
          <button type="button" className="h37-btn h37-btn-secondary" onClick={() => openEditor(null)}>
            <Plus aria-hidden="true" />
            添加记忆
          </button>
        </div>
      );
    } else {
      body = (
        <>
          {adding ? renderEditor() : null}
          {shownList.entries.map(renderEntry)}
        </>
      );
    }
    return (
      <div className="h37-enter" key={`list-${shownList.scopeKey}`}>
        <div className="h37-mem-list-meta">
          <span>{searching ? `找到 ${shownList.total} 条` : `${shownList.total} 条`} · {syncedLabel}</span>
          <span className="h37-mem-grow" />
          <button type="button" className="h37-mem-refresh" data-spin={refreshing || undefined} title="重新读取" onClick={() => void load('refresh')}>
            <RefreshCw aria-hidden="true" />
            刷新
          </button>
        </div>
        {external ? (
          <div className="h37-mem-banner" data-tone="info" role="status">
            <RefreshCw aria-hidden="true" />
            <span className="h37-mem-grow">此范围在别处有新变更。你正在编辑，列表没有自动刷新。</span>
            <button type="button" className="h37-btn h37-btn-sm" onClick={() => guard(() => { setEditor(null); void load('refresh'); })}>刷新</button>
          </div>
        ) : null}
        {tab === 'workspace' && workspace?.note ? (
          <div className="h37-mem-banner" data-tone="info">
            <CircleAlert aria-hidden="true" />
            <span className="h37-mem-grow">{workspace.note}</span>
          </div>
        ) : null}
        <div className="h37-group h37-mem-entries">{body}</div>
        {shownList.nextCursor !== null ? (
          <div className="h37-mem-more-row">
            <button type="button" className="h37-btn h37-btn-ghost" onClick={() => void loadMore()}>
              加载更多（还有 {Math.max(0, shownList.total - shownList.entries.length)} 条）
            </button>
          </div>
        ) : null}
        {renderLoose()}
      </div>
    );
  };

  const renderSwitch = () => (
    <section className="h37-section h37-mem-switch">
      <div className="h37-section-head"><h3>自动记录</h3></div>
      <div className="h37-group">
        <div className="h37-row">
          <span className="h37-row-text">
            <b>任务收尾记忆摘要</b>
            <span>结束后整理工作记录，并提炼适用的任务经验。关闭后已保存的记忆不受影响。</span>
          </span>
          <span className="h37-row-end">
            {exitSummary.showPending ? (
              <span className="h37-saved"><i className="h37-spinner" aria-hidden="true" />保存中</span>
            ) : (
              <span className="h37-saved" data-state={exitSummary.saved ? undefined : 'hidden'} aria-hidden={!exitSummary.saved}>
                <Check aria-hidden="true" />已保存
              </span>
            )}
            <button
              type="button"
              role="switch"
              className="h37-switch"
              aria-checked={exitSummary.on ?? true}
              aria-label="任务收尾记忆摘要"
              disabled={exitSummary.pending || exitSummary.on === null}
              onClick={() => void setSwitch(!(exitSummary.on ?? true))}
            />
          </span>
        </div>
      </div>
      {exitSummary.error ? (
        <div className="h37-mem-sw-err" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{exitSummary.error}</span>
          <button type="button" onClick={() => void setSwitch(exitSummary.lastTarget ?? !(exitSummary.on ?? true))}>重试</button>
        </div>
      ) : null}
    </section>
  );

  const renderMenu = () => {
    if (!menu) return null;
    if (menu.kind === 'page') {
      return (
        <MemoryMenu
          anchor={menu.anchor}
          label="记忆页更多操作"
          onClose={() => setMenu(null)}
          items={[
            { kind: 'item', label: '查看原文（高级）', icon: <Code aria-hidden="true" />, onSelect: () => guard(() => { setEditor(null); setRawOpen(true); }) },
            { kind: 'item', label: '打开记忆目录', icon: <FolderOpen aria-hidden="true" />, onSelect: () => void window.hemiVoice?.openMemoryDirectory() },
            { kind: 'sep' },
            {
              kind: 'item',
              label: '清空此范围…',
              icon: <Trash2 aria-hidden="true" />,
              danger: true,
              disabled: !ready || ready.total === 0 || !!ready.query,
              onSelect: () => {
                if (!ready) return;
                setDialogError('');
                setDialog({ kind: 'clear', count: ready.total, revision: ready.revision });
              },
            },
          ]}
        />
      );
    }
    if (menu.kind === 'ws') {
      return (
        <MemoryMenu
          anchor={menu.anchor}
          label="选择工作区"
          onClose={() => setMenu(null)}
          items={[
            ...workspaces.map<MenuItem>((w) => ({
              kind: 'item',
              label: w.name,
              icon: <Folder aria-hidden="true" />,
              tag: w.tag,
              current: w.id === workspaceId,
              onSelect: () => switchWorkspace(w.id),
            })),
            { kind: 'foot', text: '只是查看，不会改变当前对话所在的工作区。' },
          ]}
        />
      );
    }
    const entry = menu.entry;
    return (
      <MemoryMenu
        anchor={menu.anchor}
        label={`「${entry.title}」的更多操作`}
        onClose={() => setMenu(null)}
        items={[
          { kind: 'item', label: '移到其他范围…', icon: <ArrowRight aria-hidden="true" />, onSelect: () => { setDialogError(''); setDialog({ kind: 'move', entry, target: null }); } },
          { kind: 'item', label: '复制内容', icon: <Copy aria-hidden="true" />, onSelect: () => void copyEntry(entry) },
          { kind: 'sep' },
          { kind: 'item', label: '删除…', icon: <Trash2 aria-hidden="true" />, danger: true, onSelect: () => { setDialogError(''); setDialog({ kind: 'delete', entry }); } },
        ]}
      />
    );
  };

  const renderDialog = () => {
    if (!dialog) return null;
    const errorLine = dialogError ? <p className="h37-error-text h37-mem-dialog-error" role="alert">{dialogError}</p> : null;
    if (dialog.kind === 'delete') {
      return (
        <MemoryDialog
          labelledBy="mem-dialog-delete"
          title={`删除「${dialog.entry.title}」？`}
          onCancel={() => setDialog(null)}
          foot={(
            <>
              <button type="button" className="h37-btn h37-btn-secondary" onClick={() => setDialog(null)}>取消</button>
              <button type="button" className="h37-btn h37-btn-danger-solid" data-primary="true" disabled={dialogBusy} onClick={() => void doDelete(dialog.entry)}>删除</button>
            </>
          )}
        >
          <p>从「{scopeLabel}」移除这条记忆，并清理工作记录里与它相关的片段。原始聊天与任务档案会保留。</p>
          {errorLine}
        </MemoryDialog>
      );
    }
    if (dialog.kind === 'move') {
      const target = moveOptions.find((o) => o.key === dialog.target) ?? null;
      return (
        <MemoryDialog
          labelledBy="mem-dialog-move"
          title={`把「${dialog.entry.title}」移到`}
          onCancel={() => setDialog(null)}
          foot={(
            <>
              <button type="button" className="h37-btn h37-btn-secondary" onClick={() => setDialog(null)}>取消</button>
              <button
                type="button"
                className="h37-btn h37-btn-primary"
                data-primary="true"
                disabled={!target || dialogBusy}
                onClick={() => target && void doMove(dialog.entry, target.key)}
              >
                {target ? `移到「${target.name}」` : '移动'}
              </button>
            </>
          )}
        >
          <p>移动后，只有目标范围里的任务会用到它。</p>
          <div className="h37-mem-opts" role="radiogroup" aria-label="目标范围">
            {moveOptions.map((option) => {
              const current = option.key === scopeKey;
              return (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  className="h37-mem-opt"
                  aria-checked={dialog.target === option.key}
                  disabled={current}
                  onClick={() => setDialog({ ...dialog, target: option.key })}
                >
                  <span className="h37-mem-radio" aria-hidden="true" />
                  <span className="h37-mem-opt-t">
                    <b>{option.name}{current ? '（当前）' : ''}</b>
                    <span>{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {errorLine}
        </MemoryDialog>
      );
    }
    if (dialog.kind === 'clear') {
      return (
        <MemoryDialog
          labelledBy="mem-dialog-clear"
          title={`清空「${scopeLabel}」记忆？`}
          onCancel={() => setDialog(null)}
          foot={(
            <>
              <button type="button" className="h37-btn h37-btn-secondary" data-primary="true" onClick={() => setDialog(null)}>取消</button>
              <button type="button" className="h37-btn h37-btn-danger-solid" disabled={dialogBusy} onClick={() => void doClear(dialog.count, dialog.revision)}>
                清空 {dialog.count} 条
              </button>
            </>
          )}
        >
          <p>之后的新任务将不再使用这些约定和经验（共 {dialog.count} 条）。其他范围、原始聊天与任务档案会保留。清空后不能撤销。</p>
          {errorLine}
        </MemoryDialog>
      );
    }
    const leave = dialog;
    const stay = () => {
      setDialog(null);
      leave.onStay?.();
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    };
    return (
      <MemoryDialog
        labelledBy="mem-dialog-leave"
        title="还有修改没保存"
        onCancel={stay}
        foot={(
          <>
            <button
              type="button"
              className="h37-btn h37-btn-danger h37-start"
              onClick={() => {
                setDialog(null);
                setEditor(null);
                setRawDirty(false);
                leave.onLeave();
              }}
            >
              放弃修改
            </button>
            <button type="button" className="h37-btn h37-btn-secondary" onClick={stay}>继续编辑</button>
            <button
              type="button"
              className="h37-btn h37-btn-primary"
              data-primary="true"
              disabled={dialogBusy}
              onClick={async () => {
                setDialogBusy(true);
                const saved = editorDirty ? await saveEditorRef.current() : await (rawSaveRef.current?.() ?? Promise.resolve(true));
                setDialogBusy(false);
                setDialog(null);
                if (saved) {
                  setRawDirty(false);
                  leave.onLeave();
                } else {
                  leave.onStay?.();
                }
              }}
            >
              保存并离开
            </button>
          </>
        )}
      >
        <p>{rawOpen && rawDirty && !editorDirty ? '原文的修改还没保存，' : `「${editor?.title.trim() || '新记忆'}」的修改还没保存，`}离开后会丢失。</p>
      </MemoryDialog>
    );
  };

  // ---------------------------------------------------------------- 页面

  if (rawOpen) {
    return (
      <div className="h37-mem">
        <RawView
          scopeKey={scopeKey}
          scopeLabel={scopeLabel}
          saveRef={rawSaveRef}
          onDirtyChange={setRawDirty}
          onBack={() => guard(() => { setRawOpen(false); setRawDirty(false); void load('silent'); })}
          onSaved={() => { void load('silent'); void refreshCounts(); }}
        />
        {renderDialog()}
        {toast ? <MemoryToast key={toast.id} toast={toast} onDone={dismissToast} /> : null}
      </div>
    );
  }

  const factsCount = counts.facts === null ? null : `${counts.facts}${counts.loose ? ` · ${counts.loose} 待整理` : ''}`;

  return (
    <div className="h37-mem">
      <div className="h37-mem-scopebar">
        <div className="h37-seg h37-mem-seg" role="tablist" aria-label="内容范围">
          {(['user', 'facts', 'workspace'] as const).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} aria-pressed={tab === key} onClick={() => switchTab(key)}>
              {key === 'workspace' ? '工作区记忆' : SCOPE_LABELS[key]}
              {key === 'user' && counts.user !== null ? <span className="h37-count">{counts.user}</span> : null}
              {key === 'facts' && factsCount !== null ? <span className="h37-count">{factsCount}</span> : null}
            </button>
          ))}
        </div>
        {tab === 'workspace' ? (
          <button
            type="button"
            className="h37-mem-ws-pick"
            aria-label="选择工作区"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'ws'}
            data-mem-trigger="ws"
            onClick={(event) => setMenu({ kind: 'ws', anchor: event.currentTarget })}
          >
            <Folder aria-hidden="true" />
            <span>{workspace?.name ?? (workspaceId === 'default' ? '默认空间' : workspaceId)}</span>
            {workspace?.tag ? <i className="h37-tag h37-mem-tag">{workspace.tag}</i> : null}
            <ChevronDown className="h37-mem-ws-chev" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="h37-mem-toolbar">
        <label className="h37-input h37-mem-search">
          <Search aria-hidden="true" />
          <input
            className="h37-input-bare"
            type="search"
            value={query}
            placeholder="搜索当前范围"
            aria-label="搜索当前范围的记忆"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setAppliedQuery(query);
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
                setAppliedQuery('');
              }
            }}
          />
        </label>
        <button type="button" className="h37-btn h37-btn-primary h37-mem-add" onClick={() => openEditor(null)} disabled={!!error}>
          <Plus aria-hidden="true" />
          添加记忆
        </button>
        <button
          type="button"
          className="h37-btn h37-btn-ghost h37-btn-icon h37-mem-page-more"
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'page'}
          data-mem-trigger="page"
          title="更多"
          onClick={(event) => setMenu({ kind: 'page', anchor: event.currentTarget })}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </div>

      <div className="h37-mem-list">{renderList()}</div>

      {renderSwitch()}
      {renderMenu()}
      {renderDialog()}
      {toast ? <MemoryToast key={toast.id} toast={toast} onDone={dismissToast} /> : null}
    </div>
  );
}

/** 原文（高级）下钻页：关于你 → USER.md，全局约定 → MEMORY.md；工作区原文只能在目录里打开。 */
function RawView({
  scopeKey,
  scopeLabel,
  saveRef,
  onDirtyChange,
  onBack,
  onSaved,
}: {
  scopeKey: string | null;
  scopeLabel: string;
  saveRef: React.MutableRefObject<(() => Promise<boolean>) | null>;
  onDirtyChange: (dirty: boolean) => void;
  onBack: () => void;
  onSaved: () => void;
}) {
  const target = scopeKey === 'global/user' ? 'user' : scopeKey === 'global/facts' ? 'memory' : null;
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(target ? 'loading' : 'ready');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    if (!target) return;
    setPhase('loading');
    try {
      const state: MemoryState | undefined = await window.hemiVoice?.getMemoryState();
      const doc = state?.documents[target];
      if (!doc || doc.text === null) {
        setPhase('error');
        setError(doc?.issue === 'oversized' ? '文件太大，暂时只能在目录里打开' : '原文读不出来');
        return;
      }
      setOriginal(doc.text);
      setDraft(doc.text);
      setError('');
      setPhase('ready');
    } catch (err) {
      setPhase('error');
      setError(`原文读不出来：${errorText(err)}`);
    }
  }, [target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty = draft !== null && original !== null && draft !== original;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!target || draft === null) return true;
    setSaving(true);
    setError('');
    try {
      const result = await trackLocalMemoryMutation(() => window.hemiVoice.saveMemoryDocument({ target, text: draft, expectedText: original }));
      if (result?.ok) {
        setOriginal(draft);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
        onSaved();
        return true;
      }
      setError(result?.conflict ? '文件已在别处更新，你的草稿没有覆盖它。复制草稿后重新读取再改。' : `没保存上：${result?.error ?? '保存失败'}`);
      return false;
    } catch (err) {
      setError(`没保存上：${errorText(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [target, draft, original, onSaved]);
  saveRef.current = save;
  useEffect(() => () => {
    saveRef.current = null;
  }, [saveRef]);

  return (
    <div className="h37-drill h37-mem-raw-page">
      <button type="button" className="h37-back" onClick={onBack}>
        <ChevronLeft aria-hidden="true" />
        记忆
      </button>
      <div className="h37-mem-raw-head">
        <h3>原文 · {scopeLabel}</h3>
        <p>直接改记忆文件。每条记忆是一个管理块，块外的文字会被当作「待整理」。</p>
      </div>
      <div className="h37-group">
        {target ? (
          phase === 'loading' ? (
            <div className="h37-mem-raw-loading"><i className="h37-skeleton" /><i className="h37-skeleton" /><i className="h37-skeleton" /></div>
          ) : (
            <textarea
              className="h37-mem-raw"
              value={draft ?? ''}
              spellCheck={false}
              readOnly={phase === 'error'}
              aria-label={target === 'user' ? '关于你原文' : '全局约定原文'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (dirty) void save();
                }
              }}
            />
          )
        ) : (
          <div className="h37-mem-state-box">
            <span className="h37-tile"><FolderOpen aria-hidden="true" /></span>
            <b>工作区原文在记忆目录里</b>
            <span>「{scopeLabel}」的原文是 workspaces 目录下对应工作区的 MEMORY.md，可以在记忆目录里直接打开编辑。</span>
          </div>
        )}
        {error ? (
          <div className="h37-mem-raw-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="h37-mem-grow">{error}</span>
            <button type="button" className="h37-btn h37-btn-sm" onClick={() => void reload()}>重新读取</button>
          </div>
        ) : null}
        <div className="h37-mem-raw-foot">
          {target ? (
            <span className="h37-mem-state" data-dirty={dirty || undefined}>{dirty ? '未保存' : saved ? '已保存' : '没有改动'}</span>
          ) : null}
          <span className="h37-mem-grow" />
          <button type="button" className="h37-btn h37-btn-ghost" onClick={() => void window.hemiVoice?.openMemoryDirectory()}>
            <FolderOpen aria-hidden="true" />
            打开记忆目录
          </button>
          {target ? (
            <button type="button" className="h37-btn h37-btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="h37-note h37-mem-raw-note">
        <CircleAlert aria-hidden="true" />
        <span>未加管理块的行会显示为「待整理」，不会自动进入所有工作区。删掉一个管理块等于删除那条记忆。</span>
      </div>
    </div>
  );
}
