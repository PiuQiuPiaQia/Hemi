import {Dialog as PreviewDialog} from '@base-ui/react/dialog';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Workflow,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  ImageIcon,
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  RotateCcw,
  ScrollText,
  Video,
  X,
} from 'lucide-react';

import { Markdown } from '@/shared/markdown';
import type { MessageAttachmentView, TaskActionName, TaskArtifact, TaskStateSnapshot } from '@/shared/types';
import type { ConversationDeliverableView } from '@shared/protocol';
import {
  isPreviewableArtifact,
  previewTabKey,
  type PreviewTabId,
} from '@/windows/voice/lib/preview-tabs';

import { DeliveryBlocks, DeliverySources } from './delivery-view';
import { TaskProcessBody } from './task-process';
import { WorkflowRunPreview } from './workflow-run-preview';
import { WorkflowDefinitionPreview } from './workflow-definition-preview';

/**
 * 027 R-02/05/06＋028 R-03/04：应用内预览面板（多 Tab）。
 *
 * - Tab 身份是可辨识联合（lib/preview-tabs）：成果/报告按 taskId+artifactId
 *   档案寻址，028 消息附件按 conversationId+attachmentId 受控寻址；渲染层不
 *   持路径、不请求任意文件，两种来源共用同一套页签、工具栏与正文渲染器；
 * - 上层是 Tab 列 + `＋`（当前任务成果＋当前会话附件）+ 图标式收起；下层文件
 *   只放重读与可点击来源（附件文件点击受控打开原文件，粘贴图片说明无原文件），
 *   报告只放继续讨论／保存 HTML；
 * - Tab 队列与当前项由上层（VoiceScreen）持有：重复打开按真实身份去重、
 *   关闭当前激活相邻、最后一个关闭收起面板；每个 Tab 保留自己的阅读位置；
 * - Escape 逐个关闭当前 Tab，最后一个 Tab 关闭后收起面板；点击面板外（对话流等）
 *   不收起面板（2026-10-18 用户裁决），收起只走收起按钮；收起/继续讨论回到原对话
 *   位置（面板是覆盖层，对话滚动与草稿不动），收起后焦点回打开它的触发元素；
 * - 失败在面板原位说明原因并提供重试（R-06），不弹无上下文的系统错误；
 * - 宽窗并排、窄窗覆盖主列由 globals.css 的 .h24-preview 媒体查询负责
 *   （≥1180px 并排，阈值待真机复核）。
 */

type PreviewResult = {
  ok: boolean;
  kind?: 'text' | 'image' | 'video' | 'unsupported';
  mediaUrl?: string;
  markdown?: boolean;
  text?: string;
  dataUrl?: string;
  name?: string;
  path?: string;
  size?: number | null;
  message?: string;
};

/** Tab 显示名与图标：成果从任务快照取；附件从登记元数据取；056 执行过程取角色名。 */
function tabMetaOf(
  tab: PreviewTabId,
  snapOf: (taskId: string) => TaskStateSnapshot | undefined,
  attachmentMetaOf: (conversationId: string, attachmentId: string) => MessageAttachmentView | undefined,
  workflowNames: Record<string, string>,
  deliverableMetaOf?: (conversationId: string, artifactId: string) => ConversationDeliverableView | undefined,
) {
  if (tab.kind === 'attachment') {
    const meta = attachmentMetaOf(tab.conversationId, tab.attachmentId);
    return {
      name: meta?.name ?? '附件',
      kind: meta?.kind === 'image' ? ('image' as const) : ('file' as const),
    };
  }
  if (tab.kind === 'deliverable') {
    // 062 会话交付物：元数据来自 flow 投影；链接对象（未登记）无元数据时按 Tab 携带名。
    const meta = deliverableMetaOf?.(tab.conversationId, tab.artifactId);
    return {
      name: meta?.name ?? tab.linkName ?? '文件',
      kind: /\.(mp4|m4v|webm|mov)$/i.test(meta?.name ?? tab.linkName ?? '') ? ('video' as const)
        : meta?.previewKind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(meta?.name ?? tab.linkName ?? '')
        ? ('image' as const)
        : ('file' as const),
    };
  }
  if (tab.kind === 'process') {
    const snap = snapOf(tab.taskId);
    return { name: snap?.agentTitle || snap?.agent || '执行过程', kind: 'process' as const };
  }
  // 059：工作流定义预览（只读步骤结构，正文由 WorkflowDefinitionPreview 渲染）。
  if ((tab.kind === 'workflow-definition' || tab.kind === 'workflow-run')) {
    return { name: workflowNames[previewTabKey(tab)] || (tab.kind === 'workflow-definition' ? '流程预览' : '运行过程'), kind: 'workflow' as const };
  }
  const snap = snapOf(tab.taskId);
  if (tab.artifactId == null) {
    // 050：正文契约的任务这个 Tab 是「宽幅阅读正文」；旧档案回落交付标题。
    return { name: snap?.resultText?.trim() ? '任务正文' : snap?.delivery?.title?.trim() || '任务结果', kind: 'report' as const };
  }
  const artifact = snap?.artifacts?.find((item) => item.id === tab.artifactId) ?? null;
  const ext = artifact?.name?.split('.').pop()?.toLowerCase() ?? '';
  return {
    name: artifact?.name ?? '文件',
    kind: artifact && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
      ? ('image' as const)
      : ('file' as const),
  };
}

