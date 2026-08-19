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
      return (
        <pre style={{ padding: 16, color: "#fff", background: "#1e1e1e", whiteSpace: "pre-wrap" }}>
          {this.state.err}
        </pre>
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
