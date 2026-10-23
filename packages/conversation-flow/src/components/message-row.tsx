import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link2, ChevronRight, Check, Copy, Pencil } from "lucide-react";
import type {
  TranscriptItem,
  TaskStateSnapshot,
  TaskActionName,
  TaskPermissionChoice,
} from "../types/presentation.js";
import { useTranscriptRowState } from "./transcript-row-state.js";
import { Markdown } from "../shared/markdown.js";
import { useFlow } from "../host/context.js";
import { useClipboardCopy } from "../host/context.js";
import { segmentTaggedText } from "../presentation/composer-tokens.js";
import { visibleStageCount } from "../presentation/stage-briefs.js";
import { TurnParts } from "./turn-parts.js";
import { ThinkingBlock } from "./thinking-block.js";
import { CompactDelegation } from "./compact-delegation.js";
import { TaskResultBlock } from "./result-view.js";
import { WaitingStatus } from "./waiting-status.js";
import { AttachmentCard } from "./attachment-card.js";
import { ModelRecoveryNotice } from "./model-recovery-notice.js";
import { TurnErrorNotice } from "./turn-error-notice.js";
const isEditableMessage = (item: TranscriptItem) =>
  item.author === "user" && item.kind !== "task";
/** 026 R-09：轻量同任务标识（任务名胶囊；查不到退通用词）。 */
function TaskRelation({ title }: { title?: string }) {
  return (
    <span className="h24-task-relation" title="属于这个任务">
      <Link2 className="size-3" aria-hidden="true" />
      {title?.trim() || "所属任务"}
    </span>
  );
}

/**
 * 026 R-09：同一任务的连续阶段简报收成一条进展时间线——每条一行、弱于正式
 * 回答；运行中最新一条高亮为「当前」。超过 STAGE_FOLD_AT 条只留最近几条，
 * 更早的折叠可展开。复制入口统一由回答末尾承载。
 */
export function StageBriefsItem({
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
  const [expanded, setExpanded] = useTranscriptRowState<boolean>(
    "stage-expanded",
    false,
  );
  const shown = visibleStageCount(items.length, expanded);
  const hidden = items.length - shown;
  return (
    <article
      className="h24-hemi-message h24-stage-briefs"
      data-after-card={afterCard && !showRelation ? "true" : undefined}
      data-continuation={continuation ? "true" : undefined}
      data-lead={lead ? "true" : undefined}
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
          {expanded ? "收起较早的进展" : `更早 ${hidden} 条进展`}
        </button>
      ) : null}
      <ol className="h24-stage-list" aria-label="任务进展">
        {items.slice(items.length - shown).map((item, index, list) => (
          <li
            key={item.id}
            className="h24-stage-item"
            data-current={
              current && index === list.length - 1 ? "true" : undefined
            }
            title={new Date(item.createdAt).toLocaleTimeString("zh-CN", {
              hour12: false,
            })}
          >
            <Markdown text={item.text} />
          </li>
        ))}
      </ol>
    </article>
  );
}

/** 复制整轮正文，沿用剪贴板桥、成功图标和失败提示。 */
export function ReplyCopyActions({ text }: { text: string }) {
  const { runtime } = useFlow();
  const { copy, toastNode } = useClipboardCopy();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <div className="h24-msg-actions h24-reply-actions">
        <button
          type="button"
          className="h24-msg-copy"
          disabled={!runtime.can("copyText")}
          aria-description={
            !runtime.can("copyText") ? "当前环境未提供复制" : undefined
          }
          aria-label={copied ? "已复制" : "复制完整回答"}
          title={copied ? "已复制" : "复制完整回答"}
          data-copied={copied ? "true" : undefined}
          onClick={() => void copy(text).then(setCopied)}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      {toastNode}
    </>
  );
}

