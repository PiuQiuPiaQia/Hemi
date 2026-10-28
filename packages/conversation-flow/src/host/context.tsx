import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {Toast, UiProvider, useTransientMessage} from "@hemi/ui";
import { Check, CircleAlert } from "lucide-react";
import { createPortal } from "react-dom";
import type {
  ConversationFlowProps,
  FlowAction,
  FlowResult,
} from "../types/api.js";
import { createFlowRuntime, failure, type FlowRuntime } from "./runtime.js";

type FlowEnvironment = {
  runtime: FlowRuntime;
  active: boolean;
  portal: HTMLElement | null;
  root: React.RefObject<HTMLDivElement | null>;
};
const ClockContext = createContext(0);
export function useFlowClock() {
  return useContext(ClockContext);
}
const Context = createContext<FlowEnvironment | null>(null);
export function useFlow() {
  const context = useContext(Context);
  if (!context)
    throw new Error("Conversation flow components require FlowProvider");
  return context;
}
export function FlowProvider({
  scope,
  host,
  onAction,
  onDiagnostic,
  active = true,
  appearance,
  children,
  part = false,
}: Pick<
  ConversationFlowProps,
  "scope" | "host" | "onAction" | "onDiagnostic" | "active" | "appearance"
> & { children: ReactNode; part?: boolean }) {
  const runtime = useMemo(
    () => createFlowRuntime({ scope, host, onAction, onDiagnostic }),
    [
      scope.environmentId,
      scope.conversationId,
      scope.generation,
      host,
      onAction,
      onDiagnostic,
    ],
  );
  const root = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => runtime.retain(), [runtime]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const value = useMemo(
    () => ({
      runtime,
      active,
      portal: appearance?.portalContainer ?? portal,
      root,
    }),
    [runtime, active, portal, appearance?.portalContainer],
  );
  return (
    <ClockContext.Provider value={now}>
      <Context.Provider value={value}>
        <UiProvider portal={value.portal} keyboardRoot={root} active={active}>
        <div
          ref={root}
          data-hemi-conversation-flow
          data-hcf-keyboard={keyboard ? "true" : undefined}
          data-hcf-active={active ? undefined : "false"}
          data-hcf-part={part ? "true" : undefined}
          className={`compact-shell hcf-root ${appearance?.className ?? ""}`}
          style={{ ...appearance?.tokens, ...appearance?.style }}
          onKeyDownCapture={() => setKeyboard(true)}
          onPointerDownCapture={() => setKeyboard(false)}
        >
          {children}
          <div className="hcf-portals" ref={setPortal} />
        </div>
      </UiProvider>
      </Context.Provider>
    </ClockContext.Provider>
  );
}
export function FlowPortal({ children }: { children: ReactNode }) {
  const { portal } = useFlow();
  return portal ? createPortal(children, portal) : null;
}
export function useFlowAction() {
  const { runtime } = useFlow();
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<{message: string; id: number} | null>(null);
  const errorSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [runtime]);
  const perform = useCallback(
    async (action: FlowAction) => {
      setBusy(true);
      setFailure(null);
      const result = await runtime.action(action);
      if (mounted.current && !runtime.disposed) {
        setBusy(false);
        if (!result.ok) setFailure({message: result.error.message, id: ++errorSequence.current});
      }
      return result;
    },
    [runtime],
  );
  return { perform, busy, error: failure?.message ?? '', errorId: failure?.id ?? 0, actionable: runtime.actionable };
}
export function useClipboardCopy() {
  const { runtime } = useFlow();
  const [toast, setToast] = useTransientMessage<{ok: boolean; text: string}>();
  const copy = useCallback(
    async (text: string, label = "已复制") => {
      const result: FlowResult<void> = runtime.can("copyText")
        ? await runtime.invoke((context) =>
            runtime.host!.copyText!({ text }, context),
          )
        : failure("unsupported", "当前环境未提供复制");
      if (!runtime.disposed)
        setToast({
          ok: result.ok,
          text: result.ok ? label : result.error.message,
        });
      return result.ok;
    },
    [runtime],
  );
  return {
    copy,
    toastNode: toast ? (
      <FlowPortal>
        <Toast tone={toast.ok ? undefined : 'error'} icon={toast.ok ? <Check className="size-3.5" aria-hidden="true"/> : <CircleAlert className="size-3.5" aria-hidden="true"/>}>{toast.text}</Toast>
      </FlowPortal>
    ) : null,
  };
}
