import { Component, type ReactNode } from "react";
import { useFlow } from "../host/context.js";
class Boundary extends Component<
  { children: ReactNode; report: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.report();
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        <p>对话列表显示失败，请重新打开。</p>
        <button
          type="button"
          className="h24-edit-cancel"
          onClick={() => this.setState({ failed: false })}
        >
          重新打开
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function TranscriptBoundary({ children }: { children: ReactNode }) {
  const { runtime } = useFlow();
  return (
    <Boundary
      report={() => runtime.diagnostic("render-failed", "对话列表显示失败")}
    >
      {children}
    </Boundary>
  );
}
