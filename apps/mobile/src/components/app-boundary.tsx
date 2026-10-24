import {Component, type ReactNode} from 'react';

export class AppBoundary extends Component<{children: ReactNode; onReturn(): void}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="connect-scroll"><h1>暂时无法打开对话</h1><p className="body-copy">请返回连接页后重试。</p><button type="button" className="primary-button" onClick={() => {this.setState({failed: false}); this.props.onReturn();}}>返回连接页</button></section>;
  }
}
