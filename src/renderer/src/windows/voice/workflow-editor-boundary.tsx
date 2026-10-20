import { Component, type ReactNode } from "react";
import { createLogger } from "@/shared/log";

const log = createLogger("workflow-canvas");

/** A canvas/library failure must leave navigation and the saved definition usable. */
export class WorkflowEditorBoundary extends Component<
  { children: ReactNode; onBack?: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    log.error(error.stack ?? error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h59-canvas-error" role="alert">
        <h2>流程画布未能打开</h2>
        <p>已保存的工作流仍然保留。可以重试，或返回列表。</p>
        <p className="h59-hint">{this.state.error.message}</p>
        <button onClick={() => this.setState({ error: null })}>重试</button>
        {this.props.onBack ? (
          <button onClick={this.props.onBack}>返回工作流</button>
        ) : null}
      </div>
    );
  }
}
