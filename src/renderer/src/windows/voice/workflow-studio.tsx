import type { WorkflowInputParameter } from "@shared/workflow.mjs";
import { resolveRelativeDate } from "@shared/workflow-parameter-defaults.mjs";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  WorkflowDefinitionSummary,
  WorkflowExecutionModel,
} from "@shared/protocol";
import type { ModelProfilesDirectory } from "@/shared/types";
import type { CanvasDocument } from "./workflow-canvas";
import { WorkflowEditorBoundary } from "./workflow-editor-boundary";
const WorkflowCanvas = lazy(() =>
  import("./workflow-canvas").then((module) => ({
    default: module.WorkflowCanvas,
  })),
);
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ModelSelectorChip } from "./model-selector";
import { WorkflowHistory } from "./workflow-history";
import {
  WorkflowParametersDialog,
  type PreparedWorkflow,
} from "./workflow-parameters-dialog";
import { WorkflowPage } from "./workflow-page";
import { WorkflowResult } from "./workflow-result";
import type {
  TaskStateSnapshot,
  TaskActionName,
  TaskPermissionChoice,
  InstalledSkill,
} from "@/shared/types";
import {
  ArrowLeft,
  Blocks,
  GitBranch,
  MessageCircle,
  Monitor,
  Play,
  Plus,
  Search,
  Workflow,
  Ellipsis,
  FolderOpen,
  FileText,
  Presentation,
  Settings,
  Globe,
  Folder,
  Trash2,
} from "lucide-react";
import { workflowPresentation } from "./lib/workflow-presentation";
import { confirmWorkflowLeave } from "./workflow-leave-guard";
import "@/styles/059-workflows.css";

