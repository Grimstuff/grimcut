import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { err: e.stack ?? e.message };
  }
  componentDidCatch(e: Error, info: ErrorInfo) {
    console.error(e, info);
  }
  render() {
    if (this.state.err) {
      const err = this.state.err;
      return (
        <div style={{ padding: 16, color: "#fff", background: "#1e1e1e", height: "100%", userSelect: "text" }}>
          <p style={{ marginTop: 0 }}>Something broke. Copy this and paste it in chat.</p>
          <pre style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{err}</pre>
          <button
            type="button"
            style={{ marginRight: 8, padding: "6px 12px" }}
            onClick={() => void navigator.clipboard.writeText(err)}
          >
            Copy error
          </button>
          <button type="button" style={{ padding: "6px 12px" }} onClick={() => this.setState({ err: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
