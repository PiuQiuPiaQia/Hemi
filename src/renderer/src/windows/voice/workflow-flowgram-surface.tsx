import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowEditorBoundary } from "./workflow-editor-boundary";

/**
 * FlowGram 1.0.16 loads its DI plugins inside a useMemo initializer. React 19
 * StrictMode calls that initializer twice on the same container in development,
 * producing duplicate FlowRendererRegistry bindings. Give only the imperative
 * SDK a separate React root; the Hemi forms and application keep StrictMode.
 * Pass canvas context explicitly as children so it reaches this root as well.
 */
export function WorkflowFlowgramSurface({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<Root | null>(null);
  useLayoutEffect(() => {
    const container = document.createElement("div");
    container.className = "h59-flowgram-surface";
    host.current!.append(container);
    const instance = createRoot(container);
    root.current = instance;
    return () => {
      root.current = null;
      container.remove();
      // React is committing the parent root here. Unmount the SDK after that
      // commit, including StrictMode's setup/cleanup/setup cycle.
      queueMicrotask(() => instance.unmount());
    };
  }, []);
  useLayoutEffect(() => {
    root.current?.render(
      <WorkflowEditorBoundary>{children}</WorkflowEditorBoundary>,
    );
  }, [children]);
  return <div ref={host} className="h59-flowgram-surface" />;
}
