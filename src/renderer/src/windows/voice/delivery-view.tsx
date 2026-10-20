import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  CircleDashed,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Link2,
  ListFilter,
  Scale,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';

import type {
  DeliveryBlock,
  DeliverySource,
  TaskArtifact,
  TaskDelivery,
  TaskStateSnapshot,
} from '@/shared/types';
import { isPreviewableArtifact } from '@/windows/voice/lib/preview-tabs';
import { useClipboardCopy } from '@/lib/use-clipboard-copy';

/**
 * 025 自适应成果交付（渲染层）：四类结果卡 + 同窗报告阅读视图。
 *
 * 数据全部来自主进程校验过的 TaskDelivery（快照/档案同源）——这里不做任何
 * 内容解析或补造，只按块类型排版。来源打开、图片读取、报告保存直接走桥的
 * 受控通道（taskId+sourceId / taskId+artifactId 寻址，与 TaskArchiveSection
 * 的直连桥先例一致）；产物打开/定位沿用 012 的 onOpenArtifact 回调。
 */

const KIND_META: Record<TaskDelivery['kind'], { label: string; icon: typeof ScrollText }> = {
  summary: { label: '结果卡', icon: CheckCircle2 },
  comparison: { label: '对比', icon: Scale },
  checklist: { label: '清单', icon: ListFilter },
  receipt: { label: '回执', icon: CircleDashed },
  report: { label: '报告', icon: ScrollText },
};

