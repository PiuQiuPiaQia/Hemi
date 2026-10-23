import { useWorkflowActions } from "../host/workflow-actions.js";
import { useFlow } from "../host/context.js";
import type { WorkflowCardView } from "../types/api.js";
import { useEffect, useId, useRef, useState } from "react";
import { useTranscriptRowState } from "./transcript-row-state.js";
import { FileText, Workflow, Check, ExternalLink } from "lucide-react";
import type {
  TurnPart,
  ModelProfilesDirectory,
} from "../types/presentation.js";
import type {
  WorkflowExecutionModel,
  WorkflowInteractionProjection,
} from "../types/presentation.js";
import { ModelSelectorChip } from "./model-selector.js";
import type {
  WorkflowDocument,
  WorkflowInputParameter,
} from "../types/presentation.js";
import {
  WorkflowParametersDialog,
  type PreparedWorkflow,
} from "./workflow-parameters-dialog.js";

type Card = WorkflowCardView;
const STATUS: Record<string, string> = {
  preparing: "准备参数",
  queued: "排队中",
  starting: "排队中",
  running: "运行中",
  stopping: "正在停止",
  waiting: "等待操作",
  completed: "已完成",
  stopped: "已停止",
  failed: "失败",
  interrupted: "执行中断",
  abandoned: "已取消准备",
};

