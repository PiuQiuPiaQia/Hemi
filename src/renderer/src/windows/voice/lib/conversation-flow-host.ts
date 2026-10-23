import type {
  ConversationFlowHost,
  FlowResult,
  ResourceRef,
} from "@hemi/conversation-flow";

type Bridge = Window["hemiVoice"];
type Target = { kind: "deliverable"; artifactId: string; path?: string };
const failed = (message: string): FlowResult<never> => ({
  ok: false,
  error: { code: "failed", message },
});
const result = (value: {
  ok: boolean;
  message?: string;
  canceled?: boolean;
}): FlowResult<void> =>
  value.ok
    ? { ok: true, value: undefined }
    : {
        ok: false,
        error: {
          code: value.canceled ? "cancelled" : "failed",
          message: value.message || "操作没有完成",
        },
      };
export const deliverableResource = (
  artifactId: string,
  path?: string,
  version = 0,
): ResourceRef => ({
  id: JSON.stringify({ kind: "deliverable", artifactId, path }),
  version: String(version),
});

/** Only this adapter knows Electron IPC and the application's resource identifiers. */
export function createDesktopFlowHost(
  bridge: Bridge,
  conversationId: string,
): ConversationFlowHost {
  const targets = new Map<string, Target>();
  function target(ref: ResourceRef): Target {
    const cached = targets.get(ref.id);
    if (cached) return cached;
    if (ref.id.startsWith("deliverable:"))
      return { kind: "deliverable", artifactId: ref.id.slice(12) };
    const value = JSON.parse(ref.id) as Target;
    if (value.kind !== "deliverable" || typeof value.artifactId !== "string")
      throw new Error("文件标识无效");
    return value;
  }
  return {
    version: 1,
    capabilities: {
      copyText: Boolean(bridge?.copyText),
      openLink: Boolean(bridge?.openLink),
      resolveResource: Boolean(bridge?.resolveConversationLink),
      readResource: Boolean(bridge?.readConversationDeliverable),
      resourceActions:
        typeof bridge?.listConversationDeliverableApplications === "function" &&
        typeof bridge?.openConversationDeliverable === "function",
    },
    copyText: async ({ text }) => result(await bridge.copyText(text)),
    openLink: async ({ url }) =>
      (await bridge.openLink(url))
        ? { ok: true, value: undefined }
        : failed("这个链接打不开"),
    resources: {
      resolve: async ({ href }, { signal }) => {
        const value = await bridge.resolveConversationLink(
          conversationId,
          href,
        );
        if (signal.aborted)
          return {
            ok: false,
            error: { code: "cancelled", message: "会话已切换" },
          };
        if (!value.ok || !value.artifactId)
          return failed(value.message || "文件解析失败");
        const ref = deliverableResource(value.artifactId);
        targets.set(ref.id, {
          kind: "deliverable",
          artifactId: value.artifactId,
          path: value.path,
        });
        return { ok: true, value: ref };
      },
      read: async ({ ref }, { signal }) => {
        let content: {
          ok: boolean;
          kind?: string;
          text?: string;
          dataUrl?: string;
          mediaUrl?: string;
          name?: string;
          size?: number | null;
          message?: string;
        };
        if (ref.id.startsWith("task-artifact:")) {
          const [taskId, ...artifactId] = ref.id.slice(14).split(":");
          content = await bridge.readArtifactPreview(
            taskId,
            artifactId.join(":"),
          );
        } else {
          const item = target(ref);
          content = await bridge.readConversationDeliverable(
            conversationId,
            item.artifactId,
            item.path,
          );
        }
        if (signal.aborted)
          return {
            ok: false,
            error: { code: "cancelled", message: "会话已切换" },
          };
        if (!content.ok) return failed(content.message || "文件读取失败");
        const url = content.dataUrl ?? content.mediaUrl;
        if (!url && content.text == null)
          return {
            ok: false,
            error: { code: "unsupported", message: "此格式请使用系统应用打开" },
          };
        return {
          ok: true,
          value: {
            ref,
            metadata: { name: content.name, size: content.size ?? undefined },
            content: url
              ? {
                  kind: "url",
                  url,
                  mimeType: content.kind === "video" ? "video/*" : "image/*",
                }
              : { kind: "text", text: content.text!, mimeType: "text/plain" },
            release() {},
          },
        };
      },
      listActions: async ({ ref }) => {
        if (ref.id.startsWith("task-body:"))
          return {
            ok: true,
            value: [{ id: "save", kind: "save", label: "保存 Markdown" }],
          };
        if (ref.id.startsWith("file-change:"))
          return {
            ok: true,
            value: [
              { id: "open", kind: "open-with", label: "打开" },
              { id: "reveal", kind: "reveal", label: "打开所在目录" },
            ],
          };
        const item = target(ref),
          apps = await bridge.listConversationDeliverableApplications(
            conversationId,
            item.artifactId,
            item.path,
          );
        if (!apps.ok) return failed(apps.message || "暂时无法读取可用程序");
        return {
          ok: true,
          value: [
            ...apps.applications.map((app) => ({
              id: `app:${app.id}`,
              kind: "open-with" as const,
              label: app.name,
              isDefault: app.isDefault,
              iconUrl: app.icon ?? undefined,
            })),
            {
              id: "reveal",
              kind: "reveal" as const,
              label: "打开所在目录",
              disabledReason:
                item.path && /^(?:ssh|sftp):/.test(item.path)
                  ? "远端文件不支持本机定位"
                  : undefined,
            },
          ],
        };
      },
      perform: async ({ ref, actionId }) => {
        if (ref.id.startsWith("task-body:") && actionId === "save")
          return result(await bridge.saveTaskBodyMarkdown(ref.id.slice(10)));
        if (ref.id.startsWith("file-change:")) {
          const [taskId, ...path] = ref.id.slice(12).split(":");
          return result(
            await bridge.openFileChange(
              taskId,
              path.join(":"),
              actionId === "reveal" ? "reveal" : "open",
            ),
          );
        }
        const item = target(ref);
        if (actionId !== "reveal" && !actionId.startsWith("app:"))
          return failed("不支持的文件操作");
        return result(
          await bridge.openConversationDeliverable(
            conversationId,
            item.artifactId,
            item.path,
            actionId === "reveal" ? "reveal" : "application",
            actionId.startsWith("app:") ? actionId.slice(4) : null,
          ),
        );
      },
    },
  };
}
