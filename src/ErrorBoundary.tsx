import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors from anywhere in the app so a single bad node or
 * document can never blank the entire UI. Renders a dismissible fallback
 * instead of letting the React tree unmount.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Patchwork UI error:", error, info.componentStack);
  }

  private handleDismiss = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="pw-crash" role="alert">
          <h1>Something went wrong</h1>
          <p>{error.message}</p>
          <button onClick={this.handleDismiss}>Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}