type EditorTarget = {
  workflowId: string;
  name: string;
  document: CanvasDocument;
  draftRevision: number | null;
  publishedRevision?: number;
};
const BLANK_DOCUMENT: CanvasDocument = {
  nodes: [
    {
      id: "in",
      type: "hemi-input",
      meta: { position: { x: 234, y: 20 } },
      data: {
        title: "输入",
        parameters: [
          { key: "topic", type: "string", required: true, label: "主题" },
        ],
      },
    },
    {
      id: "deliver",
      type: "hemi-deliver",
      meta: { position: { x: 234, y: 260 } },
      data: { title: "交付", summary: "交付说明" },
    },
  ],
  edges: [{ sourceNodeID: "in", targetNodeID: "deliver" }],
};
export function WorkflowStudio({
  conversationId,
  currentProfileId,
  modelProfiles,
  onOpenConversation,
  onOpenDefinitionPreview,
  onClosePreview,
  onTitleChange,
  onNavigate,
  taskState,
  onTaskAction,
}: {
  conversationId: string | null;
  currentProfileId?: string | null;
  modelProfiles?: ModelProfilesDirectory | null;
  onOpenConversation?: (id: string) => void;
  onOpenDefinitionPreview?: (id: string, revision: number) => void;
  onClosePreview?: () => void;
  onTitleChange?: (title: string) => void;
  onNavigate?: () => void;
  taskState?: TaskStateSnapshot | null;
  onTaskAction: (
    action: TaskActionName,
    payload?: { choice?: TaskPermissionChoice; taskId?: string },
  ) => void;
}) {
  const actionPending = useRef(false);
  const [rows, setRows] = useState<WorkflowDefinitionSummary[]>([]);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const requestDelete = (workflowId: string) => {
    setNotice("");
    setDeleting(workflowId);
  };
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<WorkflowDefinitionSummary | null>(null);
  const [result, setResult] = useState<{
    invocationId: string;
    conversationId: string;
  } | null>(null);
  const [runSettings, setRunSettings] = useState<PreparedWorkflow | null>(null);
  const [detailDocument, setDetailDocument] = useState<CanvasDocument | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    setDetailDocument(null);
    if (detail)
      void (
        detail.published
          ? window.hemiVoice.workflowGetRevision(
              detail.workflowId,
              detail.published.revision,
            )
          : window.hemiVoice.workflowGetDraft(detail.workflowId)
      )
        .then((record) => {
          if (alive)
            setDetailDocument((record?.document as CanvasDocument) ?? null);
        })
        .catch((error) => {
          if (alive) setNotice(String(error));
        });
    return () => {
      alive = false;
    };
  }, [detail?.workflowId, detail?.published?.revision]);
  useEffect(() => {
    onTitleChange?.(
      editor?.name ?? detail?.name ?? (result ? "运行结果" : "工作流"),
    );
  }, [editor?.name, detail?.name, Boolean(result), onTitleChange]);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  useEffect(() => {
    let alive = true;
    void window.hemiVoice
      .getSkillState()
      .then((state) => {
        if (alive)
          setInstalledSkills(state.installed.filter((skill) => skill.enabled));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const [directory, setDirectory] = useState<ModelProfilesDirectory | null>(
    modelProfiles ?? null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    void window.hemiVoice
      .listModelProfiles()
      .then((d) => {
        setDirectory(d);
        setSelected(d.defaultModelId);
      })
      .catch((e) => setNotice(String(e)));
  }, []);
  const refresh = useCallback(async () => {
    const next = await window.hemiVoice.workflowList();
    setRows(next);
    setDetail((current) =>
      current
        ? (next.find((row) => row.workflowId === current.workflowId) ?? null)
        : null,
    );
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setNotice(String(e)));
  }, [refresh]);
  const perform = async (fn: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  const startPrepared = async (prepared: PreparedWorkflow) => {
    const receipt = await window.hemiVoice.workflowStartPrepared({
      invocationId: prepared.invocationId,
      cardId: prepared.cardId,
      expectedDraftRevision: prepared.draftRevision,
      requestId: `start-${prepared.invocationId}`,
      conversationId: prepared.conversationId,
    });
    if (!receipt.ok) throw new Error(String(receipt.message ?? receipt.code));
    setEditor(null);
    setRunSettings(null);
    onClosePreview?.();
    setResult({
      invocationId: prepared.invocationId,
      conversationId: prepared.conversationId,
    });
  };
  const openRunSettings = async () => {
    if (!detail?.published) return;
    const prep = await window.hemiVoice.workflowPrepare({
      workflowId: detail.workflowId,
      revision: detail.published.revision,
      conversationId,
      entryMode: "direct",
      executionModel:
        selected === "auto"
          ? { mode: "auto" }
          : selected
            ? { mode: "fixed", modelKey: selected }
            : undefined,
      profileId: currentProfileId,
    });
    setRunSettings({
      invocationId: String(prep.invocationId),
      conversationId: String(prep.conversationId),
      cardId: String(prep.cardId),
      draftRevision: Number(prep.draftRevision),
      values: (prep.values ?? {}) as Record<string, unknown>,
    });
  };
  const run = async (
    row: WorkflowDefinitionSummary,
    mode: "chat" | "direct" | "editor-test",
    chosen = selected,
  ) => {
    const executionModel: WorkflowExecutionModel | undefined =
      mode === "chat"
        ? undefined
        : chosen === "auto"
          ? { mode: "auto" }
          : chosen
            ? { mode: "fixed", modelKey: chosen }
            : undefined;
    const prep = await window.hemiVoice.workflowPrepare({
      workflowId: row.workflowId,
      revision: row.published?.revision,
      conversationId,
      entryMode: mode,
      executionModel,
      profileId: currentProfileId,
    });
    const cid = String(prep.conversationId);
    if (mode !== "chat" && prep.ready) {
      await startPrepared({
        invocationId: String(prep.invocationId),
        cardId: String(prep.cardId),
        draftRevision: Number(prep.draftRevision),
        conversationId: cid,
        values: {},
      });
    } else if (mode === "chat") onOpenConversation?.(cid);
    else
      setNotice(
        `参数还没齐，请选择「去对话运行」补充：${((prep.issues as Array<{ message: string }>) ?? []).map((i) => i.message).join("；")}`,
      );
  };
  const create = () => {
    if (actionPending.current) return;
    void confirmWorkflowLeave().then((ok) => {
      if (!ok) return;
      void perform(async () => {
        onNavigate?.();
        const id = `wf-${crypto.randomUUID().slice(0, 12)}`;
        const draft = await window.hemiVoice.workflowSaveDraft(
          id,
          BLANK_DOCUMENT,
          "未命名工作流",
        );
        onClosePreview?.();
        setDetail(null);
        setResult(null);
        setEditor({
          workflowId: id,
          name: "未命名工作流",
          document: structuredClone(BLANK_DOCUMENT),
          draftRevision: draft.draftRevision,
        });
        await refresh();
      });
    });
  };
  const edit = (row: WorkflowDefinitionSummary) =>
    void perform(async () => {
      const draft = await window.hemiVoice.workflowGetDraft(row.workflowId);
      const record =
        draft ??
        (await window.hemiVoice.workflowGetRevision(
          row.workflowId,
          row.published?.revision,
        ));
      if (!record) throw new Error("没有可编辑的流程");
      onClosePreview?.();
      setEditor({
        workflowId: row.workflowId,
        name: record.name ?? row.name,
        document: record.document as CanvasDocument,
        draftRevision: draft?.draftRevision ?? null,
        publishedRevision: row.published?.revision,
      });
    });
  const navigate = (next: WorkflowDefinitionSummary | null) => {
    void confirmWorkflowLeave().then(async (ok) => {
      if (!ok) return;
      await refresh();
      setNotice("");
      onNavigate?.();
      onClosePreview?.();
      setEditor(null);
      setResult(null);
      setDetail(next);
    });
  };
  const duplicate = (row: WorkflowDefinitionSummary) =>
    void perform(async () => {
      const source =
        (await window.hemiVoice.workflowGetDraft(row.workflowId)) ??
        (await window.hemiVoice.workflowGetRevision(
          row.workflowId,
          row.published?.revision,
        ));
      if (!source) throw new Error("流程不存在");
      await window.hemiVoice.workflowSaveDraft(
        `wf-${crypto.randomUUID().slice(0, 12)}`,
        source.document,
        `${row.name} 副本`,
      );
      await refresh();
    });
  const presentation = workflowPresentation(
    detailDocument,
    new Map(installedSkills.map((skill) => [skill.name, skill.title])),
  );
  const ExpectedIcon =
    presentation.format === "presentation"
      ? Presentation
      : presentation.format === "file"
        ? FileText
        : FolderOpen;
  const renderContent = () => {
    if (result)
      return (
        <WorkflowResult
          {...result}
          taskState={taskState}
          onTaskAction={onTaskAction}
          onBack={() => {
            onClosePreview?.();
            setResult(null);
            void refresh();
          }}
          onOpenConversation={onOpenConversation}
        />
      );
    if (editor)
      return (
        <WorkflowEditorBoundary
          key={editor.workflowId}
          onBack={() => setEditor(null)}
        >
          <Suspense fallback={<p role="status">正在打开编辑器…</p>}>
            <WorkflowCanvas
              {...editor}
              initialDocument={editor.document}
              directory={directory}
              availableSkills={installedSkills}
              selectedModel={selected}
              onSelectModel={setSelected}
              onBack={() =>
                void perform(async () => {
                  await refresh();
                  setEditor(null);
                })
              }
              onSaved={refresh}
              onRun={async (revision) =>
                run(
                  {
                    workflowId: editor.workflowId,
                    published: { revision },
                  } as WorkflowDefinitionSummary,
                  "editor-test",
                )
              }
            />
          </Suspense>
        </WorkflowEditorBoundary>
      );
    if (detail)
      return (
        <WorkflowPage
          key={`detail:${detail.workflowId}`}
          className="h59-consumer"
          testId="workflow-detail"
        >
          <div className="h59-reading">
            <button className="h59-back" onClick={() => navigate(null)}>
              <ArrowLeft />
              全部工作流
            </button>
            <header className="h59-detail-heading">
              <span className="h59-symbol">
                <WorkflowIdentityIcon definition={detail} />
              </span>
              <div>
                <p className="h59-eyebrow">
                  {detail.published
                    ? `可直接运行 · v${detail.published.revision}`
                    : "草稿"}
                </p>
                <h1>{detail.name}</h1>
                <p>{detail.description || "保存的可复用流程"}</p>
              </div>
            </header>
            <div className="h59-detail-actions">
              <div>
                <ModelSelectorChip
                  directory={directory}
                  currentProfileId={selected}
                  onSelect={setSelected}
                />
                <button
                  className="h37-btn h37-btn-primary"
                  disabled={busy || !detail.published}
                  onClick={() => void perform(() => run(detail, "direct"))}
                >
                  <Play />
                  直接运行
                </button>
                <button
                  disabled={busy || !detail.published}
                  onClick={() => void perform(() => run(detail, "chat"))}
                >
                  <MessageCircle />
                  去对话运行
                </button>
              </div>
              <div>
                <button
                  disabled={!detail.published}
                  onClick={() =>
                    onOpenDefinitionPreview?.(
                      detail.workflowId,
                      detail.published!.revision,
                    )
                  }
                >
                  <Blocks />
                  预览流程
                </button>
                <button disabled={busy} onClick={() => edit(detail)}>
                  <Settings />
                  编辑流程
                </button>
                <button
                  disabled={busy}
                  onClick={() => requestDelete(detail.workflowId)}
                >
                  <Trash2 />
                  删除工作流
                </button>
              </div>
            </div>
            <section className="h59-consumer-section">
              <header>
                <h2>默认输入</h2>
                <button
                  className="h59-text-button"
                  onClick={() => edit(detail)}
                >
                  修改默认值
                </button>
              </header>
              <dl className="h59-parameter-list">
                {detail.parameters?.map((parameter) => (
                  <div key={parameter.key}>
                    <dt>{parameter.label || parameter.key}</dt>
                    <dd>{parameterValue(parameter)}</dd>
                  </div>
                ))}
              </dl>
              {!detail.parameters?.length ? (
                <p className="h59-hint">此流程没有需要补充的输入。</p>
              ) : (
                <p className="h59-hint">
                  点击运行后，按默认输入直接开始。
                  {relativeDateHint(
                    detailDocument?.nodes.find(
                      (node) => node.type === "hemi-input",
                    )?.data.parameters ?? [],
                  )}
                  <button
                    className="h59-text-button"
                    disabled={busy}
                    onClick={() => void perform(openRunSettings)}
                  >
                    仅调整本次
                  </button>
                </p>
              )}
            </section>
            <section className="h59-consumer-section">
              <header>
                <h2>你将得到</h2>
              </header>
              <div className="h59-expected">
                <ExpectedIcon />
                <div>
                  <strong>{presentation.title}</strong>
                  {presentation.description ? (
                    <p className="h59-hint">{presentation.description}</p>
                  ) : null}
                </div>
              </div>
            </section>
            <section className="h59-consumer-section">
              <header>
                <h2>流程概览</h2>
              </header>
              <p className="h59-flow-outline">
                {detailDocument
                  ? presentation.outline.join(" → ")
                  : "读取流程…"}
              </p>
              <p className="h59-hint h59-capability-summary">
                {presentation.capabilities.join(" · ")}
              </p>
            </section>
            <section className="h59-consumer-section">
              <WorkflowHistory
                workflowId={detail.workflowId}
                onOpenConversation={onOpenConversation}
                onOpenResult={(entry) => {
                  onClosePreview?.();
                  setResult(entry);
                }}
              />
            </section>
            {notice ? (
              <p role="status" className="h59-notice">
                {notice}
              </p>
            ) : null}
          </div>
        </WorkflowPage>
      );
    return (
      <WorkflowPage
        key="library"
        className="h59-library"
        testId="workflow-studio"
      >
        <div className="h59-library-inner">
          <header className="h59-page-heading">
            <div>
              <h1>工作流</h1>
              <p>选择工作流，去对话补齐输入，或按默认值直接运行。</p>
            </div>
            <button disabled={busy} onClick={create}>
              <Plus />
              新建工作流
            </button>
          </header>
          <div className="h59-library-tools">
            <label className="h59-search">
              <Search />
              <input
                aria-label="搜索工作流"
                placeholder="搜索工作流"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <span className="h59-hint">我的工作流 · {rows.length}</span>
          </div>
          {notice ? (
            <p role="status" className="h59-notice">
              {notice}
            </p>
          ) : null}
          <div className="h59-workflow-list">
            {!rows.length ? (
              <p className="h59-empty">还没有工作流，从一个简单的流程开始。</p>
            ) : null}
            {rows
              .filter((row) =>
                row.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((row) => (
                <article
                  className="h59-row"
                  data-testid="workflow-row"
                  key={row.workflowId}
                >
                  <span className="h59-symbol">
                    <WorkflowIdentityIcon definition={row} />
                  </span>
                  <div className="h59-row-info">
                    <button
                      className="h59-workflow-name"
                      onClick={() => setDetail(row)}
                    >
                      {row.name}
                    </button>
                    <strong hidden>{row.name}</strong>
                    <p>{row.description || "保存的可复用流程"}</p>
                    <ParameterSummary parameters={row.parameters} />
                    {!row.published ? (
                      <small className="h59-model">草稿 · 尚未配置完成</small>
                    ) : null}
                  </div>
                  <div className="h59-row-actions">
                    {row.published ? (
                      <>
                        <ModelSelectorChip
                          directory={directory}
                          currentProfileId={selected}
                          onSelect={setSelected}
                        />
                        <button
                          className="h37-btn h37-btn-primary"
                          disabled={busy}
                          onClick={() => void perform(() => run(row, "direct"))}
                        >
                          <Play />
                          直接运行
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void perform(() => run(row, "chat"))}
                        >
                          <MessageCircle />
                          去对话运行
                        </button>
                      </>
                    ) : (
                      <button disabled={busy} onClick={() => edit(row)}>
                        编辑
                      </button>
                    )}
                    <button
                      className="h59-row-delete"
                      aria-label={`删除${row.name}`}
                      title="删除工作流"
                      disabled={busy}
                      onClick={() => requestDelete(row.workflowId)}
                    >
                      <Trash2 />
                      删除
                    </button>
                  </div>
                  <details className="h59-row-more">
                    <summary aria-label={`${row.name}的更多操作`}>
                      <Ellipsis />
                    </summary>
                    <div>
                      <button
                        disabled={!row.published}
                        onClick={() =>
                          onOpenDefinitionPreview?.(
                            row.workflowId,
                            row.published!.revision,
                          )
                        }
                      >
                        预览
                      </button>
                      <button disabled={busy} onClick={() => edit(row)}>
                        编辑
                      </button>
                      <button disabled={busy} onClick={() => duplicate(row)}>
                        复制
                      </button>
                    </div>
                  </details>
                </article>
              ))}
          </div>
          <div className="h59-starter">
            <MessageCircle />
            <div>
              <strong>两种方式，使用同一个工作流</strong>
              <p className="h59-hint">
                输入较多时选择“去对话运行”，Hemi
                会列出所需参数；固定流程也可以先去对话确认本次输入。
              </p>
            </div>
          </div>
        </div>
      </WorkflowPage>
    );
  };
  return (
    <>
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent className="h59-delete-dialog" showCloseButton={!busy}>
          <DialogTitle>删除工作流？</DialogTitle>
          <p>
            将删除“{rows.find((row) => row.workflowId === deleting)?.name}
            ”。已有运行记录保留。
          </p>
          {notice ? <p role="alert">{notice}</p> : null}
          <div className="h37-dialog-foot">
            <button
              className="h37-btn"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="h37-btn h59-delete-action"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (!deleting) return;
                  await window.hemiVoice.workflowRemove(deleting);
                  setDeleting(null);
                  onClosePreview?.();
                  await refresh();
                })
              }
            >
              确认删除
            </button>
          </div>
        </DialogContent>
      </Dialog>
      {runSettings ? (
        <WorkflowParametersDialog
          prepared={runSettings}
          parameters={
            detailDocument?.nodes.find((node) => node.type === "hemi-input")
              ?.data.parameters ?? []
          }
          directory={directory}
          currentModelKey={selected}
          busy={busy}
          error={notice}
          onCancel={() =>
            void perform(async () => {
              await window.hemiVoice.workflowAbandon({
                invocationId: runSettings.invocationId,
                conversationId: runSettings.conversationId,
              });
              setRunSettings(null);
            })
          }
          onRun={(values, modelKey) =>
            perform(async () => {
              const updated = await window.hemiVoice.workflowUpdatePreparation({
                invocationId: runSettings.invocationId,
                expectedDraftRevision: runSettings.draftRevision,
                values,
                executionModel:
                  modelKey === "auto"
                    ? { mode: "auto" }
                    : modelKey
                      ? { mode: "fixed", modelKey }
                      : undefined,
              });
              const preparation = updated.preparation as {
                ready: boolean;
                issues: Array<{ message: string }>;
                values: Record<string, unknown>;
              };
              const prepared = {
                ...runSettings,
                draftRevision: Number(updated.draftRevision),
                values: preparation.values,
              };
              setRunSettings(prepared);
              if (!preparation.ready)
                throw new Error(
                  preparation.issues.map((issue) => issue.message).join("；"),
                );
              await startPrepared(prepared);
            })
          }
        />
      ) : null}
      <aside className="h24-sidebar h59-sidebar" aria-label="工作流导航">
        <button
          type="button"
          className="h24-sidebar-new"
          disabled={busy}
          onClick={create}
        >
          <Plus aria-hidden="true" />
          <span>新建工作流</span>
        </button>
        <button
          className={`h59-nav-row${!detail && !editor && !result ? " active" : ""}`}
          onClick={() => navigate(null)}
        >
          <Blocks />
          <span>全部工作流</span>
        </button>
        <p className="h59-nav-label">我的工作流</p>
        <nav>
          {rows.map((row) => (
            <button
              key={row.workflowId}
              className={`h59-nav-row${detail?.workflowId === row.workflowId || editor?.workflowId === row.workflowId ? " active" : ""}`}
              onClick={() => navigate(row)}
            >
              <WorkflowIdentityIcon definition={row} />
              <span>{row.name}</span>
            </button>
          ))}
        </nav>
        <footer>
          <Monitor />
          在这台电脑上运行
        </footer>
      </aside>
      {renderContent()}
    </>
  );
}

