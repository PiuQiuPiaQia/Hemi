import { useFlow } from "../host/context.js";
import { performResourceKind } from "../host/resource-actions.js";
import { useTranscriptRowState } from "./transcript-row-state.js";
import { useCallback, useId, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  Ban,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  File as FileIcon,
  Folder,
  Image as ImageIcon,
  Link as LinkIcon,
  Maximize2,
  MoreHorizontal,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";

import type { TaskArtifact, TaskStateSnapshot } from "../types/presentation.js";
import { Menu } from "../ui/menu.js";
import { Markdown, type MarkdownImageRef } from "../shared/markdown.js";
import { useClipboardCopy } from "../host/context.js";
import { processStepsOf } from "../presentation/task-process-state.js";
import {
  resultStepsOf,
  verifySummaryOf,
} from "../presentation/result-process.js";

/**
 * 050 · 任务结果区（R-17～R-21）。DOM 与样式逐项对齐
 * designs/2026-10-10-result-delivery（styles.css/layout-tokens.css 的产品移植）：
 * 终态＝收敛状态行（查看过程原地展开）＋正文＋操作行＋提醒＋事实分组。
 * 执行期卡片（task-panel 的 running 分支）与这里互斥，不再共用外壳。
 */

type OutcomeKey = "complete" | "partial" | "failed" | "stopped";

type GlyphComponent = React.ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** 稿件自绘字形（lucide 无同形）：diff＝竖线分隔的 ＋／－；pause＝两道细竖线。 */
function strokeGlyph(d: string): GlyphComponent {
  return function Glyph({ className }) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={d} />
      </svg>
    );
  };
}
const DiffGlyph = strokeGlyph("M12 3v18M3 8h6M6 5v6M15 16h6");
const PauseGlyph = strokeGlyph("M8 6v12M16 6v12");

/** 状态图标沿稿：浅色圆底＋描线字形（✓ / △ / ✕ / ‖），不用实心圆盘。 */
const OUTCOME_INFO: Record<
  string,
  { key: OutcomeKey; label: string; icon: GlyphComponent }
> = {
  complete: { key: "complete", label: "已完成", icon: Check },
  partial: { key: "partial", label: "部分完成", icon: TriangleAlert },
  unknown: { key: "partial", label: "结果待核实", icon: TriangleAlert },
  stopped: { key: "stopped", label: "已停止", icon: PauseGlyph },
  denied: { key: "failed", label: "未获授权", icon: X },
  blocked: { key: "failed", label: "已阻止", icon: X },
  startfailed: { key: "failed", label: "未能启动", icon: X },
  reportfailed: { key: "failed", label: "总结失败", icon: X },
};

const VERDICT_WORD: Record<string, string> = {
  complete: "完成",
  partial: "部分完成",
  unknown: "无法确认",
};

/** 宿主兜底文案（执行器没写正文时 task-manager 补的一句）——与状态行重复，不当正文展示。 */
const PLACEHOLDER_BODIES = new Set(["任务已停止。"]);