function formatTime(at?: number | null) {
  if (!at) return '';
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 报告配图：按档案寻址读取 data URL；失败不占位（主进程已降级备注）。 */
function DeliveryImage({ taskId, artifactId, caption }: { taskId: string; artifactId: string; caption?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.hemiVoice
      ?.readDeliveryImage(taskId, artifactId)
      .then((result) => {
        if (!cancelled && result?.ok && result.dataUrl) setDataUrl(result.dataUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId, artifactId]);
  if (!dataUrl) return null;
  return (
    <figure className="delivery-figure">
      <img src={dataUrl} alt={caption || '报告配图'} loading="lazy" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

/** 内容块渲染（卡片与阅读视图共用；section 只有一层，不再递归）。 */
export function DeliveryBlocks({
  blocks,
  taskId,
  heading = 'div',
}: {
  blocks: DeliveryBlock[];
  taskId: string | null;
  /** section 标题的标签层级：卡片里用 div，阅读视图里用 h2（目录锚点）。 */
  heading?: 'div' | 'h2';
}) {
  if (!blocks.length) return null;
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'p':
            return (
              <p key={index} className="delivery-p">
                {block.text}
              </p>
            );
          case 'metrics':
            return (
              <div key={index} className="delivery-metrics">
                {block.items.map((item, itemIndex) => (
                  <div key={itemIndex} className="delivery-metric">
                    <span className="delivery-metric-label">{item.label}</span>
                    <span className="delivery-metric-value">
                      {item.value}
                      {item.unit ? <small>{item.unit}</small> : null}
                    </span>
                    {item.note ? <span className="delivery-metric-note">{item.note}</span> : null}
                  </div>
                ))}
              </div>
            );
          case 'table':
            return (
              <div key={index} className="delivery-table-wrap">
                <table className="delivery-table">
                  <thead>
                    <tr>
                      {block.columns.map((column, columnIndex) => (
                        <th key={columnIndex}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {block.caption ? <p className="delivery-caption">{block.caption}</p> : null}
              </div>
            );
          case 'checklist':
            return (
              <div key={index} className="delivery-checklist">
                {block.groups.map((group, groupIndex) => (
                  <div key={groupIndex} className="delivery-check-group">
                    {group.title ? <h4>{group.title}</h4> : null}
                    <ul>
                      {group.items.map((item, itemIndex) => (
                        <li key={itemIndex}>
                          <span className="delivery-check-text">
                            {item.text}
                            {item.note ? <small>{item.note}</small> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          case 'section': {
            const HeadingTag = heading;
            return (
              <section key={index} className="delivery-section" id={`delivery-section-${index + 1}`}>
                <HeadingTag className="delivery-section-title">{block.title}</HeadingTag>
                <DeliveryBlocks blocks={block.blocks} taskId={taskId} heading={heading} />
              </section>
            );
          }
          case 'image':
            return taskId ? (
              <DeliveryImage key={index} taskId={taskId} artifactId={block.artifactId} caption={block.caption} />
            ) : null;
          default:
            return null;
        }
      })}
    </>
  );
}

/** 交付卡片内部的产物行（打开/定位复用 012 回调；主成果有独立行）。 */
function ArtifactChip({
  artifact,
  taskId,
  onOpenArtifact,
}: {
  artifact: TaskArtifact;
  taskId: string;
  onOpenArtifact: (artifactId: string, intent: 'open' | 'reveal') => void;
}) {
  return (
    <span className="delivery-artifact">
      <button
        type="button"
        className="delivery-artifact-open"
        title={artifact.host && artifact.path ? `${artifact.host}:${artifact.path}` : artifact.path ?? artifact.url}
        onClick={() => onOpenArtifact(artifact.id, 'open')}
      >
        {artifact.kind === 'file' ? <FileText className="size-3" /> : <Link2 className="size-3" />}
        {artifact.name}
      </button>
      {artifact.kind === 'file' && artifact.path ? (
        <small className="h33-artifact-path" title={artifact.host ? `${artifact.host}:${artifact.path}` : artifact.path}>
          {artifact.host ? `${artifact.host}:${artifact.path}` : artifact.path}
        </small>
      ) : null}
      {/* 049 R-11：远端产物不提供访达定位（不在本机）。 */}
      {artifact.kind === 'file' && !artifact.host ? (
        <button
          type="button"
          className="delivery-artifact-btn"
          aria-label={`在 Finder 中显示 ${artifact.name}`}
          title="在 Finder 中显示"
          onClick={() => onOpenArtifact(artifact.id, 'reveal')}
        >
          <FolderOpen className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

function deliveryIndex(delivery: TaskDelivery, artifacts: TaskArtifact[]) {
  const mainIds = new Set(delivery.mainArtifacts ?? []);
  const attachmentIds = new Set(delivery.attachmentArtifacts ?? []);
  const main = artifacts.filter((artifact) => mainIds.has(artifact.id));
  const attachments = artifacts.filter(
    (artifact) => !mainIds.has(artifact.id)
      && (attachmentIds.has(artifact.id) || artifact.role !== 'main'),
  );
  return { main, attachments };
}

/** 来源列表：标题可读、外链用户点击才经受控通道打开（R-11）。 */
export function DeliverySources({ taskId, delivery }: { taskId: string; delivery: TaskDelivery }) {
  if (!delivery.sources.length) return null;
  return (
    <ol className="delivery-sources">
      {delivery.sources.map((source) => (
        <li key={source.id}>
          {source.url ? (
            <button
              type="button"
              className="delivery-source-link"
              title={source.url}
              onClick={() => {
                void window.hemiVoice
                  ?.openDeliverySource(taskId, source.id)
                  .then((result) => {
                    if (!result?.ok) window.hemiVoice?.logLine(`来源打开失败：${result?.message ?? ''}`);
                  })
                  .catch(() => {});
              }}
            >
              {source.title}
              <ExternalLink className="size-3" aria-hidden="true" />
            </button>
          ) : (
            <span className="delivery-source-plain">{source.title}</span>
          )}
          {source.note ? <span className="delivery-source-note">{source.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * 报告阅读视图（同窗覆盖在对话面板上）：返回/Escape 回原位（对话滚动不动）、
 * 左栏任务与目录、右侧正文独立滚动、保存 HTML。
 */
export function ReportReader({
  snap,
  onBack,
}: {
  snap: TaskStateSnapshot;
  onBack: () => void;
}) {
  const delivery = snap.delivery;
  const taskId = snap.taskId;
  const backRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    backRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!delivery || !taskId) return null;
  const sections = delivery.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'section');
  const { main, attachments } = deliveryIndex(delivery, snap.artifacts ?? []);
  const partialItems = [...(delivery.partial?.missing ?? []), ...(delivery.partial?.note ? [delivery.partial.note] : [])];

  const saveReport = async () => {
    if (saving) return;
    setSaving(true);
    setNotice('');
    try {
      const result = await window.hemiVoice?.saveDeliveryReport(taskId);
      if (result?.ok) setNotice(`已保存到 ${result.path ?? '所选位置'}`);
      else if (!result?.canceled) setNotice(result?.message || '没有保存成功');
    } catch {
      setNotice('没有保存成功，稍后再试');
    } finally {
      setSaving(false);
    }
  };

  const jumpToSection = (targetIndex: number) => {
    scrollRef.current
      ?.querySelector(`#delivery-section-${targetIndex + 1}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="report-reader" role="region" aria-label={`${delivery.title} · 报告阅读`}>
      <div className="reader-toolbar">
        <button type="button" className="reader-back" onClick={onBack} ref={backRef}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          返回对话
        </button>
        <div className="reader-toolbar-actions">
          {notice ? (
            <span className="reader-notice" role="status">
              {notice}
            </span>
          ) : null}
          <button type="button" className="reader-save" onClick={() => void saveReport()} disabled={saving}>
            <Download className="size-3.5" aria-hidden="true" />
            保存 HTML
          </button>
        </div>
      </div>
      <div className="reader-body">
        <aside className="reader-side">
          <p className="reader-task" title={snap.taskText}>
            任务 · {snap.taskText}
          </p>
          <p className="reader-status">{formatTime(delivery.registeredAt)} 登记</p>
          {sections.length ? (
            <nav className="reader-toc" aria-label="目录">
              <p className="reader-toc-title">目录</p>
              <ol>
                {sections.map(({ block, index }) => (
                  <li key={index}>
                    <button type="button" onClick={() => jumpToSection(index)}>
                      {block.type === 'section' ? block.title : ''}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          {main.length ? (
            <div className="reader-side-group">
              <p className="reader-toc-title">主成果</p>
              {main.map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  className="reader-side-file"
                  title={artifact.path}
                  onClick={() => {
                    void window.hemiVoice?.openArtifact(taskId, artifact.id, 'open');
                  }}
                >
                  <FileText className="size-3" aria-hidden="true" />
                  {artifact.name}
                </button>
              ))}
            </div>
          ) : null}
        </aside>
        <article className="reader-content" ref={scrollRef} tabIndex={0}>
          <h1 className="reader-title" tabIndex={-1}>
            {delivery.title}
          </h1>
          <p className="reader-summary">{delivery.summary}</p>
          {partialItems.length ? (
            <p className="delivery-partial" role="note">
              <TriangleAlert className="size-3.5" aria-hidden="true" />
              部分完成：{partialItems.join('；')}
            </p>
          ) : null}
          <DeliveryBlocks blocks={delivery.blocks} taskId={taskId} heading="h2" />
          {delivery.sources.length ? (
            <section className="reader-sources">
              <h2>来源与依据</h2>
              <DeliverySources taskId={taskId} delivery={delivery} />
            </section>
          ) : null}
          {attachments.length ? (
            <section className="reader-attachments">
              <h2>附件</h2>
              <div className="delivery-attachments">
                {attachments.map((artifact) => (
                  <ArtifactChip
                    key={artifact.id}
                    artifact={artifact}
                    taskId={taskId}
                    onOpenArtifact={(id, intent) => {
                      void window.hemiVoice?.openArtifact(taskId, id, intent);
                    }}
                  />
                ))}
              </div>
            </section>
          ) : null}
          <p className="reader-foot">
            报告由任务结果排版生成 · {formatTime(delivery.registeredAt)}
            {snap.verification?.verdict === 'complete'
              ? ' · 核验：完成'
              : snap.verification?.verdict === 'partial'
                ? ' · 核验：部分完成'
                : ''}
            ；排版不改变核验结论。
          </p>
        </article>
      </div>
    </div>
  );
}

/** 037：成果行的扩展名角标（≤4 位字母数字才显示，否则回落文件图标）。 */
function extLabelOf(name: string): string | null {
  const match = /\.([A-Za-z0-9]{1,4})$/.exec(name);
  return match ? match[1].toUpperCase() : null;
}

/** 表格类扩展名用浅绿角标，其余中性。 */
function extToneOf(name: string): 'data' | 'plain' {
  return /\.(csv|tsv|xlsx?|json)$/i.test(name) ? 'data' : 'plain';
}

/** 来源站点首字母（无 URL 或解析失败时取标题首字）。 */
function sourceInitial(source: DeliverySource): string {
  try {
    if (source.url) {
      // 取主域名标签（help.openai.com → openai → O），子域名首字母没有辨识度。
      const parts = new URL(source.url).hostname.split('.').filter(Boolean);
      const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      if (label) return label.charAt(0).toUpperCase();
    }
  } catch {
    /* 非法 URL 回落标题 */
  }
  return source.title.trim().charAt(0).toUpperCase() || '·';
}

function sourceHost(source: DeliverySource): string {
  try {
    return source.url ? new URL(source.url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

function openSource(taskId: string, source: DeliverySource) {
  void window.hemiVoice
    ?.openDeliverySource(taskId, source.id)
    .then((result) => {
      if (!result?.ok) window.hemiVoice?.logLine(`来源打开失败：${result?.message ?? ''}`);
    })
    .catch(() => {});
}

/** 卡底来源入口的站点首字母叠放（最多 4 个）。 */
export function SourceInitials({ sources }: { sources: DeliverySource[] }) {
  return (
    <span className="h25-src-stack" aria-hidden="true">
      {sources.slice(0, 4).map((source) => (
        <i key={source.id}>{sourceInitial(source)}</i>
      ))}
    </span>
  );
}

/** 来源标签（卡底「N 个来源」展开后原地铺开；点击经受控通道打开原链接，R-11）。 */
export function SourceChips({ taskId, sources }: { taskId: string; sources: DeliverySource[] }) {
  return (
    <div className="h25-src-chips">
      {sources.map((source) =>
        source.url ? (
          <button
            key={source.id}
            type="button"
            className="h25-src-chip"
            title={`${source.title}${sourceHost(source) ? ` · ${sourceHost(source)}` : ''}`}
            onClick={() => openSource(taskId, source)}
          >
            <i aria-hidden="true">{sourceInitial(source)}</i>
            <span>{source.title}</span>
          </button>
        ) : (
          <span key={source.id} className="h25-src-chip" data-plain="true" title={source.note ?? source.title}>
            <i aria-hidden="true">{sourceInitial(source)}</i>
            <span>{source.title}</span>
          </span>
        ),
      )}
    </div>
  );
}

/** 结果卡（form=card）有内容块时在任务卡内直读；回执仍走回执行。 */
export function isInlineCard(delivery: TaskDelivery | null | undefined): boolean {
  return delivery?.form === 'card' && delivery.kind !== 'receipt' && delivery.blocks.length > 0;
}

/** 卡内默认露出的结构化块数（指标/表格/清单）；其余块收在「展开全部」后。 */
const INLINE_LEAD_LIMIT = 2;

function isStructuredBlock(block: DeliveryBlock) {
  return block.type === 'metrics' || block.type === 'table' || block.type === 'checklist';
}

/**
 * 结果卡卡内正文：结果卡是「一眼看完」的形式，指标和表格直接铺在任务卡里，
 * 不再折成一行标题让用户点进预览栏（报告仍走预览栏）。默认露出前
 * INLINE_LEAD_LIMIT 个结构化块（没有结构化块时露第一块），其余原地展开。
 */
export function DeliveryCardBody({
  delivery,
  taskId,
  frozen = false,
  active = false,
  onOpenPreviewReport,
}: {
  delivery: TaskDelivery;
  taskId: string | null;
  frozen?: boolean;
  /** 这份结果正在右侧预览栏里打开。 */
  active?: boolean;
  onOpenPreviewReport?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const structured = delivery.blocks.filter(isStructuredBlock);
  const lead = structured.length ? structured.slice(0, INLINE_LEAD_LIMIT) : delivery.blocks.slice(0, 1);
  const hidden = delivery.blocks.length - lead.length;
  return (
    <div className="h25-card-body">
      <DeliveryBlocks blocks={expanded ? delivery.blocks : lead} taskId={taskId} />
      {hidden > 0 || onOpenPreviewReport ? (
        <div className="h25-card-body-foot">
          {hidden > 0 ? (
            <button
              type="button"
              className="h25-card-body-btn"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? '收起' : `展开全部（还有 ${hidden} 块）`}
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
          ) : null}
          <span className="h25-card-body-gap" />
          {active ? (
            <span className="h25-deliv-state">正在阅读</span>
          ) : onOpenPreviewReport ? (
            <button type="button" className="h25-card-body-btn" disabled={frozen} onClick={onOpenPreviewReport}>
              在右侧打开
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type DeliveryItem =
  | { kind: 'report'; key: string; title: string }
  | { kind: 'artifact'; key: string; artifact: TaskArtifact };

/** 卡内成果列表默认露出的条数（v3：一个列表最多 3 项，其余折叠）。 */
const LIST_LIMIT = 3;

/**
 * 025 任务卡聚焦稿 v3：卡内成果列表——一个列表、最多 3 项。可阅读的结果（报告/
 * 生成视图）排第一并加强调，后面是登记过的真实文件与链接；行只有图标＋名称，
 * 单击＝默认动作（报告/可预览文件进右侧预览栏，其余用默认应用打开，可执行
 * 只定位），次级操作悬停出现。路径只在悬停提示与「复制路径」里，不占行。
 * 回执类交付把外部动作（taskResult.sideEffects）列成一句话的回执行。
 */
export function DeliveryList({
  snap,
  frozen = false,
  activePreviewKey,
  onOpenArtifact,
  onOpenPreview,
  onOpenPreviewReport,
}: {
  snap: TaskStateSnapshot;
  frozen?: boolean;
  /** 当前预览栏正在看的对象（previewTabKey）；对应行标「正在阅读/预览」。 */
  activePreviewKey?: string | null;
  onOpenArtifact?: (artifactId: string, intent: 'open' | 'reveal') => void;
  onOpenPreview?: (artifactId: string) => void;
  onOpenPreviewReport?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // 2026-10-08：成果复制此前完全无反馈（fire-and-forget）——补成/败 toast。
  const { copy: copyArtifactTarget, toastNode: copyToastNode } = useClipboardCopy();
  const delivery = snap.delivery ?? null;
  const taskId = snap.taskId;
  if (!taskId) return null;
  const artifacts = snap.artifacts ?? [];
  const ordered = delivery
    ? (() => {
        const { main, attachments } = deliveryIndex(delivery, artifacts);
        const rest = artifacts.filter((a) => !main.includes(a) && !attachments.includes(a));
        return [...main, ...attachments, ...rest];
      })()
    : artifacts;
  const unique = ordered.filter(
    (artifact, index, list) => list.findIndex((other) => other.id === artifact.id) === index,
  );
  const isReceipt = delivery?.kind === 'receipt';
  // 主成果就是文件（form=file）时，生成视图不再单列一行——文件本身排第一。
  // 结果卡的正文已在卡内直读（DeliveryCardBody），列表里不再重复一行标题。
  const showReport = Boolean(delivery) && !isReceipt && !isInlineCard(delivery)
    && !(delivery?.form === 'file' && unique.length > 0);
  const items: DeliveryItem[] = [
    ...(showReport && delivery ? [{ kind: 'report' as const, key: 'report', title: delivery.title }] : []),
    ...unique.map((artifact) => ({ kind: 'artifact' as const, key: artifact.id, artifact })),
  ];
  const receipts = isReceipt ? snap.taskResult?.sideEffects ?? [] : [];
  if (!items.length && !receipts.length) return null;

  const shown = expanded ? items : items.slice(0, LIST_LIMIT);
  const hidden = items.length - shown.length;
  const previewKey = (artifactId: string | null) => `artifact:${taskId}:${artifactId ?? 'report'}`;

  return (
    <div className="h25-deliv">
      {receipts.length ? (
        <ul className="h25-receipts" aria-label="已完成的操作">
          {receipts.map((line, index) => (
            <li key={`${index}-${line}`}>
              <Check aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {shown.length ? (
        <div className="h25-deliv-list" aria-label={`成果 ${items.length} 项`}>
          {shown.map((item, index) => {
            if (item.kind === 'report') {
              const active = activePreviewKey === previewKey(null);
              return (
                <div key={item.key} className="h25-deliv-row" data-primary="true" data-active={active || undefined}>
                  <button
                    type="button"
                    className="h25-deliv-main"
                    disabled={frozen || !onOpenPreviewReport}
                    onClick={() => onOpenPreviewReport?.()}
                    title="在右侧阅读"
                  >
                    <span className="h25-deliv-icon" data-ext="report" aria-hidden="true">
                      <FileText />
                    </span>
                    <span className="h25-deliv-name">{item.title}</span>
                  </button>
                  {active ? <span className="h25-deliv-state">正在阅读</span> : null}
                </div>
              );
            }
            const { artifact } = item;
            const missing = artifact.kind === 'file' && artifact.available === false;
            const previewable = isPreviewableArtifact(artifact) && Boolean(onOpenPreview);
            const active = activePreviewKey === previewKey(artifact.id);
            // 049 R-11：远端产物只有「预览 / 下载到本机」，没有本机打开与访达。
            const remote = artifact.kind === 'file' && Boolean(artifact.host);
            const primaryIntent: 'preview' | 'open' | 'reveal' | 'download' =
              artifact.kind === 'link'
                ? 'open'
                : remote
                  ? (previewable ? 'preview' : 'download')
                  : artifact.executable
                    ? 'reveal'
                    : previewable
                      ? 'preview'
                      : 'open';
            const primaryLabel =
              primaryIntent === 'preview'
                ? '预览'
                : primaryIntent === 'reveal'
                  ? '在 Finder 中显示'
                  : primaryIntent === 'download'
                    ? '下载到本机'
                    : artifact.kind === 'link'
                      ? '打开链接'
                      : '用默认应用打开';
            const runPrimary = () => {
              if (primaryIntent === 'preview') onOpenPreview?.(artifact.id);
              else if (primaryIntent === 'download') {
                void window.hemiVoice
                  ?.downloadArtifact?.(taskId, artifact.id)
                  .then((result) => {
                    if (!result || result.canceled) return;
                    if (!result.ok) window.hemiVoice?.logLine(`下载失败：${result.message ?? ''}`);
                    else if (result.path) window.hemiVoice?.logLine(`已下载到本机：${result.path}`);
                  })
                  .catch(() => {});
              } else onOpenArtifact?.(artifact.id, primaryIntent);
            };
            const copyTarget = artifact.kind === 'file'
              ? (artifact.host ? `${artifact.host}:${artifact.path}` : artifact.path)
              : artifact.url;
            const ext = artifact.kind === 'file' ? extLabelOf(artifact.name) : null;
            return (
              <div
                key={item.key}
                className="h25-deliv-row"
                data-active={active || undefined}
                data-missing={missing || undefined}
                data-first={index === 0 || undefined}
              >
                <button
                  type="button"
                  className="h25-deliv-main"
                  disabled={frozen || missing}
                  onClick={runPrimary}
                  title={`${primaryLabel}${copyTarget ? `\n${copyTarget}` : ''}`}
                >
                  <span
                    className="h25-deliv-icon"
                    data-ext={artifact.kind === 'link' ? 'link' : extToneOf(artifact.name)}
                    aria-hidden="true"
                  >
                    {artifact.kind === 'link' ? <Link2 /> : ext ?? <FileText />}
                  </span>
                  <span className="h25-deliv-name">
                    {artifact.name}
                    {missing ? <small>已移动或删除</small> : null}
                  </span>
                </button>
                {active ? (
                  <span className="h25-deliv-state">正在预览</span>
                ) : !frozen && !missing ? (
                  <span className="h25-deliv-acts">
                    {remote ? (
                      primaryIntent !== 'download' ? (
                        <button
                          type="button"
                          className="h37-btn h37-btn-ghost h37-btn-icon h37-btn-sm"
                          aria-label={`下载 ${artifact.name} 到本机`}
                          title="下载到本机"
                          onClick={() => {
                            void window.hemiVoice
                              ?.downloadArtifact?.(taskId, artifact.id)
                              .then((result) => {
                                if (!result || result.canceled) return;
                                if (!result.ok) window.hemiVoice?.logLine(`下载失败：${result.message ?? ''}`);
                                else if (result.path) window.hemiVoice?.logLine(`已下载到本机：${result.path}`);
                              })
                              .catch(() => {});
                          }}
                        >
                          <Download aria-hidden="true" />
                        </button>
                      ) : null
                    ) : (
                      <>
                        {artifact.kind === 'file' && primaryIntent === 'preview' ? (
                          <button
                            type="button"
                            className="h37-btn h37-btn-ghost h37-btn-icon h37-btn-sm"
                            aria-label={`用默认应用打开 ${artifact.name}`}
                            title="用默认应用打开"
                            onClick={() => onOpenArtifact?.(artifact.id, 'open')}
                          >
                            <ExternalLink aria-hidden="true" />
                          </button>
                        ) : null}
                        {artifact.kind === 'file' && primaryIntent !== 'reveal' ? (
                          <button
                            type="button"
                            className="h37-btn h37-btn-ghost h37-btn-icon h37-btn-sm"
                            aria-label={`在 Finder 中显示 ${artifact.name}`}
                            title="在 Finder 中显示"
                            onClick={() => onOpenArtifact?.(artifact.id, 'reveal')}
                          >
                            <FolderOpen aria-hidden="true" />
                          </button>
                        ) : null}
                      </>
                    )}
                    {copyTarget ? (
                      <button
                        type="button"
                        className="h37-btn h37-btn-ghost h37-btn-icon h37-btn-sm"
                        aria-label={artifact.kind === 'file' ? `复制 ${artifact.name} 的路径` : `复制 ${artifact.name} 的链接`}
                        title={artifact.kind === 'file' ? '复制路径' : '复制链接'}
                        onClick={() =>
                          void copyArtifactTarget(copyTarget, artifact.kind === 'file' ? '已复制路径' : '已复制链接')
                        }
                      >
                        <Copy aria-hidden="true" />
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}
          {hidden > 0 ? (
            <button type="button" className="h25-deliv-more" onClick={() => setExpanded(true)}>
              还有 {hidden} 项
              <ChevronDown aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {copyToastNode}
    </div>
  );
}
