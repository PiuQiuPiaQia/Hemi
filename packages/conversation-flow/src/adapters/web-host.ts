import type {
  ConversationFlowHost,
  FlowResult,
  HostContext,
} from "../types/api.js";

/** Browser defaults are optional. Supply resources from your own file store. */
export function createWebHost(
  options: {
    copyText?: ConversationFlowHost["copyText"];
    openLink?: ConversationFlowHost["openLink"];
    resources?: ConversationFlowHost["resources"];
  } = {},
): ConversationFlowHost {
  const copyText =
    options.copyText ??
    (typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? async (
          { text }: { text: string },
          context: HostContext,
        ): Promise<FlowResult<void>> => {
          if (context.signal.aborted)
            return {
              ok: false,
              error: { code: "cancelled", message: "操作已取消" },
            };
          try {
            await navigator.clipboard.writeText(text);
            return { ok: true, value: undefined };
          } catch {
            return {
              ok: false,
              error: {
                code: "denied",
                message: "浏览器未允许复制，请检查剪贴板权限",
              },
            };
          }
        }
      : undefined);
  // The application owns navigation and can choose its own allowed URL schemes.
  const openLink = options.openLink;
  return {
    version: 1,
    capabilities: {
      copyText: Boolean(copyText),
      openLink: Boolean(openLink),
      resolveResource: Boolean(options.resources?.resolve),
      readResource: Boolean(options.resources?.read),
      resourceActions: Boolean(
        options.resources?.listActions && options.resources?.perform,
      ),
    },
    copyText,
    openLink,
    resources: options.resources,
  };
}
