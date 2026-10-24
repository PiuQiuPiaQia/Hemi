import { WORKFLOW_NODE_ICONS } from "./workflow-node-icon";
import { WorkflowFlowgramSurface } from "./workflow-flowgram-surface";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Minus,
  Maximize,
  RotateCcw,
  Save,
  Ellipsis,
  Play,
  Check,
  Blocks,
} from "lucide-react";
import { Menu } from "@/components/menu";
import { workflowEditFingerprint } from "./lib/workflow-graph-view";
import {
  updateWorkflowLines,
  workflowLineClass,
  configureWorkflowHistory,
} from "./lib/workflow-canvas-layout";
import { WorkflowHistory } from "./workflow-history";
import {
  FreeLayoutEditor,
  WorkflowPortRender,
  useNodeRender,
  type FreeLayoutPluginContext,
} from "@flowgram.ai/free-layout-editor";
import {
  WorkflowSelectService,
  WorkflowNodePortsData,
  type WorkflowNodeRenderProps,
  type WorkflowPorts,
} from "@flowgram.ai/free-layout-core";
import type { WorkflowDocument, WorkflowNode } from "@shared/workflow.mjs";
import {
  WORKFLOW_NODE_TYPES,
  validateWorkflowDocument,
} from "@shared/workflow.mjs";
import type { ModelProfilesDirectory, InstalledSkill } from "@/shared/types";
import { ModelSelectorChip } from "./model-selector";
import { WorkflowNodeForm } from "./workflow-node-form";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  registerWorkflowLeaveGuard,
  confirmWorkflowLeave,
} from "./workflow-leave-guard";
import "reflect-metadata";
import "@flowgram.ai/free-layout-editor/index.css";
import "@hemi/conversation-flow/styles/059-workflows.css";

/** 人工输入节点的出口锚点：每个动作一个端口，超时模式追加独立 timeout 端口。 */
function humanInputPortAnchors(record: WorkflowNode) {
  const anchors = (record.data.actions ?? []).map((action) => ({
    portId: action.actionId,
    label: action.label || action.actionId,
  }));
  if (record.data.wait?.mode === "timeout")
    anchors.push({ portId: "timeout", label: "超时" });
  return anchors;
}

function humanInputNodePorts(record: WorkflowNode): WorkflowPorts {
  return [
    { type: "input", location: "top", locationConfig: { left: "50%", top: 0 } },
    ...humanInputPortAnchors(record).map((anchor, index, all) => ({
      portID: anchor.portId,
      type: "output" as const,
      location: "bottom" as const,
      locationConfig: { left: `${((index + 1) / (all.length + 1)) * 100}%`, bottom: 0 },
    })),
  ];
}

// SDK 加载边时会创建默认出口；加载完成后用同一 schema 同步真实实体。
function syncHumanInputPorts(ctx: FreeLayoutPluginContext, records: WorkflowNode[]) {
  for (const record of records) {
    if (record.type !== "hemi-human-input") continue;
    ctx.document.getNode(record.id)?.getData(WorkflowNodePortsData).updateAllPorts(humanInputNodePorts(record));
  }
}