function TabIcon({ kind }: { kind: 'report' | 'image' | 'video' | 'file' | 'process' | 'workflow' }) {
  if (kind === 'report') return <ScrollText className="size-3.5" aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon className="size-3.5" aria-hidden="true" />;
  if (kind === 'video') return <Video className="size-3.5" aria-hidden="true" />;
  if (kind === 'workflow') return <Workflow className="size-3.5" aria-hidden="true" />;
  if (kind === 'process') return <Activity className="size-3.5" aria-hidden="true" />;
  return <FileText className="size-3.5" aria-hidden="true" />;
}

function VideoPreview({ url, name, onRetry, onOpen }: { url: string; name: string; onRetry: () => void; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <div className="h37-note h24-preview-error" data-tone="warn" role="note">
      <p>视频读取或解码失败，文件可能已移动，或使用了当前不支持的编码。</p>
      <button type="button" className="h37-btn h37-btn-secondary h37-btn-sm" onClick={onRetry}>重试读取</button>
      <button type="button" className="h37-btn h37-btn-secondary h37-btn-sm" onClick={onOpen}>用系统应用打开</button>
    </div>
  ) : <video className="h62-preview-video" src={url} controls playsInline preload="metadata" aria-label={name} onError={() => setFailed(true)} />;
}

export function FilePreviewPanel({
  tabs,
  activeKey,
  snapOf,
  attachmentMetaOf,
  attachmentOptions = [],
  deliverableMetaOf,
  deliverableOptions = [],
  onActivate,
  onOpenTab,
  onCloseTab,
  onCollapse,
  onContinueDiscuss,
  onTaskAction,
}: {
  /** 打开中的 Tab 队列（有序）。 */
  tabs: PreviewTabId[];
  activeKey: string;
  /** 按任务取快照（报告内容、产物名与路径、＋ 菜单都从这里来）。 */
  snapOf: (taskId: string) => TaskStateSnapshot | undefined;
  /** 028：按会话取附件登记元数据（附件 Tab 的名字、种类与来源）。 */
  attachmentMetaOf: (conversationId: string, attachmentId: string) => MessageAttachmentView | undefined;
  /** 028：＋ 菜单追加的当前会话附件（草稿与已发送都列，按身份去重交给队列）。 */
  attachmentOptions?: PreviewTabId[];
  /** 062：按会话取交付物元数据（flow.artifacts 投影；链接对象不在其中）。 */
  deliverableMetaOf?: (conversationId: string, artifactId: string) => ConversationDeliverableView | undefined;
  /** 062：＋ 菜单追加的当前会话有效交付（主/子 agent 登记过的文件）。 */
  deliverableOptions?: PreviewTabId[];
  onActivate: (key: string) => void;
  /** 打开或激活一个 Tab（去重在上层队列逻辑）。 */
  onOpenTab: (tab: PreviewTabId) => void;
  onCloseTab: (key: string) => void;
  onCollapse: () => void;
  onContinueDiscuss?: (snap: TaskStateSnapshot) => void;
  /** 056：执行过程 Tab 的任务操作（停止）。 */
  onTaskAction?: (action: TaskActionName, payload?: { taskId?: string; taskKey?: string }) => void;
}) {
  const activeTab = tabs.find((tab) => previewTabKey(tab) === activeKey) ?? tabs[0] ?? null;
  const tabKeys = tabs.map(previewTabKey).join('\u0000');
  const [workflowNames, setWorkflowNames] = useState<Record<string, string>>({});
  const workflowNamesRef = useRef(workflowNames);
  useEffect(() => {
    let alive = true;
    for (const tab of tabs) {
      const key = previewTabKey(tab);
      if (workflowNamesRef.current[key]) continue;
      const request = tab.kind === 'workflow-run'
        ? window.hemiVoice.workflowGetInvocation(tab.invocationId)
        : tab.kind === 'workflow-definition'
          ? window.hemiVoice.workflowGetRevision(tab.workflowId, tab.revision) : null;
      if (request) void request.then(record => {
        const name = (record as {name?:string} | null)?.name;
        if (!alive || !name) return;
        workflowNamesRef.current = {...workflowNamesRef.current, [key]:name};
        setWorkflowNames(workflowNamesRef.current);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [tabKeys]);
  const snap = activeTab?.kind === 'artifact' ? snapOf(activeTab.taskId) : undefined;
  const isReportTab = activeTab != null && activeTab.kind === 'artifact' && activeTab.artifactId == null;
  // 056：子 agent 执行过程 Tab（对话流角色行点击打开）——过程正文自带头部/底部，
  // 不走文件读取链路，也不需要工具栏。
  const isProcessTab = activeTab != null && ['process','workflow-run','workflow-definition'].includes(activeTab.kind);
  const processSnap = activeTab?.kind === 'process' ? snapOf(activeTab.taskId) : undefined;
  // 050：正文契约——快照带正文时报告 Tab 渲染正文（宽幅阅读），旧档案回落交付。
  const bodyText = isReportTab ? snap?.resultText?.trim() ?? '' : '';
  const delivery = snap?.delivery ?? null;
  const currentArtifact: TaskArtifact | null =
    activeTab?.kind === 'artifact' && activeTab.artifactId
      ? snap?.artifacts?.find((item) => item.id === activeTab.artifactId) ?? null
      : null;
  const currentAttachment: MessageAttachmentView | null =
    activeTab?.kind === 'attachment'
      ? attachmentMetaOf(activeTab.conversationId, activeTab.attachmentId) ?? null
      : null;
  // 062：当前交付物元数据（正式登记条目；链接对象无元数据、靠 Tab 携带名字）。
  const currentDeliverable: ConversationDeliverableView | null =
    activeTab?.kind === 'deliverable'
      ? deliverableMetaOf?.(activeTab.conversationId, activeTab.artifactId) ?? null
      : null;

  // ---- 读取缓存（按 Tab key；undefined/null＝读取中，失败可重试） ----
  const [previewContainer,setPreviewContainer]=useState<HTMLDivElement|null>(null);
  const [previewModal,setPreviewModal]=useState(()=>window.matchMedia('(max-width: 1179px)').matches);
  useEffect(()=>{const query=window.matchMedia('(max-width: 1179px)'),update=()=>setPreviewModal(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  const [results, setResults] = useState<Record<string, PreviewResult | null>>({});
  const resultsRef = useRef<Record<string, PreviewResult | null>>({});
  const loadTicks = useRef<Map<string, number>>(new Map());

  const applyResult = useCallback((key: string, value: PreviewResult | null) => {
    resultsRef.current = { ...resultsRef.current, [key]: value };
    setResults(resultsRef.current);
  }, []);

  const load = useCallback(
    (tab: PreviewTabId) => {
      // 报告与执行过程 Tab 的数据都来自快照，无文件读取。
      if (tab.kind === 'attachment') {
        // 附件 Tab：按身份受控读取；重启后登记表为空时，带档案冻结的暂存路径
        // 走主进程受控回退（只认暂存区内的图片）。
        const key = previewTabKey(tab);
        const tick = (loadTicks.current.get(key) ?? 0) + 1;
        loadTicks.current.set(key, tick);
        applyResult(key, null);
        const stagedPath = attachmentMetaOf(tab.conversationId, tab.attachmentId)?.stagedPath;
        const request = window.hemiVoice?.readAttachmentPreview(
          tab.conversationId,
          tab.attachmentId,
          stagedPath,
        );
        if (!request) { applyResult(key, { ok: false, message: '读取通道不可用，请重启应用后再试' }); return; }
        void request
          ?.then((value) => {
            if (loadTicks.current.get(key) !== tick) return;
            applyResult(key, value ?? { ok: false, message: '读取不可用' });
          })
          .catch(() => {
            if (loadTicks.current.get(key) !== tick) return;
            applyResult(key, { ok: false, message: '读取失败，可重试' });
          });
        return;
      }
      if (tab.kind === 'deliverable') {
        // 062 会话交付物：正式条目按 conversationId+artifactId 从 flow 解析；
        // 链接对象带 linkPath 线索（主进程重新受控解析，不信任渲染层路径）。
        const key = previewTabKey(tab);
        const tick = (loadTicks.current.get(key) ?? 0) + 1;
        loadTicks.current.set(key, tick);
        applyResult(key, null);
        const request = window.hemiVoice?.readConversationDeliverable?.(
          tab.conversationId,
          tab.artifactId,
          tab.linkPath ?? null,
        );
        if (!request) { applyResult(key, { ok: false, message: '读取通道不可用，请重启应用后再试' }); return; }
        void request
          ?.then((value) => {
            if (loadTicks.current.get(key) !== tick) return;
            applyResult(key, value ?? { ok: false, message: '读取不可用' });
          })
          .catch(() => {
            if (loadTicks.current.get(key) !== tick) return;
            applyResult(key, { ok: false, message: '读取失败，可重试' });
          });
        return;
      }
      if (tab.kind !== 'artifact' || tab.artifactId == null) return;
      const key = previewTabKey(tab);
      const tick = (loadTicks.current.get(key) ?? 0) + 1;
      loadTicks.current.set(key, tick);
      applyResult(key, null);
      const request = window.hemiVoice?.readArtifactPreview(tab.taskId, tab.artifactId);
      if (!request) { applyResult(key, { ok: false, message: '读取通道不可用，请重启应用后再试' }); return; }
      void request
        ?.then((value) => {
          if (loadTicks.current.get(key) !== tick) return;
          applyResult(key, value ?? { ok: false, message: '读取不可用' });
        })
        ?.catch(() => {
          if (loadTicks.current.get(key) !== tick) return;
          applyResult(key, { ok: false, message: '读取失败，可重试' });
        });
    },
    [applyResult, attachmentMetaOf],
  );

  // 新到达的文件 Tab 自动读取一次（已有结果的不重读；报告/过程 Tab 无读取）。
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.kind !== 'attachment' && tab.kind !== 'deliverable' && !(tab.kind === 'artifact' && tab.artifactId != null)) continue;
      const key = previewTabKey(tab);
      if (!(key in resultsRef.current)) load(tab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖 Tab 身份序列，内容不变不重读。
  }, [tabKeys, load]);

  // 062 R-04：同一交付物更新（contentVersion 递增）→ 正在预览的 Tab 原位刷新，
  // 不切走也不留旧缓存；未打开的 Tab 无缓存可失效。
  const deliverableVersions = useMemo(() => {
    const versions: Record<string, number> = {};
    for (const tab of tabs) {
      if (tab.kind !== 'deliverable') continue;
      const meta = deliverableMetaOf?.(tab.conversationId, tab.artifactId);
      if (meta) versions[previewTabKey(tab)] = meta.contentVersion ?? 0;
    }
    return versions;
  }, [tabs, deliverableMetaOf]); // eslint-disable-line react-hooks/exhaustive-deps -- Tab 身份与元数据引用变化即重算
  const loadedVersionsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [key, version] of Object.entries(deliverableVersions)) {
      if (loadedVersionsRef.current[key] === version) continue;
      loadedVersionsRef.current[key] = version;
      if (key in resultsRef.current) {
        const tab = tabs.find((item) => previewTabKey(item) === key);
        if (tab) load(tab);
      }
    }
  }, [deliverableVersions, tabs, load]);

  const activeResult = activeTab && (activeTab.kind === 'attachment' || activeTab.kind === 'deliverable' || (activeTab.kind === 'artifact' && activeTab.artifactId != null))
    ? results[previewTabKey(activeTab)]
    : undefined;
  const reloadCurrent = useCallback(() => {
    if (activeTab) load(activeTab);
  }, [activeTab, load]);

  // ---- 轻量 toast（保存/打开结果反馈；不阻塞阅读） ----
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const [saving, setSaving] = useState(false);
  const saveReport = useCallback(async (taskId: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await window.hemiVoice?.saveDeliveryReport(taskId);
      if (result?.ok) setToast(`已保存到 ${result.path ?? '所选位置'}`);
      else if (!result?.canceled) setToast(result?.message || '没有保存成功');
    } catch {
      setToast('没有保存成功，稍后再试');
    } finally {
      setSaving(false);
    }
  }, [saving]);

  const openInBrowser = useCallback((tab: PreviewTabId) => {
    if (tab.kind === 'process' || (tab.kind === 'workflow-definition' || tab.kind === 'workflow-run')) return; // 过程/定义页没有磁盘对象，入口本就不渲染。
    const request = tab.kind === 'attachment'
      ? window.hemiVoice?.openAttachmentSource(tab.conversationId, tab.attachmentId)
      : tab.kind === 'deliverable'
        ? window.hemiVoice?.openConversationDeliverable(tab.conversationId, tab.artifactId, tab.linkPath ?? null)
        : window.hemiVoice?.openArtifactPreviewFile(tab.taskId, tab.artifactId ?? '');
    void request
      .then((result) => {
        if (!result?.ok) setToast(result?.message || '打开失败');
        else if (result.message) setToast(result.message);
      })
      .catch(() => setToast('打开失败'));
  }, []);

  // ---- 焦点与 Escape ----
  const triggerRef = useRef<Element | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const focusTab = useCallback((key: string) => {
    railRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab-key="${CSS.escape(key)}"]`)
      ?.focus();
  }, []);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    if (activeKey) focusTab(activeKey);
    return () => {
      // 收起（含 Escape、最后一个 Tab 关闭）后焦点回触发元素（R-05）。
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在面板挂载时执行一次。
  }, []);

  // 打开/切换/关闭当前项后，焦点落在新当前 Tab（FLOW 键盘规则）。
  useEffect(() => {
    if (activeKey) focusTab(activeKey);
  }, [activeKey, focusTab]);



  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!stripRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  // ---- 每 Tab 阅读位置：切换时保存/恢复（R-05） ----
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollPosRef = useRef<Map<string, number>>(new Map());
  const saveScroll = useCallback(() => {
    if (activeKey && contentRef.current) {
      scrollPosRef.current.set(activeKey, contentRef.current.scrollTop);
    }
  }, [activeKey]);
  useLayoutEffect(() => {
    if (contentRef.current && activeKey) {
      contentRef.current.scrollTop = scrollPosRef.current.get(activeKey) ?? 0;
    }
  }, [activeKey]);

  // ---- Tab 溢出：左右滚动按钮 + 滚轮 + 当前项滚入可见（R-05） ----
  const [overflow, setOverflow] = useState({ visible: false, atStart: true, atEnd: false });
  const updateOverflow = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const visible = rail.scrollWidth > rail.clientWidth + 1;
    setOverflow({
      visible,
      atStart: rail.scrollLeft <= 1,
      atEnd: rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 1,
    });
  }, []);

  useEffect(() => {
    updateOverflow();
    const rail = railRef.current;
    if (!rail) return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(rail);
    rail.addEventListener('scroll', updateOverflow);
    return () => {
      observer.disconnect();
      rail.removeEventListener('scroll', updateOverflow);
    };
  }, [updateOverflow, tabKeys]);

  // 当前 Tab 自动滚入可见区（不带动整窗横向滚动）。
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || !activeKey) return;
    const selected = rail.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`);
    if (!selected) return;
    const start = selected.offsetLeft - rail.offsetLeft;
    const end = start + selected.offsetWidth;
    if (end > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = end - rail.clientWidth + 9;
    else if (start < rail.scrollLeft) rail.scrollLeft = Math.max(0, start - 9);
    updateOverflow();
  }, [activeKey, tabKeys, updateOverflow]);

  // 滚轮横滚：竖直滚轮在 Tab 行内转横向（React onWheel 是 passive，手动挂非 passive）。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const rail = railRef.current;
      if (!rail || rail.scrollWidth <= rail.clientWidth + 1) return;
      event.preventDefault();
      rail.scrollLeft += event.deltaY;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  const scrollRailBy = useCallback((direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.round(rail.clientWidth * 0.75) });
  }, []);

  // ---- 关闭：当前项先算相邻（右侧优先，没有右侧则左侧），焦点落新当前 Tab ----
  const pendingFocusRef = useRef<string | null>(null);
  const handleClose = useCallback((key: string) => {
    const index = tabs.findIndex((tab) => previewTabKey(tab) === key);
    if (index < 0) return;
    scrollPosRef.current.delete(key);
    if (key === activeKey) {
      const neighbor = tabs[index + 1] ?? tabs[index - 1] ?? null;
      pendingFocusRef.current = neighbor ? previewTabKey(neighbor) : null;
    } else {
      pendingFocusRef.current = activeKey;
    }
    onCloseTab(key);
  }, [tabs, activeKey, onCloseTab]);

  useEffect(() => {
    const key = pendingFocusRef.current;
    if (key == null) return;
    pendingFocusRef.current = null;
    if (key) focusTab(key);
  }, [activeKey, tabs, focusTab]);

  // ---- ＋ 菜单：当前任务（当前 Tab 所属任务）可阅读的成果＋当前会话交付物＋当前会话附件 ----
  const addItems = useMemo(() => {
    const items: PreviewTabId[] = [];
    if (activeTab?.kind === 'artifact') {
      const snap = snapOf(activeTab.taskId);
      if ((snap?.delivery || snap?.resultText?.trim()) && snap.taskId) {
        items.push({ kind: 'artifact', taskId: snap.taskId, artifactId: null }); // 可阅读的结果（050 正文／025 交付视图）
        for (const artifact of snap.artifacts ?? []) {
          if (isPreviewableArtifact(artifact)) {
            items.push({ kind: 'artifact', taskId: snap.taskId, artifactId: artifact.id });
          }
        }
      }
    }
    // 062：当前会话的有效交付物（flow 投影；范围外格式也列出——打开是文件信息态）。
    for (const option of deliverableOptions) {
      if (!items.some((tab) => previewTabKey(tab) === previewTabKey(option))) items.push(option);
    }
    // 028：附件候选跟在成果之后（不把未发送附件注册成模型成果，只是预览入口）。
    for (const option of attachmentOptions) {
      if (!items.some((tab) => previewTabKey(tab) === previewTabKey(option))) items.push(option);
    }
    return items;
  }, [activeTab, snapOf, deliverableOptions, attachmentOptions]);
  const openedKeys = useMemo(() => new Set(tabs.map(previewTabKey)), [tabKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Tab 行键盘：左右循环切换、Home/End 到首尾、Delete 关当前（FLOW） ----
  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tabEl = (event.target as HTMLElement).closest<HTMLElement>('[data-tab-key]');
    if (!tabEl) return;
    const keys = tabs.map(previewTabKey);
    const index = keys.indexOf(tabEl.dataset.tabKey ?? '');
    if (index < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = event.key === 'ArrowRight'
        ? (index + 1) % keys.length
        : (index - 1 + keys.length) % keys.length;
      onActivate(keys[next]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onActivate(event.key === 'Home' ? keys[0] : keys[keys.length - 1]);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      handleClose(tabEl.dataset.tabKey ?? '');
    }
  };

  const isImage = activeResult?.ok && activeResult.kind === 'image';
  const isUnsupported = activeResult?.ok && activeResult.kind === 'unsupported';
  // 来源路径：成果用登记路径；附件文件用登记来源路径；粘贴图片没有原文件。
  // 049 R-11：远端产物路径带主机前缀，且不提供「在浏览器中打开」。
  // 062：会话交付物同口径——远端带主机前缀，本机显示冻结的真实路径（链接对象
  // 无 flow 元数据时用读取结果带回的路径）。
  const remoteArtifact = Boolean(currentArtifact?.host ?? currentDeliverable?.host);
  const pathValue = (() => {
    if (currentAttachment) return currentAttachment.source === 'paste' ? '' : currentAttachment.originPath ?? '';
    if (currentDeliverable?.host) return `${currentDeliverable.host}:${currentDeliverable.path}`;
    if (currentDeliverable?.path) return currentDeliverable.path;
    if (activeTab?.kind === 'deliverable') return activeResult?.path ?? '';
    if (remoteArtifact && currentArtifact?.path) return `${currentArtifact.host}:${currentArtifact.path}`;
    return currentArtifact?.path ?? '';
  })();
  const pathEnabled = !remoteArtifact && Boolean(pathValue) && Boolean(activeResult?.ok);
  const discussReport = () => {
    if (!snap || !onContinueDiscuss) return;
    onContinueDiscuss(snap);
  };

  const partialItems = delivery
    ? [...(delivery.partial?.missing ?? []), ...(delivery.partial?.note ? [delivery.partial.note] : [])]
    : [];

  return (
    <><div ref={setPreviewContainer} style={{display:'contents'}}/><PreviewDialog.Root open modal={previewModal} disablePointerDismissal onOpenChange={(open,details)=>{
      if(open)return;
      if(menuOpen){details.cancel();setMenuOpen(false);addRef.current?.focus();return;}
      // 2026-10-18 用户裁决：点击面板外（对话流等）不收起面板——收起只走收起按钮
      // 与最后一个 Tab 关闭；Escape 逐个关当前 Tab，最后一个关完由上层收起面板。
      if(details.reason==='outside-press'||details.reason==='focus-out'){details.cancel();return;}
      if(details.reason==='escape-key'){details.cancel();details.event.preventDefault();handleClose(activeKey);return;}
      onCollapse();
    }}>{previewContainer?<PreviewDialog.Portal container={previewContainer} style={{display:'contents'}}><PreviewDialog.Popup render={<aside/>} className="h24-preview" data-preview-kind={activeTab?.kind} initialFocus={false} aria-modal={previewModal?true:undefined} aria-label="成果预览">
      <PreviewDialog.Title className="sr-only">成果预览</PreviewDialog.Title>
      {/* 第一行：Tab 列 + 当前任务成果 ＋ + 溢出滚动 + 收起。 */}
      <div className="h24-preview-strip" ref={stripRef}>
        <div
          className="h24-preview-rail"
          ref={railRef}
          role="tablist"
          aria-label="已打开的成果"
          onKeyDown={onRailKeyDown}
        >
          {tabs.map((tab) => {
            const key = previewTabKey(tab);
            const active = key === activeKey;
            const meta = tabMetaOf(tab, snapOf, attachmentMetaOf, workflowNames, deliverableMetaOf);
            return (
              <div key={key} className={`h24-preview-tab${active ? ' active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  className="h24-preview-tab-select"
                  data-tab-key={key}
                  id={`h24-preview-tab-${key}`}
                  aria-selected={active}
                  aria-controls="h24-preview-content"
                  tabIndex={active ? 0 : -1}
                  title={meta.name}
                  onClick={() => onActivate(key)}
                >
                  <TabIcon kind={meta.kind} />
                  <span>{meta.name}</span>
                </button>
                <button
                  type="button"
                  className="h24-preview-tab-close"
                  aria-label={`关闭 ${meta.name}`}
                  onClick={() => handleClose(key)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="h24-preview-add"
          ref={addRef}
          aria-label="打开或切换当前任务成果或附件"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="选择成果或附件"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
        {overflow.visible ? (
          <div className="h24-preview-scroll-controls">
            <button
              type="button"
              aria-label="向左滚动预览 Tab"
              title="向左滚动 Tab"
              disabled={overflow.atStart}
              onClick={() => scrollRailBy(-1)}
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="向右滚动预览 Tab"
              title="向右滚动 Tab"
              disabled={overflow.atEnd}
              onClick={() => scrollRailBy(1)}
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="h24-preview-collapse"
          aria-label="收起预览，返回对话"
          title="收起预览"
          onClick={onCollapse}
        >
          <PanelRightClose className="size-4" aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="h24-preview-add-menu" role="menu" aria-label="当前任务的成果与附件">
            {addItems.length ? (
              addItems.map((tab) => {
                const meta = tabMetaOf(tab, snapOf, attachmentMetaOf, workflowNames, deliverableMetaOf);
                const opened = openedKeys.has(previewTabKey(tab));
                return (
                  <button
                    key={previewTabKey(tab)}
                    type="button"
                    role="menuitem"
                    className="h24-preview-add-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenTab(tab);
                    }}
                  >
                    <TabIcon kind={meta.kind} />
                    <span>{meta.name}</span>
                    <small>{opened ? '已打开' : '打开'}</small>
                  </button>
                );
              })
            ) : (
              <p className="h24-preview-add-empty">当前没有可阅读的成果或附件</p>
            )}
          </div>
        ) : null}
      </div>

      {/* 第二行：文件＝重读 + 可点击来源（浏览器打开）；报告＝继续讨论／保存 HTML；
          执行过程自带头部与底部，不出工具栏。 */}
      {isProcessTab ? null : (
      <div className="h24-preview-toolbar">
        {isReportTab ? (
          <>
            {/* 报告没有磁盘路径：左空右实，图标靠右对齐（候选稿第二行形态）。 */}
            <span className="h24-preview-tool-spacer" />
            {onContinueDiscuss ? (
              <button
                type="button"
                className="h24-preview-tool"
                aria-label="继续讨论这份报告"
                title="继续讨论"
                onClick={discussReport}
              >
                <MessageSquarePlus className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="h24-preview-tool"
              aria-label="保存报告 HTML"
              title="保存 HTML"
              disabled={saving}
              onClick={() => activeTab?.kind === 'artifact' && void saveReport(activeTab.taskId)}
            >
              <Download className="size-3.5" aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="h24-preview-tool"
              aria-label="重新读取当前文件"
              title="重新读取当前文件"
              onClick={reloadCurrent}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </button>
            {currentAttachment?.source === 'paste' ? (
              // 粘贴图片没有原文件路径：展示来源说明，不放可点击路径（028 R-03）。
              <span className="h24-preview-path" title="粘贴的图片，没有原文件路径">
                <span>粘贴图片 · 本条消息附件</span>
              </span>
            ) : (
              <button
                type="button"
                className="h24-preview-path"
                title={pathEnabled ? `${isUnsupported || activeResult?.kind === 'video' ? '用系统应用打开' : '在浏览器中打开'}：${pathValue}` : pathValue || undefined}
                aria-disabled={!pathEnabled}
                onClick={pathEnabled && activeTab ? () => openInBrowser(activeTab) : undefined}
              >
                <span>{pathValue || currentAttachment?.name || currentArtifact?.name || '—'}</span>
                <ExternalLink className="size-3" aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
      )}

      {/* 正文：文件/报告共用滚动容器（切换恢复各自阅读位置）；执行过程与工作流
          定义自带滚动，整体作为面板的 flex 子元素铺满。 */}
      {activeTab?.kind === 'workflow-run' ? (
        <WorkflowRunPreview invocationId={activeTab.invocationId} />
      ) : activeTab?.kind === 'workflow-definition' ? (
        <WorkflowDefinitionPreview workflowId={activeTab.workflowId} revision={activeTab.revision} />
      ) : isProcessTab ? (
        processSnap ? (
          <TaskProcessBody
            snap={processSnap}
            onAction={onTaskAction}
            onContinueDiscuss={onContinueDiscuss}
            onArchiveResumed={() => {
              if (activeTab) handleClose(previewTabKey(activeTab));
            }}
          />
        ) : (
          <div className="h24-preview-body">
            <p className="h24-preview-status">这个任务的过程现在看不到（可能已随会话结束）。</p>
          </div>
        )
      ) : (
      <div
        className="h24-preview-body"
        id="h24-preview-content"
        ref={contentRef}
        role="tabpanel"
        aria-labelledby={activeTab ? `h24-preview-tab-${previewTabKey(activeTab)}` : undefined}
        tabIndex={0}
        onScroll={saveScroll}
      >
        {!activeTab ? null : isReportTab ? (
          bodyText ? (
            <article className="h24-preview-doc h50-wide-body md selectable">
              <Markdown text={bodyText} />
            </article>
          ) : !delivery ? (
            <p className="h24-preview-status">这个任务现在没有可阅读的结果。</p>
          ) : (
            <article className="h24-preview-report">
              <h1 className="h24-preview-report-title">{delivery.title}</h1>
              <p className="h24-preview-report-summary">{delivery.summary}</p>
              {partialItems.length ? (
                <p className="h24-preview-report-partial" role="note">
                  部分完成：{partialItems.join('；')}
                </p>
              ) : null}
              <DeliveryBlocks blocks={delivery.blocks} taskId={activeTab.kind === 'artifact' ? activeTab.taskId : ''} heading="h2" />
              {delivery.sources.length ? (
                <section className="h24-preview-report-sources">
                  <h2>来源与依据</h2>
                  <DeliverySources taskId={activeTab.kind === 'artifact' ? activeTab.taskId : ''} delivery={delivery} />
                </section>
              ) : null}
            </article>
          )
        ) : !activeResult ? (
          <p className="h24-preview-status">正在读取…</p>
        ) : !activeResult.ok ? (
          // R-06：失败原位说明 + 重试；交付记录保留，不弹系统错误。
          <div className="h37-note h24-preview-error" data-tone="warn" role="note">
            <p>{activeResult.message ?? '文件现在读不了'}</p>
            <button type="button" className="h37-btn h37-btn-secondary h37-btn-sm h24-preview-retry" onClick={reloadCurrent}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
              重试读取
            </button>
          </div>
        ) : isUnsupported ? (
          // 062 R-03：范围外格式——文件信息＋可用动作（系统应用打开），不冒充预览成功。
          <div className="h62-unsupported">
            <FileText className="size-5" aria-hidden="true" />
            <span className="h62-unsupported-name">{activeResult.name ?? currentDeliverable?.name ?? '文件'}</span>
            <span className="h62-unsupported-meta">
              {pathValue || '（路径不可用）'}
              {typeof activeResult.size === 'number' && activeResult.size > 0
                ? ` · ${(activeResult.size / 1024).toFixed(activeResult.size >= 1024 * 1024 ? 1 : 0)} KB`
                : ''}
            </span>
            <span className="h62-unsupported-note">{activeResult.message ?? '这个格式暂不支持应用内预览'}</span>
            {!remoteArtifact && pathValue && activeTab ? (
              <button
                type="button"
                className="h37-btn h37-btn-secondary h37-btn-sm"
                onClick={() => openInBrowser(activeTab)}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                用系统应用打开
              </button>
            ) : null}
          </div>
        ) : activeResult.kind === 'video' && activeResult.mediaUrl ? (
          <VideoPreview key={activeResult.mediaUrl} url={activeResult.mediaUrl} name={activeResult.name ?? '预览视频'} onRetry={reloadCurrent} onOpen={() => activeTab && openInBrowser(activeTab)} />
        ) : isImage ? (
          <img
            className="h24-preview-image"
            src={activeResult.dataUrl}
            alt={currentAttachment?.name ?? currentDeliverable?.name ?? currentArtifact?.name ?? '预览图片'}
          />
        ) : activeResult.markdown ? (
          <article className="h24-preview-doc">
            <Markdown text={activeResult.text ?? ''} />
          </article>
        ) : (
          <pre className="h24-preview-plain">{activeResult.text}</pre>
        )}
      </div>
      )}

      {toast ? (
        <div className="h24-preview-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </PreviewDialog.Popup></PreviewDialog.Portal>:null}</PreviewDialog.Root></>
  );
}
