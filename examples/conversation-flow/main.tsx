import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ConversationFlow,
  type ConversationFlowHandle,
  type FlowActionHandler,
  type MessageView,
  type ResourceActionView,
  type TaskView,
  type WorkflowCardView,
} from "@hemi/conversation-flow";
import { createWebHost } from "@hemi/conversation-flow/web-host";
import "@hemi/conversation-flow/styles.css";
import "./style.css";

const image =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#e4ebe3"/><circle cx="160" cy="120" r="64" fill="#74907b"/><path d="M250 145h120M250 100h80" stroke="#566e5d" stroke-width="12" stroke-linecap="round"/></svg>',
  );
const now = 1792656000000;
const task: TaskView = {
  taskId: "task-demo",
  toolCallId: "task-call",
  phase: "terminal",
  outcome: "complete",
  taskText: "核对接口数据",
  agent: "explorer",
  agentTitle: "侦察",
  startedAt: now - 4000,
  endedAt: now,
  resultText: "核对完成。",
};
const workflow: WorkflowCardView = {
  invocationId: "inv-demo",
  title: "人工输入",
  status: "waiting",
  currentNodeId: "confirm",
  completedCount: 1,
  totalCount: 3,
  interaction: {
    interactionId: "input-demo",
    nodeId: "confirm",
    title: "确认处理结果",
    status: "open",
    content: "初稿已完成。请补充意见，再选择后续处理方式。",
    contentIssues: [],
    fields: [
      {
        fieldId: "field-plan",
        key: "plan",
        label: "方案",
        type: "choice",
        required: false,
        options: ["方案 A", "方案 B"],
      },
      {
        fieldId: "field-comment",
        key: "comment",
        label: "反馈意见",
        type: "text",
        required: true,
        prefill: "",
      },
    ],
    actions: [
      {
        actionId: "continue",
        label: "继续",
        primary: true,
        requiredKeys: ["comment"],
      },
    ],
    hasTimeout: false,
    expiresAt: null,
    revision: 1,
    draft: null,
    response: null,
  },
  presentation: {
    outline: "读取数据 → 人工确认 → 生成结果",
    labels: {},
    nodeTitle: "人工确认",
    resumeFields: {},
    parameters: [],
    models: null,
    revision: 1,
  },
};
const initial: MessageView[] = [
  {
    id: "user-1",
    author: "user",
    text: "请核对数据，并生成结果文件。",
    createdAt: now,
    actions: { edit: true },
    references: [
      { kind: "file", key: "source", name: "数据.csv", subtitle: "本地文件" },
    ],
    skills: [
      { token: "@核对", name: "核对", source: "project", skillId: "verify" },
    ],
  },
  {
    id: "reply-1",
    author: "assistant",
    text: "",
    createdAt: now,
    parts: [
      {
        type: "text",
        partId: "intro",
        text: "已读取数据。下面是**核对结果**：\n\n| 指标 | 结果 |\n| --- | --- |\n| 样本 | 150 条 |\n\n```ts\nconst checked = true;\n```\n\n[文档](https://example.com/docs) · [查看本地文件](./结果.md)",
      },
      {
        type: "thinking",
        partId: "thinking",
        text: "对齐字段定义，核对缺失项。",
        startedAt: now - 3000,
        endedAt: now - 1000,
      },
      {
        type: "tools",
        partId: "tools",
        calls: [
          {
            id: "read-call",
            tool: "read",
            args: { path: "数据.csv" },
            state: "done",
          },
          {
            id: "task-call",
            tool: "task",
            args: { description: "核对接口数据" },
            state: "done",
          },
        ],
      },
      {
        type: "file-delivery",
        partId: "picture",
        artifactId: "picture",
        name: "结果预览.png",
        resource: { id: "picture", version: "1" },
      },
      {
        type: "file-delivery",
        partId: "report",
        artifactId: "report",
        name: "结果.md",
        resource: { id: "report", version: "1" },
      },
    ],
  },
  {
    id: "workflow",
    author: "assistant",
    text: "",
    parts: [{ type: "workflow-card", partId: "workflow", card: workflow }],
  },
  {
    id: "error",
    author: "assistant",
    kind: "error",
    text: "网络暂时不可用，可以重试。",
    actions: { retry: true },
  },
];
const isNative = new URLSearchParams(location.search).get("native") === "1";
function Demo({ environmentId = "offline-demo" }: { environmentId?: string }) {
  const [messages, setMessages] = useState(initial),
    [generation, setGeneration] = useState(1),
    [status, setStatus] = useState("离线演示"),
    [active, setActive] = useState(true);
  const permissionMode = new URLSearchParams(location.search).get("permission");
  const readOnly = new URLSearchParams(location.search).has("readonly");
  const [permissionOpen, setPermissionOpen] = useState(Boolean(permissionMode));
  const ref = useRef<ConversationFlowHandle>(null);
  const host = useMemo(
    () =>
      createWebHost({
        copyText: async ({ text }) => {
          setStatus(`已复制 ${text.length} 字`);
          return { ok: true, value: undefined };
        },
        openLink: async ({ url }) => {
          setStatus(`宿主收到链接：${url}`);
          return { ok: true, value: undefined };
        },
        resources: {
          resolve: async () => ({
            ok: true,
            value: { id: "report", version: "1" },
          }),
          read: async ({ ref }) => ({
            ok: true,
            value: {
              ref,
              content:
                ref.id === "picture"
                  ? { kind: "url", url: image, mimeType: "image/svg+xml" }
                  : {
                      kind: "text",
                      text: "# 核对结果\n\n全部完成。",
                      mimeType: "text/markdown",
                    },
              release() {},
            },
          }),
          listActions: async () => ({
            ok: true,
            value: [
              { id: "save", kind: "save", label: "保存文件" },
              { id: "share", kind: "share", label: "分享文件" },
            ] as ResourceActionView[],
          }),
          perform: async ({ actionId }) => {
            setStatus(`宿主收到文件操作：${actionId}`);
            return { ok: true, value: undefined };
          },
        },
      }),
    [],
  );
  const revision = useRef(1);
  const onAction = useMemo<FlowActionHandler>(
    () => async (action) => {
      setStatus(`宿主收到：${action.type}`);
      if (action.type === "permission.decide") setPermissionOpen(false);
      if (action.type === "message.edit")
        setMessages((items) =>
          items.map((item) =>
            item.id === action.targetId
              ? { ...item, text: action.nextText }
              : item,
          ),
        );
      if (action.type === "workflow.save-draft")
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              3000,
              Number(new URLSearchParams(location.search).get("delay") ?? 0),
            ),
          ),
        );
      if (action.type === "workflow.save-draft")
        return {
          ok: true,
          value: { receipt: "completed", revision: String(++revision.current) },
        };
      if (action.type === "workflow.submit-interaction") {
        if (Number(action.expectedRevision) !== revision.current)
          return {
            ok: false,
            error: { code: "conflict", message: "表单版本冲突" },
          };
        setMessages((items) =>
          items.map((item) =>
            item.id !== "workflow"
              ? item
              : {
                  ...item,
                  parts: [
                    {
                      type: "workflow-card",
                      card: {
                        ...workflow,
                        interaction: {
                          ...workflow.interaction!,
                          status: "responded",
                          revision: ++revision.current,
                          response: {
                            actionId: action.actionId,
                            actionLabel: "继续",
                            values: action.values,
                            submittedAt: now,
                            source: "user",
                          },
                        },
                      },
                    },
                  ],
                },
          ),
        );
      }
      return { ok: true, value: { receipt: "accepted" } };
    },
    [],
  );
  const [native, setNative] = useState<Awaited<
    ReturnType<
      (typeof import("@hemi/conversation-flow/native-host"))["createNativeHost"]
    >
  > | null>(null);
  // Native shells load native-entry.js before this module. No bridge or app globals are required by SDK.
  useEffect(() => {
    if (!isNative) return;
    let alive = true;
    let connection: typeof native;
    void import("./native-entry").then((value) => {
      if (alive) {
        connection = value.connectNative();
        setNative(connection);
      }
    });
    return () => {
      alive = false;
      connection?.dispose();
    };
  }, []);
  return (
    <main>
      <header>
        <strong>Hemi 对话流 SDK</strong>
        <span role="status" data-demo-status>
          {status}
        </span>
      </header>
      <nav aria-label="演示控制">
        <button onClick={() => setGeneration((value) => value + 1)}>
          切换代次
        </button>
        <button onClick={() => setActive((value) => !value)}>
          {active ? "暂停展示计时" : "恢复展示计时"}
        </button>
        <button
          onClick={() =>
            setMessages((items) => [
              ...Array.from(
                { length: 150 },
                (_, index): MessageView => ({
                  id: `history-${generation}-${index}`,
                  author: index % 2 ? "assistant" : "user",
                  text: `历史消息 ${index + 1}：核对数据与结果。`,
                }),
              ),
              ...items,
            ])
          }
        >
          前插 150 条历史
        </button>
        <button onClick={() => void ref.current?.scrollToMessage("workflow")}>
          定位表单
        </button>
      </nav>
      <section className="flow-frame">
        <ConversationFlow
          ref={ref}
          scope={{
            environmentId,
            conversationId: "sample",
            generation: String(generation),
          }}
          messages={messages}
          state={{
            tasks: [task],
            permissionRequests: permissionOpen
              ? [
                  {
                    task: {
                      phase: "waiting",
                      outcome: null,
                      taskText: "写入结果文件",
                      taskId: "permission-task",
                      permission: {
                        id: "permission",
                        kind: "action",
                        summary: "允许写入结果文件吗？",
                        tool: "write",
                        args: { path: "结果.md" },
                        remainingMs: permissionMode === "expired" ? 0 : 30000,
                      },
                    },
                  },
                ]
              : [],
          }}
          host={readOnly ? undefined : isNative ? native?.host : host}
          onAction={
            readOnly ? undefined : isNative ? native?.onAction : onAction
          }
          active={active}
        />
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(location.search).get("instances") === "2" ? (
      <div className="demo-pair">
        <Demo environmentId="local" />
        <Demo environmentId="remote" />
      </div>
    ) : (
      <Demo />
    )}
  </StrictMode>,
);
