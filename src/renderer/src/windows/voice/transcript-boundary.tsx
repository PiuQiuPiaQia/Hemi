import { Component, type ReactNode } from 'react';
import { createLogger } from '@/shared/log';

/** A renderer failure stays inside the transcript; composer/navigation remain available. */
export class TranscriptBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { createLogger('voice').error(`对话列表显示失败：${error.message}`); }
  render() {
    return this.state.failed ? <div role="alert">
      <p>对话列表显示失败，请重新打开。</p>
      <button type="button" className="h24-edit-cancel" onClick={() => this.setState({ failed: false })}>重新打开</button>
    </div> : this.props.children;
  }
}