/**
 * 024 消息形态（设计稿 v4 定稿）：用户消息为右对齐气泡（无头像行，气泡下
 * 「编辑」与状态），Hemi 回复为绿底 H 方块头像 + 名字行 + 开放正文。
 * 编辑框原位替换气泡（右对齐同形）；「重新发送」＝回卷重跑（2026-10-10 仿
 * zcode 语义改版）：这条之后的内容整段撤下、从这条重新提问（lib/message-edit.ts）。
 */
/** 回复正文：Markdown＋末尾证据脚注弱化（050）；062 起可带本地文件链接处理。 */
export function renderReplyText(
  text: string,
  { onLocalLink }: { onLocalLink?: (href: string) => void } = {},
) {
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
function splitEvidenceNote(text: string): {
  body: string;
  note: string | null;
} {
  const raw = String(text ?? "");
  const match = raw.match(
    /\n?\s*(依据上面「[^」]+」的结果整理，未重新查询)\s*$/,
  );
  if (!match) return { body: raw, note: null };
  return { body: raw.slice(0, match.index).trimEnd(), note: match[1] };
}

export function ChatTurnItem({
  item,
  continuation = false,
  lead = false,
  showRelation = true,
  taskTitleOf,
  editing,
  canEdit = true,
  busy,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  onPreviewAttachment,
  renderText,
  renderTask,
  onOpenDeliverable,
  onRetry,
  retryBusy,
  retryBlocked,
  onRecoveryAction,
}: {
  item: TranscriptItem;
  /** 056：回复段里的 task 调用原地渲染子 agent 一行。 */
  renderTask?: (call: { id: string }) => ReactNode;
  /** 062 回复正文渲染（默认无链接态；带 onLocalLink 的版本由 VoiceScreen 注入）。 */
  renderText?: (text: string) => ReactNode;
  /** 062：交付文件入口点击 → 右侧预览。 */
  onOpenDeliverable?: (artifactId: string, name: string) => void;
  onRetry?: () => void;
  onRecoveryAction?: (action: "stop" | "retry", recoveryId: string) => void;
  retryBusy?: boolean;
  retryBlocked?: string;
  /** 连续 Hemi 消息的续条：不重复头像行（受理/简报/终态各自入流时合并）。 */
  continuation?: boolean;
  /** 037：一段 Hemi 输出的首条（data-lead）。 */
  lead?: boolean;
  /** 026 R-09：上一条已属同一任务（紧跟任务卡/同任务简报）时不重复挂标识。 */
  showRelation?: boolean;
  /** 026 R-09：按 taskId 取任务名（渲染轻量同任务标识；查不到退通用词）。 */
  taskTitleOf?: (taskId: string) => string | undefined;
  editing: boolean;
  canEdit?: boolean;
  busy: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onEditResend: (id: string, nextText: string) => void;
  /** 028：历史附件 chip 点击 → 预览宿主（与草稿附件同一入口）。 */
  onPreviewAttachment?: (conversationId: string, attachmentId: string) => void;
}) {
  const [editDraft, setEditDraft] = useTranscriptRowState<string>(
    "edit-draft",
    item.text,
  );
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
  const { runtime } = useFlow();
  const { copy: copyViaToast, toastNode: copyToastNode } = useClipboardCopy();
  const copyMessage = async () => {
    const ok = await copyViaToast(item.text);
    setCopied(ok);
  };

  const editable = canEdit && isEditableMessage(item) && !busy && !editing;
  const streaming = item.live && item.streaming !== false;

  // —— 用户消息：右对齐气泡（设计稿 user-message）——
  if (item.author === "user") {
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
                  if (event.key === "Escape") {
                    event.preventDefault();
                    onCancelEdit();
                  }
                }}
              />
              <div className="h24-edit-footer">
                <span className="h24-edit-note">
                  重新发送会把这条之后的内容撤掉，从这条重新开始。
                </span>
                <div className="h24-edit-actions">
                  <button
                    type="button"
                    className="h24-edit-cancel"
                    onClick={onCancelEdit}
                  >
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
              {item.attachments?.length ? (
                <div
                  className="h24-msg-attachments h-attachment-sent-tray"
                  aria-label="本条消息的附件"
                >
                  {item.attachments.map((attachment) => (
                    <AttachmentCard
                      key={attachment.attachmentId}
                      attachment={attachment}
                      sent
                      onOpen={
                        onPreviewAttachment
                          ? () =>
                              onPreviewAttachment(
                                attachment.conversationId,
                                attachment.attachmentId,
                              )
                          : undefined
                      }
                    />
                  ))}
                </div>
              ) : null}
              {/* 063：行内标签（技能＋四类引用）随正文原位回显；旧三类引用芯片在下方。 */}
              {item.text.trim() ? (
                <p className="h24-user-bubble">
                  {segmentTaggedText(item.text, {
                    skills: item.skills ?? [],
                    references: item.references ?? [],
                  }).map((segment, index) =>
                    segment.type === "text" ? (
                      <span key={index}>{segment.text}</span>
                    ) : (
                      <span
                        key={index}
                        className="composer-inline-tag h63-msg-tag"
                        data-kind={
                          segment.type === "skill"
                            ? "skill"
                            : segment.reference.kind
                        }
                        title={
                          segment.type === "skill"
                            ? `技能 · ${segment.skill.name}${segment.skill.source === "project" ? " · 项目技能" : " · 技能库"}`
                            : segment.reference.subtitle
                        }
                      >
                        {segment.text}
                      </span>
                    ),
                  )}
                </p>
              ) : null}
              {/* 028 R-04：历史回看能分清本条消息实际携带的附件（点击进预览宿主）。 */}
              {item.references?.length ? (
                <div
                  className="h24-msg-attachments"
                  aria-label="本条消息的引用"
                >
                  {item.references.map((reference) => (
                    <span
                      key={reference.key}
                      className="h24-msg-attachment"
                      title={`${reference.name} · ${reference.subtitle}`}
                    >
                      <Link2 className="size-3" aria-hidden="true" />
                      <span>{reference.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="h24-user-actions">
                {/* 037 细节：复制 / 编辑统一为 24px 图标钮（悬停出现，title 提示）；已复制换勾。 */}
                <button
                  type="button"
                  className="h24-msg-copy"
                  disabled={!runtime.can("copyText")}
                  aria-description={
                    !runtime.can("copyText") ? "当前环境未提供复制" : undefined
                  }
                  aria-label={copied ? "已复制" : "复制这条消息"}
                  title={copied ? "已复制" : "复制"}
                  data-copied={copied ? "true" : undefined}
                  onClick={() => void copyMessage()}
                >
                  {copied ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </button>
                {item.queuedForSend ? (
                  <span className="h24-user-status is-pending">排队中</span>
                ) : null}
                {item.editedAt ? (
                  <span className="h24-user-status">已编辑</span>
                ) : null}
                {item.withdrawn ? (
                  <span className="h24-user-status">已撤回，未发送</span>
                ) : null}
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
  if (item.kind === "error") {
    return (
      <article
        className="h24-hemi-message"
        data-error="true"
        data-continuation={continuation ? "true" : undefined}
        data-lead={lead ? "true" : undefined}
      >
        {item.recovery ? <ModelRecoveryNotice recovery={item.recovery} onAction={onRecoveryAction} onRestart={onRetry} failureText={item.text} /> : <TurnErrorNotice
          message={item.text}
          onRetry={onRetry}
          busy={retryBusy}
          blocked={onRetry ? retryBlocked : undefined}
        />}
      </article>
    );
  }
  return (
    <>
      <article
        className="h24-hemi-message"
        data-continuation={continuation ? "true" : undefined}
        data-lead={lead ? "true" : undefined}
      >
        {item.taskId && showRelation ? (
          <TaskRelation title={taskTitleOf?.(item.taskId)} />
        ) : null}
        {/* 029 R-02：被用户停止的未完成回复——增量原位保留，明确标注，不伪装成失败。 */}
        {item.replyStatus === "stopped" ? (
          <span className="h24-reply-stopped" role="status">
            未完成 · 已停止
          </span>
        ) : null}
        {streaming && !item.recovery && !item.parts?.length && !item.text ? (
          <WaitingStatus />
        ) : null}
        {streaming &&
        !item.recovery && item.text &&
        !item.parts?.some((part) => part.type !== "text") ? (
          <span className="h24-reply-status" role="status">
            回应中
          </span>
        ) : null}
        {/* 056：有按序的段（思考／正文／工具组）就照接口返回的先后从上往下排；旧档走 048 形态。 */}
        {item.parts?.length ? (
          <TurnParts
            parts={item.parts}
            live={streaming}
            renderText={renderText ?? ((text: string) => renderReplyText(text))}
            renderTask={renderTask}
            onOpenDeliverable={onOpenDeliverable}
          />
        ) : (
          <>
            {/* 048：思考折叠头（档案回看可展开；中断轮显示「思考已中断」）。 */}
            {item.thinking ? (
              <ThinkingBlock
                state={item.thinking.interrupted ? "interrupted" : "done"}
                text={item.thinking.text}
                durationMs={item.thinking.durationMs}
              />
            ) : null}
            {item.text.trim() ? (
              <div className="chat-copy assistant-copy">
                {(renderText ?? renderReplyText)(item.text)}
              </div>
            ) : null}
          </>
        )}
        {item.recovery ? <ModelRecoveryNotice recovery={item.recovery} onAction={onRecoveryAction} /> : null}
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
export function TaskTranscriptItem({
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
  onTaskAction?: (
    action: TaskActionName,
    payload?: {
      choice?: TaskPermissionChoice;
      taskId?: string;
      taskKey?: string;
    },
  ) => void;
  /** 025 v3：打开/收起该任务的过程抽屉。 */
  onOpenProcess?: (snap: TaskStateSnapshot) => void;
  onOpenArtifact?: (
    taskId: string,
    artifactId: string,
    intent: "open" | "reveal",
  ) => void;
  /** 026 R-05：可预览文件的应用内阅读。 */
  onOpenPreview?: (taskId: string, artifactId: string) => void;
  /** 027 R-04：结果正文进右侧阅读区。 */
  onOpenReportPreview?: (snap: TaskStateSnapshot) => void;
}) {
  // 卡身份：taskId 优先（2026-09-23 唯一标识收敛）。冻结项（taskFrozen）的
  // 快照表里可能已被活卡覆盖——冻结项一律用自己内嵌的 taskSnap（并入瞬间状态）。
  const snapKey =
    item.taskId ??
    item.taskSnap?.taskId ??
    item.taskKey ??
    item.taskSnap?.key ??
    (item.taskSeq != null ? `s${item.taskSeq}` : null);
  const snap = item.taskFrozen
    ? (item.taskSnap ?? undefined)
    : ((snapKey ? taskSnaps?.[snapKey] : undefined) ??
      item.taskSnap ??
      undefined);
  if (!snap) return null;
  const legacyResult =
    !snap.agent &&
    snap.phase === "terminal" &&
    !snap.verifying &&
    Boolean(
      snap.resultText?.trim() ||
        snap.artifacts?.length ||
        snap.fileChanges?.files?.length,
    );
  const taskId = snap.taskId ?? "";
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
            onOpenBodyWide={
              onOpenReportPreview ? () => onOpenReportPreview(snap) : undefined
            }
            onOpenArtifact={
              onOpenArtifact
                ? (artifactId, intent) =>
                    onOpenArtifact(taskId, artifactId, intent)
                : undefined
            }
            onOpenPreview={
              onOpenPreview
                ? (artifactId) => onOpenPreview(taskId, artifactId)
                : undefined
            }
          />
        </div>
      ) : null}
    </>
  );
}
