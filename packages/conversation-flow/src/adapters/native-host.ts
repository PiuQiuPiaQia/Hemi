import type {
  ConversationFlowHost,
  FlowActionHandler,
  FlowResult,
  HostContext,
  ResourceLease,
} from "../types/api.js";
import { scopeKey } from "../host/runtime.js";

/** JSON-only wire contract; WKWebView/Android WebView implement send/subscribe. */
export interface NativeRequest {
  version: 1;
  method:
    | "copyText"
    | "openLink"
    | "resources.resolve"
    | "resources.read"
    | "resources.listActions"
    | "resources.perform"
    | "action"
    | "cancel"
    | "resources.release";
  scope: HostContext["scope"];
  requestId: string;
  payload: unknown;
}
export interface NativeResponse {
  version: 1;
  scope: HostContext["scope"];
  requestId: string;
  result: FlowResult<unknown>;
}
export interface NativeTransport {
  send(request: NativeRequest): void;
  subscribe(listener: (response: NativeResponse) => void): () => void;
}
type WireLease = Omit<ResourceLease, "release"> & { releaseToken: string };

export function createNativeHost(options: {
  transport: NativeTransport;
  capabilities: ConversationFlowHost["capabilities"];
  actions?: boolean;
  timeoutMs?: number;
}) {
  let disposed = false;
  const liveLeases = new Set<() => void>();
  const pending = new Map<
    string,
    {
      scope: string;
      finish: (result: FlowResult<unknown>) => void;
      cancel: () => void;
    }
  >();
  const send = (
    method: NativeRequest["method"],
    payload: unknown,
    context: HostContext,
  ) =>
    options.transport.send({
      version: 1,
      method,
      payload,
      scope: context.scope,
      requestId: context.requestId,
    });
  const releaseWire = (response: NativeResponse) => {
    const value = response.result.ok
      ? (response.result.value as Partial<WireLease> | null)
      : null;
    if (value && typeof value.releaseToken === "string")
      options.transport.send({
        version: 1,
        method: "resources.release",
        scope: response.scope,
        requestId: response.requestId,
        payload: { releaseToken: value.releaseToken },
      });
  };
  const unsubscribe = options.transport.subscribe((response) => {
    if (
      response.version !== 1 ||
      !response.scope ||
      typeof response.requestId !== "string"
    )
      return;
    const entry = pending.get(response.requestId);
    if (!entry || entry.scope !== scopeKey(response.scope)) {
      releaseWire(response);
      return;
    }
    if (!response.result || typeof response.result.ok !== "boolean") return;
    entry.finish(response.result);
  });
  function request<T>(
    method: NativeRequest["method"],
    payload: unknown,
    context: HostContext,
  ): Promise<FlowResult<T>> {
    if (disposed || context.signal.aborted)
      return Promise.resolve({
        ok: false,
        error: { code: "cancelled", message: "原生桥已关闭" },
      });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: FlowResult<unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal.removeEventListener("abort", cancel);
        pending.delete(context.requestId);
        resolve(value as FlowResult<T>);
      };
      const cancel = () => {
        try {
          send("cancel", { method }, context);
        } finally {
          finish({
            ok: false,
            error: { code: "cancelled", message: "操作已取消" },
          });
        }
      };
      const timer = setTimeout(() => {
        try {
          send("cancel", { method }, context);
        } finally {
          finish({
            ok: false,
            error: { code: "unknown", message: "原生操作结果待核对" },
          });
        }
      }, options.timeoutMs ?? 30_000);
      pending.set(context.requestId, {
        scope: scopeKey(context.scope),
        finish,
        cancel,
      });
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        send(method, payload, context);
      } catch {
        finish({
          ok: false,
          error: { code: "failed", message: "原生桥发送失败" },
        });
      }
    });
  }
  const host: ConversationFlowHost = {
    version: 1,
    capabilities: options.capabilities,
    copyText: (input, ctx) => request("copyText", input, ctx),
    openLink: (input, ctx) => request("openLink", input, ctx),
    resources: {
      resolve: (input, ctx) => request("resources.resolve", input, ctx),
      listActions: (input, ctx) => request("resources.listActions", input, ctx),
      perform: (input, ctx) => request("resources.perform", input, ctx),
      read: async (input, ctx) => {
        const result = await request<WireLease>("resources.read", input, ctx);
        if (!result.ok) return result;
        const lease = result.value;
        if (
          !lease?.ref ||
          !lease.content ||
          typeof lease.releaseToken !== "string"
        ) {
          releaseWire({
            version: 1,
            scope: ctx.scope,
            requestId: ctx.requestId,
            result,
          });
          return {
            ok: false,
            error: { code: "failed", message: "原生文件响应无效" },
          };
        }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          liveLeases.delete(release);
          send("resources.release", { releaseToken: lease.releaseToken }, ctx);
        };
        liveLeases.add(release);
        return {
          ok: true,
          value: { ref: lease.ref, content: lease.content, release },
        };
      },
    },
  };
  const onAction: FlowActionHandler | undefined = options.actions
    ? (action, { signal }) =>
        request("action", action, {
          scope: action.scope,
          requestId: action.requestId,
          signal,
        })
    : undefined;
  return {
    host,
    onAction,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...pending.values()]) {
        try {
          entry.cancel();
        } catch {
          entry.finish({
            ok: false,
            error: { code: "cancelled", message: "原生桥已关闭" },
          });
        }
      }
      for (const release of [...liveLeases]) {
        try {
          release();
        } catch {}
      }
      unsubscribe();
    },
  };
}