/** 时长（稿 fmtT 口径）：不足 1 分钟按秒，其余 M分SS秒。 */
function fmtDurationCn(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}秒`;
  return `${Math.floor(secs / 60)}分${String(secs % 60).padStart(2, "0")}秒`;
}

/** 状态行上的任务级动作（检查结果／重试总结／重新发起任务）——与「查看过程」同排。 */
export type StatusLineAction = { label: string; onClick: () => void };

/** 状态行：图标＋任务名＋元信息（终态词 · 用时 · 核验）＋查看过程；原因与过程原地展开。 */
export function TaskResultStatusLine({
  snap,
  action,
}: {
  snap: TaskStateSnapshot;
  action?: StatusLineAction | null;
}) {
  const [procOpen, setProcOpen] = useTranscriptRowState<boolean>(
    "report-process",
    false,
  );
  const outcome = snap.outcome ?? "unknown";
  const info = OUTCOME_INFO[outcome] ?? OUTCOME_INFO.unknown;
  const Icon = info.icon;
  const tone =
    info.key === "partial" ? "warn" : info.key === "failed" ? "danger" : "";
  // 合法旧档/最小快照可缺 log（AC-39：缺可选字段不使整页崩溃）。
  const startedAt = snap.startedAt ?? snap.log?.[0]?.at ?? null;
  const endedAt = snap.endedAt ?? snap.log?.[snap.log.length - 1]?.at ?? null;
  const elapsed =
    startedAt && endedAt && endedAt > startedAt
      ? fmtDurationCn(endedAt - startedAt)
      : "";
  const verdict = snap.verification?.verdict;
  const verdictWord = verdict ? (VERDICT_WORD[verdict] ?? "") : "";
  const showVerdict =
    outcome === "complete" && Boolean(verdictWord) && verdict !== "complete";
  const reason = [
    "denied",
    "blocked",
    "startfailed",
    "unknown",
    "stopped",
    "reportfailed",
  ].includes(outcome)
    ? (snap.outcomeReason?.trim() ?? "")
    : "";
  const steps = useMemo(
    () => resultStepsOf(processStepsOf(snap), startedAt),
    [snap, startedAt],
  );
  const verify = verifySummaryOf(snap.verification);
  const procId = useId();

  return (
    <div className="h50-status" data-outcome={info.key}>
      <div className="h50-status-row">
        <span className="h50-status-icon" aria-hidden="true">
          <Icon className="h50-ic-xs" />
        </span>
        <h3 className="h50-status-title" title={snap.taskText || undefined}>
          {snap.taskText || "（没有任务描述）"}
        </h3>
        <span className="h50-status-meta">
          <span data-tone={tone || undefined}>{info.label}</span>
          {elapsed ? (
            <>
              <span className="sep">·</span>
              <span>{elapsed}</span>
            </>
          ) : null}
          {showVerdict ? (
            <>
              <span className="sep">·</span>
              <span data-tone="warn">核验 {verdictWord}</span>
            </>
          ) : null}
        </span>
        <span className="h50-status-spacer" />
        {action ? (
          <button
            type="button"
            className="h50-status-act"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
        <button
          type="button"
          className="h50-proc-toggle"
          aria-expanded={procOpen}
          aria-controls={procId}
          onClick={() => setProcOpen((open) => !open)}
        >
          查看过程
          <ChevronRight className="h50-ic-xs chev" aria-hidden="true" />
        </button>
      </div>
      {reason ? <p className="h50-status-reason">{reason}</p> : null}
      {procOpen ? (
        <div className="h50-proc" id={procId}>
          {steps.length ? (
            <ol className="h50-proc-list">
              {steps.map((step) => (
                <li key={step.key}>
                  <span className="h50-proc-time">{step.time}</span>
                  <span className={step.attention ? "attention" : undefined}>
                    {step.text}
                    {step.note ? (
                      <span className="h50-proc-tool"> · {step.note}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="h50-proc-empty">这次没有留下过程记录。</p>
          )}
          {verify ? (
            <p className="h50-proc-verify">
              <strong>{verify.label}</strong>
              {verify.text ? ` · ${verify.text}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 事实分组外壳：头（图标＋标题＋计数＋统计/备注＋箭头）可展开，体带顶部分隔线。 */