function createNodeRegistries() {
  return Object.keys(WORKFLOW_NODE_TYPES).map((type) => {
    const port = (
      portID: string | undefined,
      direction: "input" | "output",
      left: string,
    ) => ({
      ...(portID ? { portID } : {}),
      type: direction,
      location: direction === "input" ? ("top" as const) : ("bottom" as const),
      locationConfig:
        direction === "input" ? { left, top: 0 } : { left, bottom: 0 },
    });
    let defaultPorts;
    if (type === "hemi-input") defaultPorts = [port(undefined, "output", "50%")];
    else if (type === "hemi-deliver")
      defaultPorts = [port(undefined, "input", "50%")];
    else if (type === "hemi-condition")
      defaultPorts = [
        port(undefined, "input", "50%"),
        port("yes", "output", "25%"),
        port("else", "output", "75%"),
      ];
    // 人工输入出口由 NodeView 随 schema 同步，不依赖 SDK 扫描 DOM 的时机。
    else if (type === "hemi-human-input")
      defaultPorts = [port(undefined, "input", "50%")];
    else
      defaultPorts = [
        port(undefined, "input", "50%"),
        port(undefined, "output", "50%"),
      ];
    return {
      type,
      meta: {
        size: {
          width: 252,
          height: [
            "hemi-input",
            "hemi-deliver",
            "hemi-condition",
          ].includes(type)
            ? 64
            : type === "hemi-skill"
              ? 96
              : 88,
        },
        defaultPorts,
      },
    };
  });
}
export type CanvasDocument = WorkflowDocument;
type Data = WorkflowNode["data"];
const CanvasContext = createContext<{
  nodes: WorkflowNode[];
  select: (id: string) => void;
  connect?: (nodeId: string, portId: string, portType: string) => void;
  pendingSource?: string;
  selected?: string | null;
  skills?: InstalledSkill[];
  contextMenu?: (id: string, position: { x: number; y: number }) => void;
  statuses?: Record<string, { status: string }>;
}>({ nodes: [], select: () => {} });
function NodeView({ node }: WorkflowNodeRenderProps) {
  const renderer = useNodeRender(node);
  const {
    nodes,
    select,
    statuses,
    selected,
    connect,
    pendingSource,
    skills,
    contextMenu,
  } = useContext(CanvasContext);
  const record = nodes.find((n) => n.id === node.id);
  const anchors = record?.type === "hemi-human-input" ? humanInputPortAnchors(record) : [];
  useLayoutEffect(() => {
    if (record?.type !== "hemi-human-input") return;
    node.getData(WorkflowNodePortsData).updateAllPorts(humanInputNodePorts(record));
  }, [node, record?.type, record?.data.actions, record?.data.wait?.mode]);
  const Icon = WORKFLOW_NODE_ICONS[record?.type ?? "hemi-agent"];
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const clickFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(clickFrame.current), []);
  return (
    <div
      className="h59-node-shell"
      onPointerDownCapture={(event) => {
        if (event.button === 0)
          pointer.current = {
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
      }}
      onPointerMoveCapture={(event) => {
        const start = pointer.current;
        if (
          start &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
        )
          start.moved = true;
      }}
      onPointerUpCapture={(event) => {
        const start = pointer.current;
        if (
          event.button !== 0 ||
          !start ||
          start.moved ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
          (event.target as Element).closest("[data-port-entity-id]")
        )
          return;
        // SDK selection starts on pointer-down. Open only after a click has
        // settled, so a drag never resizes its own canvas by opening a panel.
        clickFrame.current = requestAnimationFrame(() => select(node.id));
      }}
      onClick={(event) => {
        if (event.detail === 0 || !pointer.current?.moved) select(node.id);
      }}
      onContextMenu={
        contextMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              contextMenu(node.id, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
      onKeyDown={(e) => {
        if (contextMenu && e.key === "F10" && e.shiftKey) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          contextMenu(node.id, { x: rect.left, y: rect.top });
        }
        if (e.key === "Enter") select(node.id);
      }}
      tabIndex={0}
      data-workflow-node-id={node.id}
      data-pending-source={pendingSource === node.id || undefined}
      role="button"
      aria-label={`${statuses ? "查看步骤" : "配置"}${record?.data.title ?? node.id}`}
    >
      <div
        ref={renderer.nodeRef}
        onMouseDown={(event) => {
          if (event.button !== 0 || statuses) return;
          event.currentTarget.parentElement?.focus({ preventScroll: true });
          renderer.startDrag(event);
        }}
        onClick={renderer.selectNode}
        onFocus={renderer.onFocus}
        onBlur={renderer.onBlur}
        data-node-selected={String(renderer.selected)}
        className={`h59-node ${record?.type ?? "hemi-agent"}${selected === node.id || renderer.selected ? " selected" : ""}${renderer.activated ? " activated" : ""}${record?.type === "hemi-condition" ? " h59-condition" : ""}`}
      >
        <span className="h59-node-icon">
          <Icon aria-hidden="true" />
        </span>
        <div className="h59-node-copy">
          <strong>{record?.data.title ?? node.id}</strong>
          <p>
            {record?.data.description ||
              record?.data.goal ||
              record?.data.summary ||
              (record?.type === "hemi-human-input"
                ? `${(record.data.fields ?? []).length} 个字段 · ${(record.data.actions ?? []).length} 个操作`
                : "") ||
              record?.data.parameters
                ?.map((parameter) => parameter.label || parameter.key)
                .join("、")}
          </p>
          {statuses?.[node.id] ||
          !["hemi-input", "hemi-deliver", "hemi-condition"].includes(
            record?.type ?? "",
          ) ? (
            <small>
              <Icon aria-hidden="true" />
              {record?.type === "hemi-skill"
                ? `Skill · ${skills?.find((skill) => skill.name === record.data.skillRefs?.[0]?.name)?.title || record.data.skillRefs?.[0]?.name || "未选择"}`
                : record
                  ? WORKFLOW_NODE_TYPES[record.type]?.label
                  : ""}
              {statuses?.[node.id]
                ? ` · ${{ succeeded: "已完成", running: "执行中", waiting: "等待操作", failed: "失败", stopped: "已停止", skipped: "已跳过" }[statuses[node.id].status] ?? statuses[node.id].status}`
                : ""}
            </small>
          ) : null}
        </div>
      </div>
      {renderer.ports.map((port) => (
        <WorkflowPortRender
          key={port.id}
          entity={port}
          onClick={
            connect
              ? (event) => {
                  event.stopPropagation();
                  connect(port.node.id, String(port.portID), port.portType);
                }
              : undefined
          }
        />
      ))}
      {anchors.map((anchor, index, all) => (
        <span
          key={anchor.portId}
          data-port-id={anchor.portId}
          data-port-type="output"
          data-port-location="bottom"
          className="h59-hi-port-anchor"
          style={{
            left: `${((index + 1) / (all.length + 1)) * 100}%`,
            width: `${100 / (all.length + 1)}%`,
          }}
          title={anchor.label}
        >
          <small>{anchor.label}</small>
        </span>
      ))}
    </div>
  );
}
function useNarrowInspector() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 1179px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1179px)"),
      change = () => setNarrow(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return narrow;
}
function NodeInspector({
  children,
  onClose,
  narrow,
}: {
  children: React.ReactNode;
  onClose: () => void;
  narrow: boolean;
}) {
  if (narrow)
    return (
      <Dialog
        open
        modal={false}
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogPortal>
          <BaseDialog.Popup
            data-slot="dialog-content"
            className="h59-inspector h59-inspector-modal"
            aria-label="节点配置"
            onKeyDown={(event) => {
              if (
                event.key !== "Tab" ||
                window.document.querySelector('[role="menu"]')
              )
                return;
              const controls = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
                ),
              ].filter((element) => element.getClientRects().length);
              const index = controls.indexOf(
                window.document.activeElement as HTMLElement,
              );
              if (
                (event.shiftKey && index <= 0) ||
                (!event.shiftKey && index === controls.length - 1)
              ) {
                event.preventDefault();
                (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
              }
            }}
          >
            <DialogTitle className="sr-only">节点配置</DialogTitle>
            {children}
          </BaseDialog.Popup>
        </DialogPortal>
      </Dialog>
    );
  return (
    <aside
      className="h59-inspector"
      aria-label="节点配置"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {children}
    </aside>
  );
}
export function WorkflowCanvas({
  workflowId,
  name,
  initialDocument,
  draftRevision,
  publishedRevision,
  onBack,
  onSaved,
  directory,
  availableSkills,
  selectedModel,
  onSelectModel,
  onRun,
}: {
  workflowId: string;
  name: string;
  initialDocument: CanvasDocument;
  draftRevision: number | null;
  publishedRevision?: number;
  onBack: () => void;
  onSaved: () => Promise<void>;
  directory?: ModelProfilesDirectory | null;
  availableSkills?: InstalledSkill[];
  selectedModel?: string | null;
  onSelectModel?: (key: string) => void;
  onRun?: (revision: number) => Promise<void>;
}) {
  const [document, setDocument] = useState<CanvasDocument>(() =>
    structuredClone(initialDocument),
  );
  const documentRef = useRef(document);
  const syncingGraph = useRef(false);
  const editor = useRef<FreeLayoutPluginContext | null>(null);
  const revision = useRef(draftRevision);
  const [title, setTitle] = useState(name);
  const titleRef = useRef(name);
  const savedFingerprint = useRef(
    workflowEditFingerprint(initialDocument, name),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const narrowInspector = useNarrowInspector();
  const closeInspector = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() =>
      window.document
        .querySelector<HTMLElement>(
          `[data-workflow-node-id="${CSS.escape(id ?? "")}"]`,
        )
        ?.focus({ preventScroll: true }),
    );
  };
  const [notice, setNotice] = useState("");
  const [saveMessage, setSaveMessage] = useState(
    publishedRevision ? `已保存 · v${publishedRevision}` : "草稿已保存",
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [advancedNode, setAdvancedNode] = useState<string | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [history, setHistory] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [canUndo, setCanUndo] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<{
    nodeId: string;
    portId: string;
  } | null>(null);
  const historySubscription = useRef<{ dispose: () => void } | null>(null);
  useEffect(() => {
    if (!pendingConnection) return;
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !window.document.querySelector('[role="menu"]')
      ) {
        event.preventDefault();
        setPendingConnection(null);
        setNotice("");
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [pendingConnection]);
  const zoomSubscription = useRef<{ dispose: () => void } | null>(null);
  const initialViewportFrame = useRef(0);
  const lineLayoutFrame = useRef(0);
  useEffect(
    () => () => {
      cancelAnimationFrame(initialViewportFrame.current);
      cancelAnimationFrame(lineLayoutFrame.current);
      zoomSubscription.current?.dispose();
      historySubscription.current?.dispose();
    },
    [],
  );
  const titleSlot = window.document.getElementById("h59-editor-title-slot");
  const actionsSlot = window.document.getElementById("h59-editor-actions-slot");
  const [leaving, setLeaving] = useState(false);
  const leaveResolve = useRef<((ok: boolean) => void) | null>(null);
  useEffect(
    () =>
      registerWorkflowLeaveGuard(() =>
        !dirty
          ? Promise.resolve(true)
          : new Promise((resolve) => {
              leaveResolve.current?.(false);
              leaveResolve.current = resolve;
              setLeaving(true);
            }),
      ),
    [dirty],
  );
  useEffect(() => () => leaveResolve.current?.(false), []);
  const decideLeave = (ok: boolean) => {
    setLeaving(false);
    leaveResolve.current?.(ok);
    leaveResolve.current = null;
  };
  const [loadedSkills, setSkills] = useState<InstalledSkill[]>([]);
  const skills = availableSkills ?? loadedSkills;
  const [apps, setApps] = useState<
    Array<{ name: string; applicationRef: string }>
  >([]);
  useEffect(() => {
    void window.hemiVoice
      .workflowApplications()
      .then(setApps)
      .catch((error) => setNotice(`读取应用列表失败：${error}`));
  }, []);
  useEffect(() => {
    if (availableSkills) return;
    let alive = true;
    void window.hemiVoice
      .getSkillState()
      .then((s) => {
        if (alive) setSkills(s.installed.filter((x) => x.enabled));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [availableSkills]);
  const registries = useMemo(createNodeRegistries, []);
  const snapshot = (): CanvasDocument => {
    const raw = editor.current?.document.toJSON();
    if (!raw) return documentRef.current;
    return {
      nodes: raw.nodes.map((node) => ({
        ...node,
        data:
          documentRef.current.nodes.find((n) => n.id === node.id)?.data ?? {},
      })) as WorkflowNode[],
      edges: raw.edges.map((edge) => ({
        sourceNodeID: edge.sourceNodeID,
        targetNodeID: edge.targetNodeID,
        ...(edge.sourcePortID != null
          ? { sourcePortID: String(edge.sourcePortID) }
          : {}),
      })),
    };
  };
  const remember = (next: CanvasDocument) => {
    documentRef.current = next;
    setDocument(next);
    setDirty(
      workflowEditFingerprint(next, titleRef.current) !==
        savedFingerprint.current,
    );
  };
  const edgeIssues = (next: CanvasDocument) =>
    validateWorkflowDocument(next).errors.filter((e) =>
      [
        "invalid-edge",
        "self-edge",
        "duplicate-edge",
        "invalid-port",
        "input-in-edge",
        "deliver-out-edge",
        "cycle",
      ].includes(e.code),
    );
  const replace = (next: CanvasDocument) => {
    const issues = edgeIssues(next);
    if (issues.length) {
      setNotice(issues.map((i) => i.message).join("；"));
      return;
    }
    remember(next);
    syncingGraph.current = true;
    try {
      editor.current?.operation.fromJSON(next);
    } finally {
      syncingGraph.current = false;
    }
  };
  const connectPort = (nodeId: string, portId: string, portType: string) => {
    if (portType === "output") {
      setPendingConnection({ nodeId, portId });
      setSelected(null);
      setNotice("已选择输出端口，请选择目标节点的输入端口；Esc 取消。");
      return;
    }
    if (!pendingConnection) {
      setNotice("请先选择一个输出端口。");
      return;
    }
    const graph = snapshot();
    const source = graph.nodes.find(
      (node) => node.id === pendingConnection.nodeId,
    );
    const edge = {
      sourceNodeID: pendingConnection.nodeId,
      targetNodeID: nodeId,
      ...(source &&
      ["hemi-condition", "hemi-human-input"].includes(source.type)
        ? { sourcePortID: pendingConnection.portId }
        : {}),
    };
    const issues = edgeIssues({ ...graph, edges: [...graph.edges, edge] });
    if (issues.length) {
      setNotice(issues.map((issue) => issue.message).join("；"));
      return;
    }
    replace({ ...graph, edges: [...graph.edges, edge] });
    setPendingConnection(null);
    setNotice("");
  };
  const chosen = document.nodes.find((n) => n.id === selected);
  const patch = (data: Partial<Data>) => {
    if (!chosen) return;
    const graph = snapshot();
    remember({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === chosen.id ? { ...n, data: { ...n.data, ...data } } : n,
      ),
    });
  };
  const save = async (publish: boolean, run = false) => {
    setSaving(true);
    setNotice("");
    try {
      const graph = snapshot();
      if (publish) {
        const verdict = validateWorkflowDocument(graph);
        if (!verdict.valid)
          throw new Error(verdict.errors.map((e) => e.message).join("；"));
      }
      const saved = await window.hemiVoice.workflowSaveDraft(
        workflowId,
        graph,
        title,
        revision.current,
      );
      revision.current = saved.draftRevision;
      let published: number | undefined;
      if (publish)
        published = (
          await window.hemiVoice.workflowPublish(
            workflowId,
            saved.draftRevision,
          )
        ).revision;
      savedFingerprint.current = workflowEditFingerprint(graph, title);
      setDirty(false);
      const message = publish ? `已保存 · v${published}` : "草稿已保存";
      setSaveMessage(message);
      await onSaved();
      if (run && published) await onRun?.(published);
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const saveCurrent = async () => {
    const verdict = validateWorkflowDocument(snapshot());
    const saved = await save(verdict.valid);
    if (saved && !verdict.valid)
      setNotice(
        `草稿已保存，补齐后即可运行：${verdict.errors.map((issue) => issue.message).join("；")}`,
      );
  };
  const add = (type: WorkflowNode["type"]) => {
    const graph = snapshot(),
      id = `n-${crypto.randomUUID().slice(0, 8)}`;
    const data: Data = { title: WORKFLOW_NODE_TYPES[type].label };
    if (
      ["hemi-agent", "hemi-skill", "hemi-browser", "hemi-desktop"].includes(
        type,
      )
    ) {
      data.goal = "";
      data.outputSchema = {
        type: "object",
        properties: { result: { type: "string" } },
      };
    }
    if (type === "hemi-condition")
      data.condition = {
        fieldRef: { kind: "parameter", key: "" },
        operator: "eq",
        value: "",
      };
    if (type === "hemi-human-input") {
      data.content = "请确认以下内容：";
      data.fields = [];
      data.actions = [{ actionId: "confirm", label: "确认", primary: true }];
      data.wait = { mode: "forever" };
    }
    const position = (() => {
      for (let row = 0; row < graph.nodes.length + 2; row++)
        for (let column = 0; column < 2; column++) {
          const candidate = { x: 80 + column * 316, y: 20 + row * 128 };
          if (
            graph.nodes.every(
              (node) =>
                candidate.x + 276 <= node.meta.position.x ||
                candidate.x >= node.meta.position.x + 276 ||
                candidate.y + 112 <= node.meta.position.y ||
                candidate.y >= node.meta.position.y + 112,
            )
          )
            return candidate;
        }
      return {
        x: 80,
        y: Math.max(...graph.nodes.map((node) => node.meta.position.y)) + 128,
      };
    })();
    replace({
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id,
          type,
          meta: { position },
          data,
        },
      ],
    });
    setSelected(id);
    requestAnimationFrame(() => {
      const ctx = editor.current;
      const node = ctx?.document.getNode(id);
      if (ctx && node)
        void ctx
          .get(WorkflowSelectService)
          .selectNodeAndScrollToView(node, false);
    });
  };
  const titleControl = (
    <div className="h59-editor-title">
      {" "}
      <input
        aria-label="工作流名称"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          titleRef.current = e.target.value;
          setDirty(
            workflowEditFingerprint(snapshot(), e.target.value) !==
              savedFingerprint.current,
          );
        }}
      />
      <small className={dirty ? "h59-dirty" : "h59-saved"}>
        {dirty ? "未保存" : saveMessage}
      </small>
    </div>
  );
  const actionControls = (
    <div className="h59-editor-actions">
      {" "}
      <button
        className="h59-save"
        disabled={saving}
        aria-label="保存工作流"
        title={dirty ? "保存工作流" : saveMessage}
        onClick={() => void saveCurrent()}
      >
        {dirty ? <Save /> : <Check />}
        <span className="h59-save-label">保存</span>
      </button>
      <button
        className="h59-editor-more"
        ref={moreRef}
        aria-label="更多工作流操作"
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        onClick={() => setActionsOpen((value) => !value)}
      >
        <Ellipsis />
      </button>
      {actionsOpen ? (
        <Menu open onClose={() => setActionsOpen(false)} anchorRef={moreRef}>
          {selected ? (
            <button
              role="menuitem"
              className="h37-menu-item"
              onClick={() => {
                setActionsOpen(false);
                setAdvancedNode(advancedNode === selected ? null : selected);
              }}
            >
              {advancedNode === selected ? "收起节点高级配置" : "节点高级配置"}
            </button>
          ) : null}
          <button
            role="menuitem"
            className="h37-menu-item"
            disabled={saving}
            onClick={() => {
              setActionsOpen(false);
              void save(false);
            }}
          >
            仅保存草稿
          </button>
        </Menu>
      ) : null}
      {onSelectModel ? (
        <ModelSelectorChip
          directory={directory ?? null}
          currentProfileId={selectedModel ?? null}
          onSelect={onSelectModel}
        />
      ) : null}
      <button
        className="h37-btn h37-btn-primary"
        disabled={saving}
        onClick={() => void save(true, true)}
      >
        <Play aria-hidden="true" />
        试运行
      </button>
    </div>
  );
  const toolbar = (
    <div className="h59-workspace-toolbar">
      <button
        className={!history ? "active" : ""}
        onClick={() => setHistory(false)}
      >
        流程
      </button>
      <button
        className={history ? "active" : ""}
        onClick={() => setHistory(true)}
      >
        运行记录
      </button>
      <span>
        <Blocks aria-hidden="true" />
        {document.nodes.length} 个节点
      </span>
      <button
        className="h59-undo"
        aria-label="撤销"
        disabled={!canUndo}
        onClick={() => {
          setSelected(null);
          void editor.current?.history.undo();
        }}
      >
        <RotateCcw aria-hidden="true" />
      </button>
      <button
        ref={addRef}
        onClick={() => setAdding((value) => !value)}
        aria-expanded={adding}
      >
        <Plus />
        添加节点
      </button>
    </div>
  );
  return (
    <section className="h59-canvas" data-testid="workflow-canvas">
      {nodeMenu ? (
        <Menu
          open
          placement="fixed"
          position={nodeMenu}
          onClose={() => setNodeMenu(null)}
        >
          <button
            role="menuitem"
            className="h37-menu-item"
            onClick={() => {
              setSelected(nodeMenu.id);
              setAdvancedNode(nodeMenu.id);
              setNodeMenu(null);
            }}
          >
            节点高级配置
          </button>
        </Menu>
      ) : null}
      {titleSlot ? createPortal(titleControl, titleSlot) : null}
      {actionsSlot ? createPortal(actionControls, actionsSlot) : null}
      {!titleSlot || !actionsSlot ? (
        <header>
          {titleControl}
          {actionControls}
        </header>
      ) : null}
      {leaving ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) decideLeave(false);
          }}
        >
          <DialogContent
            className="h59-leave-dialog"
            showCloseButton={false}
            aria-label="未保存的流程"
          >
            <DialogTitle>流程尚未保存</DialogTitle>
            <button
              disabled={saving}
              onClick={() =>
                void save(false).then((ok) => {
                  if (ok) decideLeave(true);
                })
              }
            >
              保存并返回
            </button>
            <button onClick={() => decideLeave(true)}>放弃修改</button>
            <button onClick={() => decideLeave(false)}>继续编辑</button>
          </DialogContent>
        </Dialog>
      ) : null}
      {history ? (
        <div className="h59-editor-history">
          {toolbar}
          <WorkflowHistory workflowId={workflowId} />
        </div>
      ) : (
        <div className="h59-canvas-body">
          <section
            className="h59-workspace"
            aria-label="工作流画布"
            inert={!!chosen && narrowInspector}
          >
            {toolbar}
            {notice ? (
              <p role="status" className="h59-notice">
                {notice}
              </p>
            ) : null}
            {adding ? (
              <Menu
                open
                onClose={() => setAdding(false)}
                anchorRef={addRef}
                placement="anchor-down"
                className="h59-add-menu"
                maxHeight="calc(100dvh - var(--hemi-topbar-h) - var(--sp-48) - var(--sp-24))"
              >
                {[
                  {
                    label: "执行节点",
                    types: [
                      "hemi-agent",
                      "hemi-skill",
                      "hemi-browser",
                      "hemi-desktop",
                    ] as const,
                  },
                  {
                    label: "流程控制",
                    types: [
                      "hemi-input",
                      "hemi-condition",
                      "hemi-human-input",
                      "hemi-deliver",
                    ] as const,
                  },
                ].map((group) => (
                  <section key={group.label}>
                    <h3>{group.label}</h3>
                    {group.types.map((type) => {
                      const meta = WORKFLOW_NODE_TYPES[type],
                        Icon = WORKFLOW_NODE_ICONS[type];
                      const descriptions = {
                        "hemi-agent": "描述目标，由 Hemi 完成任务",
                        "hemi-skill": "调用已安装的 Skill",
                        "hemi-browser": "打开网页、读取与操作页面",
                        "hemi-desktop": "在指定桌面应用中操作",
                        "hemi-input": "收集本次需要的参数",
                        "hemi-condition": "根据结果选择后续路径",
                        "hemi-human-input": "停下来等人填写和选择",
                        "hemi-deliver": "汇总文件和最终结果",
                      };
                      const exists =
                        ["hemi-input", "hemi-deliver"].includes(type) &&
                        document.nodes.some((node) => node.type === type);
                      return (
                        <button
                          key={type}
                          role="menuitem"
                          aria-label={`添加${meta.label}`}
                          disabled={exists}
                          title={
                            exists ? `流程已有${meta.label}节点` : undefined
                          }
                          onClick={() => {
                            add(type);
                            setAdding(false);
                            setHistory(false);
                          }}
                        >
                          <Icon aria-hidden="true" />
                          <span>
                            <strong>{meta.label}</strong>
                            <small>{descriptions[type]}</small>
                          </span>
                        </button>
                      );
                    })}
                  </section>
                ))}
              </Menu>
            ) : null}
            <div className="h59-stage">
              <WorkflowFlowgramSurface>
                <CanvasContext.Provider
                  value={{
                    nodes: document.nodes,
                    select: setSelected,
                    selected,
                    connect: connectPort,
                    pendingSource: pendingConnection?.nodeId,
                    skills,
                    contextMenu: (id, position) =>
                      setNodeMenu({ id, ...position }),
                  }}
                >
                  <FreeLayoutEditor
                    ref={editor}
                    initialData={initialDocument}
                    history={{ enable: true }}
                    scroll={{ disableScrollBar: true }}
                    nodeRegistries={registries}
                    isHideArrowLine={() => true}
                    setLineClassName={(_ctx, line) => workflowLineClass(line)}
                    canAddLine={(_ctx, from, to, _lines, silent) => {
                      if (syncingGraph.current) return true;
                      const graph = snapshot();
                      const source = graph.nodes.find(
                        (n) => n.id === from.node.id,
                      );
                      const edge = {
                        sourceNodeID: from.node.id,
                        targetNodeID: to.node.id,
                        ...(source &&
                        ["hemi-condition", "hemi-human-input"].includes(
                          source.type,
                        )
                          ? { sourcePortID: String(from.portID) }
                          : {}),
                      };
                      const issues = edgeIssues({
                        ...graph,
                        edges: [...graph.edges, edge],
                      });
                      if (issues.length && !silent)
                        setNotice(issues.map((i) => i.message).join("；"));
                      return !issues.length;
                    }}
                    materials={{ renderDefaultNode: NodeView }}
                    onContentChange={(ctx) => {
                      cancelAnimationFrame(lineLayoutFrame.current);
                      lineLayoutFrame.current = requestAnimationFrame(() => {
                        syncHumanInputPorts(ctx, documentRef.current.nodes);
                        updateWorkflowLines(ctx);
                      });
                      if (
                        !syncingGraph.current &&
                        ctx.document.getAllNodes().length
                      )
                        remember(snapshot());
                    }}
                    onReady={(ctx) => {
                      configureWorkflowHistory(ctx);
                      zoomSubscription.current?.dispose();
                      historySubscription.current?.dispose();
                      historySubscription.current =
                        ctx.history.undoRedoService.onChange(() =>
                          setCanUndo(ctx.history.canUndo()),
                        );
                      setCanUndo(ctx.history.canUndo());
                      zoomSubscription.current =
                        ctx.playground.config.onConfigChanged((config) =>
                          setZoom(Math.round(config.zoom * 100)),
                        );
                      // Start at readable 100% on the primary path. Fit is explicit.
                      const entry =
                        initialDocument.nodes.find(
                          (node) => node.type === "hemi-input",
                        ) ?? initialDocument.nodes[0];
                      // Ready subscriptions do not wait for optional node forms.
                      // Center after synchronizing the first rendered viewport.
                      initialViewportFrame.current = requestAnimationFrame(
                        () => {
                          ctx.playground.resize();
                          if (entry)
                            ctx.playground.config.updateConfig({
                              zoom: 1,
                              scrollX:
                                entry.meta.position.x -
                                ctx.playground.config.config.width / 2,
                              scrollY: 0,
                            });
                          syncHumanInputPorts(ctx, documentRef.current.nodes);
                          updateWorkflowLines(ctx);
                          requestAnimationFrame(() => {
                            syncHumanInputPorts(ctx, documentRef.current.nodes);
                            updateWorkflowLines(ctx);
                          });
                        },
                      );
                    }}
                  />
                </CanvasContext.Provider>
              </WorkflowFlowgramSurface>
              <div className="h59-canvas-controls">
                <button
                  aria-label="缩小画布"
                  onClick={() => {
                    const next = Math.max(25, zoom - 10);
                    setZoom(next);
                    editor.current?.playground.config.updateConfig({
                      zoom: next / 100,
                    });
                  }}
                >
                  <Minus />
                </button>
                <span>{zoom}%</span>
                <button
                  aria-label="放大画布"
                  onClick={() => {
                    const next = Math.min(200, zoom + 10);
                    setZoom(next);
                    editor.current?.playground.config.updateConfig({
                      zoom: next / 100,
                    });
                  }}
                >
                  <Plus />
                </button>
                <button
                  aria-label="适应画布"
                  onClick={() => void editor.current?.tools.fitView()}
                >
                  <Maximize />
                </button>
              </div>
              <p className="h59-canvas-guide">
                拖动节点调整位置 · 点击端口连接
              </p>
            </div>
          </section>
          {chosen ? (
            <NodeInspector narrow={narrowInspector} onClose={closeInspector}>
              <WorkflowNodeForm
                chosen={chosen}
                advanced={advancedNode === chosen.id}
                document={document}
                skills={skills}
                apps={apps}
                patch={patch}
                replace={replace}
                snapshot={snapshot}
                onClose={closeInspector}
              />
            </NodeInspector>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** 只读运行快照：不挂保存、命令和执行入口，状态直接投影同一 invocation。 */
export function WorkflowRunGraph({
  document,
  nodes,
  onSelect,
}: {
  document: WorkflowDocument;
  nodes: Record<string, { status: string }>;
  onSelect: (id: string) => void;
}) {
  const registries = useMemo(createNodeRegistries, []);
  const layoutFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(layoutFrame.current), []);
  return (
    <div className="h59-run-graph">
      <WorkflowFlowgramSurface>
        <CanvasContext.Provider
          value={{ nodes: document.nodes, select: onSelect, statuses: nodes }}
        >
          <FreeLayoutEditor
            initialData={document}
            readonly
            scroll={{ disableScrollBar: true }}
            isHideArrowLine={() => true}
            setLineClassName={(_ctx, line) => workflowLineClass(line)}
            nodeRegistries={registries}
            materials={{ renderDefaultNode: NodeView }}
            onReady={(ctx) => {
              layoutFrame.current = requestAnimationFrame(() => {
                ctx.playground.resize();
                syncHumanInputPorts(ctx, document.nodes);
                updateWorkflowLines(ctx);
                void ctx.tools.fitView(false);
              });
            }}
          />
        </CanvasContext.Provider>
      </WorkflowFlowgramSurface>
    </div>
  );
}