/** 人工输入内容的最小安全渲染：段落＋**粗体**（不执行 HTML，不夸大成完整 Markdown）。 */
function InteractionContent({ text }: { text: string }) {
  return (
    <div className="h59-hi-content selectable">
      {String(text ?? "")
        .split(/\n{2,}/)
        .map((paragraph, i) => (
          <p key={i}>
            {paragraph
              .split(/(\*\*[^*]+\*\*)/g)
              .map((chunk, j) =>
                chunk.startsWith("**") && chunk.endsWith("**") ? (
                  <strong key={j}>{chunk.slice(2, -2)}</strong>
                ) : (
                  <span key={j}>{chunk}</span>
                ),
              )}
          </p>
        ))}
    </div>
  );
}
export function WorkflowCard({
  card,
  presentation = "inline",
}: {
  card: Card;
  presentation?: "inline" | "result";
}) {
  const instanceId = useId();
  const [reviewed, setReviewed] = useTranscriptRowState(
    "workflow-reviewed",
    false,
  );
  const { runtime } = useFlow();
  const workflow = useWorkflowActions(card);
  const presentationData = card.presentation;
  const nodeTitle = presentationData?.nodeTitle ?? "执行步骤";
  const labels = presentationData?.labels ?? {};
  const version = presentationData?.revision ?? null;
  const outline = presentationData?.outline ?? "";
  const [parameterEditor, setParameterEditor] = useState<
    (PreparedWorkflow & { parameters: WorkflowInputParameter[] }) | null
  >(null);
  const [resolution, setResolution] = useTranscriptRowState(
    "workflow-resolution",
    "retry",
  );
  const [resumeMessage, setResumeMessage] = useTranscriptRowState(
    "workflow-resume-message",
    "",
  );
  const resumeFields = presentationData?.resumeFields ?? {};
  const [verifiedValues, setVerifiedValues] = useTranscriptRowState<
    Record<string, string>
  >("workflow-verified-values", {});
  const [pending, setBusy] = useState(false);
  const busy = pending || !runtime.actionable || Boolean(card.readOnly);
  const [error, setError] = useState("");
  const directory = presentationData?.models ?? null;
  const requestId = useRef(`workflow-start-${card.invocationId}`);
  // ── 人工输入表单（HI 通用节点）：同 schema 渲染；草稿防抖落盘、提交带版本 CAS ──
  const interaction = card.interaction ?? null;
  const interactionOpen =
    interaction?.status === "open" &&
    ["waiting", "running", "queued"].includes(card.status);
  const [formValues, setFormValues] = useTranscriptRowState<
    Record<string, unknown>
  >("workflow-form-values", {});
  const [formRevision, setFormRevision] = useTranscriptRowState<number | null>(
    "workflow-form-revision",
    null,
  );
  const [formLoadedFor, setFormLoadedFor] = useTranscriptRowState<
    string | null
  >("workflow-form-loaded-for", null);
  const submitRequestId = useRef("");
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!interaction) return;
    if (formLoadedFor === interaction.interactionId) return;
    setFormLoadedFor(interaction.interactionId);
    const initial: Record<string, unknown> = {};
    for (const field of interaction.fields) {
      const saved = interaction.draft?.values?.[field.key];
      if (field.type === "text")
        initial[field.key] =
          typeof saved === "string" ? saved : (field.prefill ?? "");
      else if (field.type === "files")
        initial[field.key] = Array.isArray(saved) ? saved : [];
      else initial[field.key] = saved ?? "";
    }
    setFormValues(initial);
    setFormRevision(interaction.revision);
  }, [interaction?.interactionId, interaction?.status]);
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );
  const formValuesRef = useRef(formValues);
  formValuesRef.current = formValues;
  const revisionRef = useRef<number | null>(null);
  if (revisionRef.current === null)
    revisionRef.current = formRevision ?? interaction?.revision ?? null;
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const saveDraft = () => {
    if (!interaction) return Promise.reject(new Error("此输入请求已结束"));
    const values = { ...formValuesRef.current };
    const save = saveChain.current
      .catch(() => {})
      .then(async () => {
        if (!mounted.current || runtime.disposed)
          throw new Error("对话流已关闭");
        const result = await workflow.workflowSaveInteractionDraft({
          invocationId: card.invocationId,
          interactionId: interaction.interactionId,
          values,
          expectedRevision: revisionRef.current ?? interaction.revision,
        });
        if (runtime.disposed) throw new Error("对话流已关闭");
        revisionRef.current = result.revision ?? null;
        setFormRevision(result.revision ?? null);
        return result;
      });
    saveChain.current = save;
    return save;
  };
  const setFieldValue = (field: { key: string; type: string }, raw: string) => {
    if (busy) return;
    const value =
      field.type === "files"
        ? raw
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : raw;
    formValuesRef.current = { ...formValuesRef.current, [field.key]: value };
    setFormValues(formValuesRef.current);
    if (!interaction) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      void saveDraft().catch((error) => {
        if (mounted.current && !runtime.disposed)
          setError(error instanceof Error ? error.message : "草稿没有保存成功");
      });
    }, 800);
  };
  const submitInteraction = (actionId: string) =>
    void perform(async () => {
      if (!interaction) return;
      if (!submitRequestId.current)
        submitRequestId.current = `hi-submit-${interaction.interactionId}-${Date.now()}`;
      // 先冲净草稿（防抖未落的部分）；提交的 expectedRevision 用 flush 的同步返回值
      //（setState 异步生效，读 state 会拿到闭包旧值）。
      if (draftTimer.current) clearTimeout(draftTimer.current);
      const flushed = await saveDraft();
      const revision = flushed.revision;
      const result = (await workflow.workflowSubmitInteraction({
        invocationId: card.invocationId,
        interactionId: interaction.interactionId,
        requestId: submitRequestId.current,
        actionId,
        values: formValuesRef.current,
        expectedRevision: revision,
      })) as { ok?: boolean; code?: string; message?: string };
      if (result && result.ok === false)
        throw new Error(String(result.message ?? result.code ?? "提交失败"));
    });
  const preparing = card.status === "preparing";
  useEffect(() => {
    setParameterEditor(null);
  }, [card.invocationId, preparing]);
  const perform = async (operation: () => Promise<unknown>) => {
    if (busy || !mounted.current || runtime.disposed) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      if (mounted.current && !runtime.disposed)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && !runtime.disposed) setBusy(false);
    }
  };
  const selectModel = (key: string) =>
    void perform(() =>
      workflow.workflowUpdatePreparation({
        invocationId: card.invocationId,
        expectedDraftRevision: card.draftRevision,
        executionModel:
          key === "auto" ? { mode: "auto" } : { mode: "fixed", modelKey: key },
      }),
    );
  const selection = card.executionModel as WorkflowExecutionModel | null;
  return (
    <>
      <article
        className={`h59-card${presentation === "result" ? " h59-result-card" : ""}`}
        data-testid="workflow-card"
        data-status={card.status}
      >
        {presentationData?.error ? (
          <p className="h59-error" role="status">
            {presentationData.error}
            <button
              type="button"
              disabled={!runtime.actionable}
              onClick={() =>
                void runtime.action({
                  type: "workflow.load-presentation",
                  targetId: card.invocationId,
                  invocationId: card.invocationId,
                })
              }
            >
              重试
            </button>
          </p>
        ) : null}
        <header>
          <span className="h59-card-symbol">
            <Workflow aria-hidden="true" />
          </span>
          <div>
            <strong>{card.title || "工作流"}</strong>
            <small>
              {version ? `v${version} · ` : ""}
              {preparing ? "参数已齐全后，点击开始运行" : "本次执行"}
            </small>
          </div>
          <span className="h59-status-pill">
            {preparing && card.ready
              ? "待执行"
              : interactionOpen
                ? "等待输入"
                : (STATUS[card.status] ?? card.status)}
          </span>
        </header>
        {Object.keys(card.values ?? {}).length > 0 || card.executionModel ? (
          <dl data-testid="workflow-card-values">
            {Object.entries(card.values ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt>{labels[key] || key}</dt>
                <dd>
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
            {preparing || selection ? (
              <div>
                <dt>执行模型</dt>
                <dd>
                  {preparing ? (
                    <ModelSelectorChip
                      directory={directory}
                      currentProfileId={
                        selection?.mode === "auto"
                          ? "auto"
                          : (selection?.modelKey ?? null)
                      }
                      onSelect={selectModel}
                    />
                  ) : selection?.mode === "auto" ? (
                    "自动路由"
                  ) : (
                    (card.modelLabel ?? selection?.modelKey)
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <div className="h59-card-body">
          {card.totalCount != null ? (
            <div className="h59-card-progress-label">
              <strong>
                {preparing
                  ? card.ready
                    ? "等待你开始运行"
                    : "请补充所需参数"
                  : card.status === "running"
                    ? `正在${nodeTitle || "执行"}`
                    : (STATUS[card.status] ?? card.status)}
              </strong>
              <span>
                {card.completedCount ?? 0} / {card.totalCount} 个步骤完成
              </span>
            </div>
          ) : null}
          {card.resourceWaiting && card.status === "running" ? (
            <p>正在等待另一任务释放桌面／浏览器，停止可退出等待。</p>
          ) : null}
          {card.totalCount != null ? (
            <div
              className="h59-step-progress"
              role="progressbar"
              aria-label="工作流步骤完成进度"
              aria-valuemin={0}
              aria-valuemax={card.totalCount}
              aria-valuenow={card.completedCount ?? 0}
            >
              <span
                style={{
                  width: `${card.totalCount ? Math.min(100, ((card.completedCount ?? 0) / card.totalCount) * 100) : 0}%`,
                }}
              />
            </div>
          ) : null}
          {preparing && outline ? <p className="h59-hint">{outline}</p> : null}
          {interaction ? (
            <section
              className="h59-hi"
              data-testid="workflow-interaction"
              data-hi-status={interaction.status}
            >
              <header>
                <strong>{interaction.title}</strong>
                {interaction.hasTimeout && interaction.expiresAt ? (
                  <small>
                    等待至{" "}
                    {new Date(interaction.expiresAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                    ，超时走独立分支
                  </small>
                ) : (
                  <small>持续等待你的输入</small>
                )}
              </header>
              <InteractionContent text={interaction.content} />
              {interaction.contentIssues.length > 0
                ? interaction.contentIssues.map((issue) => (
                    <p className="h59-error" key={issue}>
                      {issue}
                    </p>
                  ))
                : null}
              {interaction.response ? (
                <div
                  className="h59-hi-record"
                  data-testid="workflow-interaction-record"
                >
                  <header>
                    <Check aria-hidden="true" />
                    <strong>确认处理结果</strong>
                    <small>
                      {new Date(
                        interaction.response.submittedAt,
                      ).toLocaleString("zh-CN", { hour12: false })}
                      {interaction.response.source === "timeout"
                        ? " · 等待超时自动进入该分支（不是人工选择）"
                        : " · 已提交"}
                    </small>
                  </header>
                  <dl>
                    {interaction.fields.map((field) => {
                      const value = interaction.response?.values?.[field.key];
                      return (
                        <div key={field.key}>
                          <dt>{field.label}</dt>
                          <dd className="selectable">
                            {Array.isArray(value)
                              ? value.join("、")
                              : String(value ?? "—")}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  {(() => {
                    const chosen =
                      interaction.actions.find(
                        (a) => a.actionId === interaction.response?.actionId,
                      ) ?? null;
                    const nextTitle =
                      interaction.response?.source === "timeout"
                        ? interaction.timeoutNextTitle
                        : chosen?.nextTitle;
                    const label =
                      interaction.response?.source === "timeout"
                        ? "等待超时"
                        : interaction.response?.actionLabel;
                    return (
                      <footer className="h59-hi-chosen">
                        已选操作：<strong>{label}</strong>
                        {nextTitle ? ` › ${nextTitle}` : ""}
                      </footer>
                    );
                  })()}
                  <p className="h59-hi-footnote">
                    这条响应只会受理一次；后续排队与执行状态另行更新。
                  </p>
                  {interaction.resumePending && card.status === "waiting" ? (
                    <div className="h59-hi-retry">
                      <p role="status">
                        提交已保存，尚未进入队列。可以重试继续运行。
                      </p>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const result = await workflow.workflowContinue({
                              invocationId: card.invocationId,
                              requestId: `retry-interaction-${interaction.interactionId}`,
                            });
                            if (result?.ok === false)
                              throw new Error(
                                String(
                                  result.message ?? result.code ?? "续跑失败",
                                ),
                              );
                          })
                        }
                      >
                        重试继续运行
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : interactionOpen ? (
                <div className="h59-hi-form">
                  {interaction.fields.map((field) => {
                    const value = formValues[field.key];
                    const requiredMark =
                      field.required ||
                      interaction.actions.some((action) =>
                        action.requiredKeys.includes(field.key),
                      )
                        ? " *"
                        : "";
                    return (
                      <label key={field.key}>
                        <span>
                          {field.label}
                          {requiredMark}
                        </span>
                        {field.type === "text" ? (
                          <textarea
                            disabled={busy}
                            aria-label={field.label}
                            value={String(value ?? "")}
                            onChange={(e) =>
                              setFieldValue(field, e.target.value)
                            }
                          />
                        ) : field.type === "choice" ? (
                          <div
                            className="h59-hi-options"
                            role="radiogroup"
                            aria-label={field.label}
                          >
                            {(field.options ?? []).map((option) => (
                              <label
                                key={option}
                                className="h59-hi-option"
                                data-selected={value === option || undefined}
                              >
                                <input
                                  disabled={busy}
                                  type="radio"
                                  name={`${instanceId}-hi-${interaction.interactionId}-${field.key}`}
                                  aria-label={option}
                                  checked={value === option}
                                  onChange={() => setFieldValue(field, option)}
                                />
                                <span>{option}</span>
                              </label>
                            ))}
                            {field.optionsError ? (
                              <small className="h59-error">
                                {field.optionsError}
                              </small>
                            ) : null}
                          </div>
                        ) : field.type === "files" ? (
                          <textarea
                            disabled={busy}
                            aria-label={field.label}
                            placeholder="每行一个文件路径"
                            value={(Array.isArray(value) ? value : []).join(
                              "\n",
                            )}
                            onChange={(e) =>
                              setFieldValue(field, e.target.value)
                            }
                          />
                        ) : (
                          <input
                            disabled={busy}
                            type="text"
                            aria-label={field.label}
                            placeholder="文件路径"
                            value={String(value ?? "")}
                            onChange={(e) =>
                              setFieldValue(field, e.target.value)
                            }
                          />
                        )}
                      </label>
                    );
                  })}
                  <p className="h59-hi-footnote">
                    完成后按所选操作继续；本表单只受理一次。
                  </p>
                  <div
                    className="h59-hi-actions"
                    role="group"
                    aria-label="选择操作"
                  >
                    {interaction.actions.map((action) => (
                      <button
                        key={action.actionId}
                        className={
                          action.primary ? "h37-btn h37-btn-primary" : undefined
                        }
                        disabled={busy}
                        onClick={() => submitInteraction(action.actionId)}
                      >
                        {action.label}
                        {action.nextTitle ? `：${action.nextTitle}` : ""}
                        {action.requiredKeys.length > 0
                          ? `（需填：${action.requiredKeys
                              .map(
                                (key) =>
                                  interaction.fields.find((f) => f.key === key)
                                    ?.label ?? key,
                              )
                              .join("、")}）`
                          : ""}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p>
                  {interaction.status === "cancelled"
                    ? "该请求已取消。"
                    : "该请求已关闭。"}
                </p>
              )}
            </section>
          ) : null}
          {card.waitingReason && card.status === "waiting" && !interaction ? (
            <p>{card.waitingReason}</p>
          ) : null}
          {card.status === "waiting" && !interaction ? (
            <label className="h59-resolve">
              补充信息（可选）
              <textarea
                disabled={busy}
                aria-label="继续时补充信息"
                value={resumeMessage}
                maxLength={4000}
                onChange={(e) => setResumeMessage(e.target.value)}
              />
            </label>
          ) : null}
          {card.status === "interrupted" || card.needsReview ? (
            <div className="h59-resolve">
              <label>
                外部状态核对
                <select
                  aria-label="核对后的处理方式"
                  value={resolution}
                  onChange={(e) => {
                    setResolution(e.target.value);
                    setReviewed(false);
                  }}
                >
                  <option value="retry">确认未完成，重新尝试当前步骤</option>
                  <option value="accept">确认已完成，登记结果后继续后继</option>
                </select>
              </label>
              {resolution === "accept"
                ? Object.entries(resumeFields).map(([key, field]) => (
                    <label key={key}>
                      {key}（{field.type}）
                      <input
                        disabled={busy}
                        value={verifiedValues[key] ?? ""}
                        onChange={(e) =>
                          setVerifiedValues((values) => ({
                            ...values,
                            [key]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))
                : null}
            </div>
          ) : null}
          {card.status === "interrupted" || card.needsReview ? (
            <label className="h59-review">
              <input
                disabled={busy}
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>
                {resolution === "accept"
                  ? "已核对外部结果，确认当前步骤已完成"
                  : "已核对外部结果，确认允许重新尝试当前步骤"}
              </span>
            </label>
          ) : null}
          {(card.issues ?? [])
            .filter((issue) => issue.message !== (error || card.error))
            .map((issue, i) => (
              <p className="h59-error" key={`${issue.code}-${i}`}>
                {issue.message}
              </p>
            ))}
          {card.error || error ? (
            <p className="h59-error" role="alert">
              {error || card.error}
            </p>
          ) : null}
          {Object.entries(card.outputs ?? {})
            .filter(([key]) => !key.startsWith("__"))
            .map(([key, value]) => {
              const files = card.fileOutputs?.includes(key)
                ? (Array.isArray(value) ? value : [value]).filter(
                    (file): file is string => typeof file === "string",
                  )
                : [];
              return (
                <div className="h59-output" key={key}>
                  <span>{key}</span>
                  {files.length ? (
                    files.map((file) => (
                      <div className="h59-file" key={file}>
                        <p>
                          <FileText aria-hidden="true" />
                          <strong className="selectable">
                            {file.split(/[\\/]/).at(-1) || file}
                          </strong>
                        </p>
                        {card.status === "completed" ? (
                          <button
                            className="h37-btn h37-btn-primary"
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                workflow.workflowOpenArtifact(
                                  card.invocationId,
                                  file,
                                ),
                              )
                            }
                          >
                            <ExternalLink aria-hidden="true" />
                            <span className="sr-only">打开文件</span>
                          </button>
                        ) : null}
                        <details>
                          <summary>文件位置</summary>
                          <p className="selectable">{file}</p>
                        </details>
                      </div>
                    ))
                  ) : (
                    <p className="selectable">
                      {typeof value === "string"
                        ? value
                        : JSON.stringify(value)}
                    </p>
                  )}
                </div>
              );
            })}
        </div>
        <footer>
          {preparing ? (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (!presentationData)
                      throw new Error("参数展示数据尚未就绪，请重试");
                    setParameterEditor({
                      invocationId: card.invocationId,
                      conversationId: card.conversationId ?? "",
                      cardId: card.cardId ?? "",
                      draftRevision: card.draftRevision ?? 0,
                      values: card.values ?? {},
                      parameters: presentationData.parameters,
                    });
                  })
                }
              >
                修改参数
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    workflow.workflowUpdatePreparation({
                      invocationId: card.invocationId,
                      expectedDraftRevision: card.draftRevision,
                      values: card.values ?? {},
                    }),
                  )
                }
              >
                重新检查
              </button>
            </>
          ) : null}
          {preparing ? (
            <button
              className="h37-btn h37-btn-primary"
              disabled={busy || !card.ready}
              onClick={() =>
                void perform(async () => {
                  const result = await workflow.workflowStartPrepared({
                    invocationId: card.invocationId,
                    cardId: card.cardId,
                    expectedDraftRevision: card.draftRevision,
                    conversationId: card.conversationId ?? "",
                    requestId: requestId.current,
                  });
                  if (!result.ok)
                    throw new Error(
                      String(result.message ?? result.code ?? "启动失败"),
                    );
                })
              }
            >
              开始运行
            </button>
          ) : null}
          {["running", "queued", "starting", "waiting"].includes(card.status) &&
          card.workflowRunId ? (
            <button
              disabled={busy}
              onClick={() =>
                void perform(() => workflow.workflowStop(card.workflowRunId!))
              }
            >
              停止
            </button>
          ) : null}
          {["waiting", "failed", "interrupted"].includes(card.status) &&
          !interaction ? (
            <button
              className="h37-btn h37-btn-primary"
              disabled={
                busy ||
                ((card.status === "interrupted" || card.needsReview) &&
                  !reviewed)
              }
              onClick={() =>
                void perform(() =>
                  workflow.workflowContinue({
                    invocationId: card.invocationId,
                    requestId: `continue-${card.invocationId}-${card.draftRevision}-${Date.now()}`,
                    confirmed: reviewed,
                    resumeMessage,
                    ...(resolution === "accept"
                      ? {
                          verifiedOutputs: Object.fromEntries(
                            Object.entries(resumeFields).map(([key, field]) => [
                              key,
                              field.type === "number"
                                ? Number(verifiedValues[key])
                                : [
                                      "boolean",
                                      "array",
                                      "object",
                                      "files",
                                    ].includes(field.type)
                                  ? JSON.parse(verifiedValues[key] ?? "null")
                                  : (verifiedValues[key] ?? ""),
                            ]),
                          ),
                        }
                      : {}),
                  }),
                )
              }
            >
              继续运行
            </button>
          ) : null}
          <button
            className="h59-open-process"
            onClick={() =>
              void runtime.action({
                type: "preview.open",
                target: "workflow",
                targetId: card.invocationId,
                invocationId: card.invocationId,
              })
            }
          >
            {preparing ? "查看流程" : "查看过程"}
          </button>
          {preparing ? (
            <button
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  workflow.workflowAbandon({
                    invocationId: card.invocationId,
                    conversationId: card.conversationId,
                  }),
                )
              }
            >
              取消准备
            </button>
          ) : null}
        </footer>
      </article>
      {parameterEditor && preparing ? (
        <WorkflowParametersDialog
          mode="prepare"
          prepared={parameterEditor}
          parameters={parameterEditor.parameters}
          directory={directory}
          currentModelKey={
            selection?.mode === "fixed" ? selection.modelKey : "auto"
          }
          busy={busy}
          error={error}
          onCancel={() => setParameterEditor(null)}
          onRun={(values, modelKey) =>
            perform(async () => {
              await workflow.workflowUpdatePreparation({
                invocationId: parameterEditor.invocationId,
                expectedDraftRevision: parameterEditor.draftRevision,
                values,
                executionModel:
                  modelKey && modelKey !== "auto"
                    ? { mode: "fixed", modelKey }
                    : { mode: "auto" },
              });
              setParameterEditor(null);
            })
          }
        />
      ) : null}
    </>
  );
}
