import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

function formatCrash(message: string, extra?: string) {
  return extra ? `${message}\n\n${extra}` : message;
}

function copyText(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;inset:0;width:1px;height:1px;opacity:0;z-index:99999";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (!ok) {
    void navigator.clipboard?.writeText(text);
  }
  return ok;
}

function reportCrash(text: string) {
  console.error(text);
  void invoke<string>("log_frontend_error", { message: text }).catch(() => {});
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  { err: string | null; copied: boolean }
> {
  state = { err: null as string | null, copied: false };
  static getDerivedStateFromError(e: Error) {
    return { err: e.stack ?? e.message, copied: false };
  }
  componentDidCatch(e: Error, info: ErrorInfo) {
    reportCrash(formatCrash(e.stack ?? e.message, info.componentStack ?? ""));
  }
  render() {
    if (this.state.err) {
      const err = this.state.err;
      return (
        <div className="crash-screen">
          <p className="crash-lead">Something broke. Copy this and paste it in chat — it is also written to logs/grimcut-crash.log.</p>
          <textarea className="crash-log" readOnly value={err} onFocus={(e) => e.currentTarget.select()} />
          <div className="crash-actions">
            <button
              type="button"
              className="menu-option"
              onClick={() => {
                copyText(err);
                this.setState({ copied: true });
              }}
            >
              {this.state.copied ? "Copied" : "Copy error"}
            </button>
            <button type="button" className="menu-option" onClick={() => this.setState({ err: null, copied: false })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

window.addEventListener("error", (e) => {
  reportCrash(formatCrash(e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  reportCrash(formatCrash(r instanceof Error ? (r.stack ?? r.message) : String(r)));
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