function parameterValue(
  parameter: NonNullable<WorkflowDefinitionSummary["parameters"]>[number],
) {
  const rules: Record<string, string> = {
    today: "今天",
    yesterday: "昨天",
    "last-week": "上周（完整自然周）",
    "last-month": "上月",
  };
  return parameter.defaultRule
    ? (rules[parameter.defaultRule] ?? "相对日期")
    : parameter.defaultValue != null
      ? typeof parameter.defaultValue === "string"
        ? /^\/|^[A-Za-z]:[\\/]/.test(parameter.defaultValue)
          ? parameter.defaultValue.split(/[\\/]/).at(-1) ||
            parameter.defaultValue
          : parameter.defaultValue
        : JSON.stringify(parameter.defaultValue)
      : parameter.required
        ? "运行前需要补充"
        : "可选";
}

function ParameterSummary({
  parameters,
}: {
  parameters: WorkflowDefinitionSummary["parameters"];
}) {
  return parameters?.length ? (
    <small className="h59-model">
      {parameters
        .map((parameter) =>
          parameter.defaultRule === "last-week"
            ? "上周"
            : parameter.defaultValue != null
              ? parameterValue(parameter)
              : parameter.label || parameter.key,
        )
        .join(" · ")}
    </small>
  ) : null;
}

function WorkflowIdentityIcon({
  definition,
}: {
  definition: WorkflowDefinitionSummary;
}) {
  const executionTypes =
    definition.nodeTypes?.filter(
      (type) =>
        !["hemi-input", "hemi-condition", "hemi-deliver"].includes(type),
    ) ?? [];
  const Icon = definition.inputTypes?.some((type) =>
    ["file", "files", "directory"].includes(type),
  )
    ? Folder
    : executionTypes.length > 0 &&
        executionTypes.every((type) => type === "hemi-browser")
      ? Globe
      : Workflow;
  return <Icon aria-hidden="true" />;
}

/** Informational preview only; prepare freezes these same rules again at invocation time. */
function relativeDateHint(parameters: WorkflowInputParameter[]) {
  const dates = parameters
    .filter((p) => p.type === "date" && p.defaultRule)
    .map((p) => resolveRelativeDate(p.defaultRule!))
    .filter(Boolean);
  if (!dates.length) return null;
  return ` 本次日期为 ${dates
    .map((value) =>
      value!
        .split("～")
        .map((date) => {
          const [, m, d] = date.split("-");
          return `${Number(m)} 月 ${Number(d)} 日`;
        })
        .join(" 至 "),
    )
    .join("；")}。`;
}