function FactGroup({
  icon: GroupIcon,
  title,
  count,
  extra,
  note,
  foot,
  defaultOpen,
  children,
}: {
  icon: GlyphComponent;
  title: string;
  count: string;
  extra?: React.ReactNode;
  note?: string;
  foot?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useTranscriptRowState<boolean>(
    `fact:${title}`,
    Boolean(defaultOpen),
  );
  return (
    <section className="h50-group">
      <button
        type="button"
        className="h50-group-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !open)}
      >
        <GroupIcon className="h50-ic-sm" aria-hidden="true" />
        <span className="h50-group-title">{title}</span>
        {count ? <span className="h50-group-count">{count}</span> : null}
        {extra}
        {note ? <span className="h50-group-note">{note}</span> : null}
        <span className="h50-group-spacer" />
        <ChevronRight className="h50-ic-xs chev" aria-hidden="true" />
      </button>
      {open ? (
        <div className="h50-group-body">
          {children}
          {foot ? <p className="h50-group-foot">{foot}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** ± 统计（分组头与改动行共用）。 */
function StatSpan({ add, del }: { add: number | null; del: number | null }) {
  if (add == null && del == null) return null;
  return (
    <span className="h50-row-stat">
      {add ? <span className="plus">+{add}</span> : null}
      {del ? <span className="minus">−{del}</span> : null}
    </span>
  );
}

function RowIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="h50-act act-icon"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 任务结果区主体。snap 需为终态（terminal 且非 verifying）。frozen＝021 并入
 * 冻结的历史卡：只读展示（无操作按钮）。
 */
export function TaskResultBlock({
  snap,
  frozen = false,
  onOpenBodyWide,
  onOpenArtifact,
  onOpenPreview,
  statusAction,
}: {
  snap: TaskStateSnapshot;
  frozen?: boolean;
  /** 任务级动作（检查结果等），挂在状态行上。 */
  statusAction?: StatusLineAction | null;
  /** 宽幅阅读：正文进 027 预览栏。 */
  onOpenBodyWide?: () => void;
  onOpenArtifact?: (artifactId: string, intent: "open" | "reveal") => void;
  onOpenPreview?: (artifactId: string) => void;
}) {
  const { runtime } = useFlow();
  const rawBody = snap.resultText?.trim() ?? "";
  const body = PLACEHOLDER_BODIES.has(rawBody) ? "" : rawBody;
  const { copy: copyWithFeedback, toastNode: copyToast } = useClipboardCopy();
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const notices = (snap.notices ?? []).filter(Boolean);
  const changes = snap.fileChanges?.files ?? [];
  const coverage = snap.fileChanges?.coverage ?? "tools";
  const artifacts = (snap.artifacts ?? []).filter(
    (artifact) => artifact.kind === "file",
  );
  const unavailable = artifacts.filter(
    (artifact) => artifact.available === false,
  );
  // R-08 文件状态规则：读取失败（存在但无权限/解码失败）留在交付组给原因与重试，
  // 只有原位置缺失才进「不可用」区。
  const deliverErrors = artifacts.filter(
    (artifact) =>
      artifact.available !== false &&
      artifact.availability?.state &&
      artifact.availability.state !== "ok" &&
      artifact.availability.state !== "unchecked",
  );
  const deliverOk = artifacts.filter(
    (artifact) =>
      artifact.available !== false && !deliverErrors.includes(artifact),
  );
  const deliverOkCount = deliverOk.length;
  const deliverErrorCount = deliverErrors.length;
  const availableArtifacts = artifacts.filter(
    (artifact) => artifact.available !== false,
  );
  const sources = snap.sources ?? [];
  // 文件改动默认展开口径（用户裁决）：代码为主的任务展开，其余收起（头部有数量与 +/−）。
  const codeish =
    changes.length >= 3 || (changes.length > 0 && !artifacts.length);
  const totalAdd = changes.reduce((sum, change) => sum + (change.add ?? 0), 0);
  const totalDel = changes.reduce((sum, change) => sum + (change.del ?? 0), 0);

  /** 短回执口径（稿 short-answer / 多任务的天气）：顺利完成的一段话回执——单段、
   *  少于 300 字、无表格/图片/代码块/标题/列表/引用。行内代码（路径、文件名）不算
   *  结构：稿里「挪到 `~/Desktop/截图`」就是短回执；整段代码块的正文才保留全量
   *  操作行（2026-10-10 代码正文误降级实录）。部分完成/失败/停止的正文即使短也给
   *  全量操作行（稿 stopped/image-partial/recheck）。 */
  const isShort = useMemo(() => {
    const chars = Array.from(body).length;
    return (
      snap.outcome === "complete" &&
      chars < 300 &&
      !/\n\s*\n/.test(body) &&
      !body.includes("|") &&
      !body.includes("![") &&
      !body.includes("```") &&
      !/^#{1,4}\s/m.test(body) &&
      !/^([-*+>]\s|\d+[.)]\s)/m.test(body)
    );
  }, [body, snap.outcome]);

  const copyBody = useCallback(() => {
    if (body) void copyWithFeedback(body, "已复制 Markdown");
  }, [body, copyWithFeedback]);

  /** R-08：不可用行的「重新检查」——重读档案（artifactViews 实时 stat），只查证不重放。 */
  const [recheckNote, setRecheckNote] = useState("");
  const recheckUnavailable = useCallback(
    async (artifact: TaskArtifact) => {
      if (!snap.taskId) return;
      try {
        const result = await runtime.invoke((context) =>
          runtime.host!.resources!.resolve!(
            { href: artifact.path ?? artifact.id },
            context,
          ),
        );
        setRecheckNote(
          result.ok
            ? `「${artifact.name}」又能访问了，重新打开列表即可用`
            : result.error.message,
        );
        window.setTimeout(() => setRecheckNote(""), 2600);
      } catch {
        setRecheckNote("重新检查没有成功，稍后再试");
        window.setTimeout(() => setRecheckNote(""), 2600);
      }
    },
    [snap.taskId],
  );

  const saveBody = useCallback(async () => {
    if (!snap.taskId || saving) return;
    setSaving(true);
    setSaveNote("");
    try {
      const result = await performResourceKind(
        runtime,
        { id: `task-body:${snap.taskId}`, version: "0" },
        "save",
      );
      if (result.ok) setSaveNote("已保存");
      else if (result.error.code !== "cancelled")
        setSaveNote(result.error.message);
    } catch {
      setSaveNote("没有保存成功，稍后再试");
    } finally {
      setSaving(false);
      window.setTimeout(() => setSaveNote(""), 2600);
    }
  }, [snap.taskId, saving]);

  /** R-09/R-21：正文本地图片 → 本任务登记产物（缩略图受控读取；未登记原位占位）。 */
  const resolveImage = useCallback(
    (src: string): MarkdownImageRef => {
      if (!snap.taskId) return null;
      const normalized = src.replace(/^~/, "").replace(/^file:\/\//, "");
      const fileName = normalized.split("/").pop() ?? "";
      const hit = artifacts.find(
        (artifact) =>
          artifact.path === normalized ||
          artifact.path?.endsWith(`/${normalized}`) ||
          artifact.name === fileName,
      );
      return hit ? { taskId: snap.taskId, artifactId: hit.id } : null;
    },
    [snap.taskId, artifacts],
  );

  return (
    <section className="h50-block" aria-label={`任务结果：${snap.taskText}`}>
      <TaskResultStatusLine snap={snap} action={frozen ? null : statusAction} />
      <div className="h50-result">
        {body ? (
          <div
            className="h50-body md selectable"
            data-src={snap.bodySource ?? undefined}
          >
            <Markdown text={body} resolveImage={resolveImage} wrapTables />
          </div>
        ) : null}

        {body && !frozen ? (
          isShort ? (
            <div className="h50-actions">
              <button
                type="button"
                className="h50-act act-icon"
                aria-label="复制 Markdown"
                title="复制 Markdown"
                onClick={copyBody}
              >
                <Copy className="h50-ic-sm" aria-hidden="true" />
              </button>
              <ResultMoreMenu
                onCopy={copyBody}
                onSave={saveBody}
                onWide={onOpenBodyWide}
                saving={saving}
              />
            </div>
          ) : (
            <div className="h50-actions">
              <button type="button" className="h50-act" onClick={copyBody}>
                <Copy className="h50-ic-sm" aria-hidden="true" />
                复制 Markdown
              </button>
              <button
                type="button"
                className="h50-act"
                disabled={saving}
                onClick={() => void saveBody()}
              >
                <ArrowDownToLine className="h50-ic-sm" aria-hidden="true" />
                保存 .md
              </button>
              {onOpenBodyWide ? (
                <button
                  type="button"
                  className="h50-act"
                  onClick={onOpenBodyWide}
                >
                  <Maximize2 className="h50-ic-sm" aria-hidden="true" />
                  宽幅阅读
                </button>
              ) : null}
            </div>
          )
        ) : null}
        {saveNote ? (
          <p className="h50-save-note" role="status">
            {saveNote}
          </p>
        ) : null}
        {recheckNote ? (
          <p className="h50-save-note" role="status">
            {recheckNote}
          </p>
        ) : null}

        {notices.map((notice, index) => (
          <div className="h50-notice" role="note" key={index}>
            <TriangleAlert className="h50-ic-sm" aria-hidden="true" />
            <span>
              <span className="h50-notice-label">提醒</span>
              {"　"}
              {notice}
            </span>
          </div>
        ))}

        {changes.length ||
        availableArtifacts.length ||
        unavailable.length ||
        sources.length ? (
          <div className="h50-facts">
            {changes.length ? (
              <FactGroup
                icon={DiffGlyph}
                title="文件改动"
                count={`· ${changes.length}`}
                defaultOpen={codeish}
                foot={
                  snap.fileChanges?.tempExcluded
                    ? `另有 ${snap.fileChanges.tempExcluded} 个临时文件未列入，可在「查看过程」里找到。`
                    : undefined
                }
                extra={
                  <>
                    <StatSpan add={totalAdd} del={totalDel} />
                    <span className="h50-group-note">
                      {coverage === "tools+git"
                        ? "含命令改动（git 快照统计）"
                        : "命令改动未完整统计"}
                    </span>
                  </>
                }
              >
                {changes.map((change, index) => {
                  const openable =
                    change.kind !== "D" && !frozen && Boolean(snap.taskId);
                  const openChange = (intent: "open" | "reveal") =>
                    void performResourceKind(
                      runtime,
                      {
                        id: `file-change:${snap.taskId}:${change.path}`,
                        version: "0",
                      },
                      intent === "reveal" ? "reveal" : "open-with",
                    )?.then?.((result) => {
                      if (result && !result.ok)
                        (setRecheckNote(result.error.message),
                          window.setTimeout(() => setRecheckNote(""), 2600));
                    });
                  return (
                    <div className="h50-row" key={`${change.path}-${index}`}>
                      <span
                        className={`h50-badge k-${change.kind.toLowerCase()}`}
                        title={
                          { A: "新增", M: "修改", D: "删除", R: "改名" }[
                            change.kind
                          ]
                        }
                      >
                        {change.kind}
                      </span>
                      <span className="h50-row-main">
                        <span className="h50-row-name">
                          {fileNameOf(change.path)}
                        </span>
                        <span className="h50-row-path">
                          {dirOf(change.path)}
                        </span>
                      </span>
                      <StatSpan add={change.add} del={change.del} />
                      {change.attribution === "uncertain" ? (
                        <span className="h50-row-reason">归属待确认</span>
                      ) : null}
                      {openable ? (
                        <span className="h50-row-acts">
                          <RowIconButton
                            label="打开"
                            onClick={() => openChange("open")}
                          >
                            <ExternalLink className="h50-ic-sm" />
                          </RowIconButton>
                          <RowIconButton
                            label="在访达中显示"
                            onClick={() => openChange("reveal")}
                          >
                            <Folder className="h50-ic-sm" />
                          </RowIconButton>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </FactGroup>
            ) : null}

            {availableArtifacts.length ? (
              <FactGroup
                icon={FileIcon}
                title="交付文件"
                count={`· ${deliverOkCount}`}
                note={
                  deliverErrorCount
                    ? `${deliverErrorCount} 个读取失败`
                    : undefined
                }
                defaultOpen
              >
                {[...deliverOk, ...deliverErrors].map((artifact) => {
                  const errored = deliverErrors.includes(artifact);
                  return (
                    <div
                      className="h50-row deliver"
                      key={artifact.id}
                      data-state={errored ? "error" : undefined}
                    >
                      {isImageArtifact(artifact) ? (
                        <ImageIcon
                          className="h50-ic-md file-icon"
                          aria-hidden="true"
                        />
                      ) : (
                        <FileIcon
                          className="h50-ic-md file-icon"
                          aria-hidden="true"
                        />
                      )}
                      <span className="h50-row-main">
                        <span className="h50-row-name">{artifact.name}</span>
                        {artifact.description ? (
                          <span className="h50-row-desc">
                            {artifact.description}
                          </span>
                        ) : null}
                      </span>
                      {!frozen ? (
                        errored ? (
                          <span className="h50-row-acts">
                            <button
                              type="button"
                              className="h50-act"
                              onClick={() => void recheckUnavailable(artifact)}
                            >
                              <RotateCw
                                className="h50-ic-sm"
                                aria-hidden="true"
                              />
                              重新读取
                            </button>
                          </span>
                        ) : (
                          <span className="h50-row-acts">
                            {onOpenPreview && isPreviewable(artifact) ? (
                              <button
                                type="button"
                                className="h50-act"
                                onClick={() => onOpenPreview(artifact.id)}
                              >
                                <Eye className="h50-ic-sm" aria-hidden="true" />
                                预览
                              </button>
                            ) : null}
                            {onOpenArtifact ? (
                              <>
                                <RowIconButton
                                  label="用默认应用打开"
                                  onClick={() =>
                                    onOpenArtifact(artifact.id, "open")
                                  }
                                >
                                  <ExternalLink className="h50-ic-sm" />
                                </RowIconButton>
                                <RowIconButton
                                  label="在访达中显示"
                                  onClick={() =>
                                    onOpenArtifact(artifact.id, "reveal")
                                  }
                                >
                                  <Folder className="h50-ic-sm" />
                                </RowIconButton>
                              </>
                            ) : null}
                          </span>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </FactGroup>
            ) : null}

            {unavailable.length ? (
              <FactGroup
                icon={Ban}
                title="不可用"
                count={`· ${unavailable.length}`}
                note="交付过，现已无法访问"
                defaultOpen
                foot="历史记录保留名称与原位置；不计入可用文件。"
              >
                {unavailable.map((artifact) => (
                  <div
                    className="h50-row"
                    data-state="missing"
                    key={artifact.id}
                  >
                    <Ban className="h50-ic-md file-icon" aria-hidden="true" />
                    <span className="h50-row-main">
                      <span className="h50-row-name">{artifact.name}</span>
                      <span className="h50-row-path">
                        {dirOf(artifact.path ?? "")}
                      </span>
                    </span>
                    <span className="h50-row-reason">
                      原位置不可用，可能被移动或删除
                    </span>
                    <span className="h50-row-acts">
                      <RowIconButton
                        label="复制原位置"
                        onClick={() =>
                          void copyWithFeedback(
                            artifact.path ?? "",
                            "已复制原位置",
                          )
                        }
                      >
                        <Copy className="h50-ic-sm" />
                      </RowIconButton>
                      <button
                        type="button"
                        className="h50-act"
                        onClick={() => void recheckUnavailable(artifact)}
                      >
                        <RotateCw className="h50-ic-sm" aria-hidden="true" />
                        重新检查
                      </button>
                    </span>
                  </div>
                ))}
              </FactGroup>
            ) : null}

            {sources.length ? (
              <FactGroup
                icon={LinkIcon}
                title="来源"
                count={`· ${sources.length}`}
              >
                {sources.map((source, index) => (
                  <div className="h50-row" key={`${source.url}-${index}`}>
                    <LinkIcon
                      className="h50-ic-md file-icon"
                      aria-hidden="true"
                    />
                    <span className="h50-row-main">
                      {snap.taskId ? (
                        <button
                          type="button"
                          className="h50-row-name as-link"
                          title={source.url}
                          onClick={() =>
                            void runtime.invoke((context) =>
                              runtime.host!.openLink!(
                                { url: source.url },
                                context,
                              ),
                            )
                          }
                        >
                          {source.title}
                        </button>
                      ) : (
                        <span className="h50-row-name">{source.title}</span>
                      )}
                      {source.visited === false ? (
                        <span className="h50-row-desc">未访问</span>
                      ) : null}
                    </span>
                    <span className="h50-src-domain">
                      {domainOf(source.url)}
                    </span>
                  </div>
                ))}
              </FactGroup>
            ) : null}
          </div>
        ) : null}
      </div>
      {copyToast}
    </section>
  );
}

/** 短回执的「更多」菜单：复制／保存 .md／宽幅阅读。 */
function ResultMoreMenu({
  onCopy,
  onSave,
  onWide,
  saving,
}: {
  onCopy: () => void;
  onSave: () => void;
  onWide?: () => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="h50-menu-anchor">
      <button
        type="button"
        className="h50-act act-icon"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h50-ic-sm" aria-hidden="true" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        <button
          type="button"
          className="h37-menu-item"
          onClick={() => {
            setOpen(false);
            onCopy();
          }}
        >
          <Copy className="h50-ic-sm" aria-hidden="true" />
          复制 Markdown
        </button>
        <button
          type="button"
          className="h37-menu-item"
          disabled={saving}
          onClick={() => {
            setOpen(false);
            onSave();
          }}
        >
          <ArrowDownToLine className="h50-ic-sm" aria-hidden="true" />
          保存为 .md
        </button>
        {onWide ? (
          <button
            type="button"
            className="h37-menu-item"
            onClick={() => {
              setOpen(false);
              onWide();
            }}
          >
            <Maximize2 className="h50-ic-sm" aria-hidden="true" />
            宽幅阅读
          </button>
        ) : null}
      </Menu>
    </span>
  );
}

function fileNameOf(filePath: string): string {
  const parts = String(filePath).split("/");
  return parts[parts.length - 1] || filePath;
}

function dirOf(filePath: string): string {
  const text = String(filePath);
  const idx = text.lastIndexOf("/");
  return idx >= 0 ? text.slice(0, idx + 1) : "";
}

function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isPreviewable(artifact: TaskArtifact): boolean {
  return /\.(md|markdown|txt|png|jpe?g|gif|webp|svg)$/i.test(
    artifact.path ?? "",
  );
}

function isImageArtifact(artifact: TaskArtifact): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(
    artifact.path ?? artifact.name ?? "",
  );
}
