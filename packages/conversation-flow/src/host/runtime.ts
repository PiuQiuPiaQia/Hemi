import type {
  ConversationFlowHost,
  FlowAction,
  FlowActionHandler,
  FlowActionReceipt,
  FlowDiagnostic,
  FlowResult,
  FlowScope,
  HostContext,
  ResourceLease,
  ResourceRef,
} from "../types/api.js";

export const scopeKey = (scope: FlowScope) =>
  JSON.stringify([scope.environmentId, scope.conversationId, scope.generation]);
export const ok = <T>(value: T): FlowResult<T> => ({ ok: true, value });
export const failure = (
  code: "unsupported" | "cancelled" | "failed" | "unknown",
  message: string,
): FlowResult<never> => ({ ok: false, error: { code, message } });
export function createFlowRuntime(options: {
  scope: FlowScope;
  host?: ConversationFlowHost;
  onAction?: FlowActionHandler;
  onDiagnostic?: (event: FlowDiagnostic) => void;
  timeoutMs?: number;
}) {
  let disposed = false,
    sequence = 0,
    owners = 0;
  const instanceId = Math.random().toString(36).slice(2);
  const pending = new Set<AbortController>();
  const actions = new Map<string, Promise<FlowResult<FlowActionReceipt>>>();
  const uncertain = new Set<string>();
  const leases = new Map<
    string,
    {
      promise: Promise<FlowResult<ResourceLease>>;
      users: number;
      lease?: ResourceLease;
      controller: AbortController;
    }
  >();
  const diagnostic = (code: string, message: string, targetId?: string) => {
    try {
      options.onDiagnostic?.({ code, message, targetId, scope: options.scope });
    } catch {}
  };
  const releaseLease = (lease?: ResourceLease) => {
    try {
      lease?.release();
    } catch {
      diagnostic("resource-release-failed", "宿主未能释放文件资源");
    }
  };
  const requestId = () =>
    `${scopeKey(options.scope)}:${instanceId}:${++sequence}`;
  async function invoke<T>(
    operation: (context: HostContext) => Promise<FlowResult<T>>,
    timeout = options.timeoutMs ?? 30_000,
    signal?: AbortSignal,
  ): Promise<FlowResult<T>> {
    if (disposed || signal?.aborted)
      return failure("cancelled", "对话流已关闭");
    const controller = new AbortController();
    pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() =>
            operation({
              scope: options.scope,
              requestId: requestId(),
              signal: controller.signal,
            }),
          )
          .then((result) => {
            if (controller.signal.aborted)
              return failure(
                timedOut ? "unknown" : "cancelled",
                "操作已取消或结果待核对",
              );
            if (
              !result ||
              typeof result.ok !== "boolean" ||
              (!result.ok &&
                (!result.error ||
                  typeof result.error.message !== "string" ||
                  typeof result.error.code !== "string"))
            ) {
              diagnostic("invalid-host-result", "宿主未返回有效结果");
              return failure(
                "unknown",
                "宿主未返回有效结果，请核对状态后再操作",
              );
            }
            return result;
          }),
        new Promise<FlowResult<T>>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              resolve(
                failure(
                  timedOut ? "unknown" : "cancelled",
                  timedOut
                    ? "请求结果待核对，请刷新状态后再操作"
                    : "操作已取消",
                ),
              ),
            { once: true },
          );
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeout);
        }),
      ]);
    } catch {
      return failure("failed", "操作失败，可稍后重试");
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
      signal?.removeEventListener("abort", cancel);
    }
  }
  function can(capability: keyof ConversationFlowHost["capabilities"]) {
    const host = options.host;
    if (!host || host.version !== 1 || host.capabilities?.[capability] !== true)
      return false;
    const available =
      capability === "copyText"
        ? Boolean(host.copyText)
        : capability === "openLink"
          ? Boolean(host.openLink)
          : capability === "readResource"
            ? Boolean(host.resources?.read)
            : capability === "resolveResource"
              ? Boolean(host.resources?.resolve)
              : Boolean(host.resources?.listActions && host.resources?.perform);
    if (!available) diagnostic("invalid-host", `宿主未实现 ${capability}`);
    return available;
  }
  const api = {
    scope: options.scope,
    host: options.host,
    can,
    invoke,
    diagnostic,
    retain() {
      owners++;
      return () => {
        owners--;
        queueMicrotask(() => {
          if (owners === 0) api.dispose();
        });
      };
    },
    get disposed() {
      return disposed;
    },
    get actionable() {
      return Boolean(options.onAction) && !disposed;
    },
    action(action: FlowAction) {
      const key = JSON.stringify([
        action.type,
        action.targetId,
        action.expectedRevision,
      ]);
      if (uncertain.has(key))
        return Promise.resolve(
          failure("unknown", "上次操作结果待核对，请等待宿主更新状态"),
        );
      const inFlightKey = JSON.stringify(action);
      const existing = actions.get(inFlightKey);
      if (existing) return existing;
      if (!options.onAction)
        return Promise.resolve(failure("unsupported", "当前环境未提供此操作"));
      const promise = invoke((context) =>
        options.onAction!(
          { ...action, scope: context.scope, requestId: context.requestId },
          { signal: context.signal },
        ),
      )
        .then((result) => {
          if (
            result.ok &&
            (!result.value ||
              !["accepted", "completed", "needs-review"].includes(
                result.value.receipt,
              ))
          ) {
            diagnostic(
              "invalid-action-receipt",
              "宿主未返回有效操作回执",
              action.targetId,
            );
            result = failure("unknown", "操作结果待核对，请等待宿主更新状态");
          }
          if (
            (!result.ok && result.error.code === "unknown") ||
            (result.ok && result.value.receipt === "needs-review")
          )
            uncertain.add(key);
          return result;
        })
        .finally(() => actions.delete(inFlightKey));
      actions.set(inFlightKey, promise);
      return promise;
    },
    acquire(ref: ResourceRef, purpose: "thumbnail" | "preview") {
      const key = JSON.stringify([ref.id, ref.version, purpose]);
      if (!can("readResource"))
        return {
          result: Promise.resolve(
            failure("unsupported", "当前环境未提供文件读取"),
          ),
          release() {},
        };
      let entry = leases.get(key);
      if (!entry) {
        const record = {
          users: 0,
          promise: Promise.resolve(
            failure("failed", "文件读取失败"),
          ) as Promise<FlowResult<ResourceLease>>,
          lease: undefined as ResourceLease | undefined,
          controller: new AbortController(),
        };
        record.promise = invoke(
          async (context) => {
            const result = await options.host!.resources!.read!(
              { ref, purpose },
              context,
            );
            if (
              result?.ok &&
              (!result.value?.ref ||
                typeof result.value.release !== "function" ||
                !result.value.content ||
                !["text", "url"].includes(result.value.content.kind))
            ) {
              if (typeof result.value?.release === "function")
                releaseLease(result.value);
              return failure("failed", "宿主返回的文件资源无效");
            }
            if (result.ok) {
              if (
                disposed ||
                context.signal.aborted ||
                result.value.ref.id !== ref.id ||
                result.value.ref.version !== ref.version ||
                record.users === 0
              ) {
                releaseLease(result.value);
                return failure("cancelled", "文件内容已更新");
              }
              record.lease = result.value;
            }
            return result;
          },
          undefined,
          record.controller.signal,
        );
        entry = record;
        leases.set(key, record);
      }
      entry.users++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        entry!.users = Math.max(0, entry!.users - 1);
        if (entry!.users === 0) {
          entry!.controller.abort();
          releaseLease(entry!.lease);
          entry!.lease = undefined;
          if (leases.get(key) === entry) leases.delete(key);
        }
      };
      return { result: entry.promise, release };
    },
    dispose() {
      disposed = true;
      for (const controller of pending) controller.abort();
      pending.clear();
      for (const entry of leases.values()) {
        entry.users = 0;
        entry.controller.abort();
        releaseLease(entry.lease);
        entry.lease = undefined;
      }
      leases.clear();
      actions.clear();
      uncertain.clear();
    },
  };
  return api;
}
export type FlowRuntime = ReturnType<typeof createFlowRuntime>;
