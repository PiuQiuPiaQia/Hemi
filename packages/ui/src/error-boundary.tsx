import {Component, type ErrorInfo, type ReactNode} from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?(error: Error, info: ErrorInfo): void;
  onReset?(): void;
  /** Changing the environment or document identity clears only this boundary's failure. */
  resetKey?: unknown;
}

/** Hosts supply diagnostics and recovery actions; errors stay inside the affected surface. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, {error: Error | null; resetKey: unknown}> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {error: null, resetKey: props.resetKey};
  }
  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: {resetKey: unknown}) {
    return Object.is(props.resetKey, state.resetKey) ? null : {error: null, resetKey: props.resetKey};
  }
  static getDerivedStateFromError(error: unknown) {
    return {error: error instanceof Error ? error : new Error(String(error))};
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {this.props.onError?.(error instanceof Error ? error : new Error(String(error)), info);}
  private reset = () => {this.setState({error: null}); this.props.onReset?.();};
  render() {
    if (!this.state.error) return this.props.children;
    return typeof this.props.fallback === 'function' ? this.props.fallback(this.state.error, this.reset) : this.props.fallback;
  }
}
