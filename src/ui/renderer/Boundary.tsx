import { Component, type ReactNode } from "react";
/** A renderer failure belongs to one surface; navigation/settings and other plugins remain usable. */
export class RendererBoundary extends Component<
  { children: ReactNode; resetKey: unknown },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error).slice(0, 2000) };
  }
  componentDidUpdate(
    previous: Readonly<{ children: ReactNode; resetKey: unknown }>,
  ) {
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: undefined });
  }
  render() {
    return this.state.error ? (
      <div role="alert" className="m-6 rounded-lg border p-5">
        <h2 className="font-medium">This plugin view could not be displayed</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Restart the plugin or open another tool. A new view from the plugin
          can recover automatically.
        </p>
        <details className="mt-3 text-sm">
          <summary>Error details</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">
            {this.state.error}
          </pre>
        </details>
      </div>
    ) : (
      this.props.children
    );
  }
}
