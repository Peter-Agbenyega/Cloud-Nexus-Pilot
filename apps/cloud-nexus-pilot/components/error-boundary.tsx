"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[workspace] render crash", {
      message: error.message,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        style={{
          background: "#13131F",
          border: "0.5px solid rgba(255,255,255,0.08)",
          borderRadius: 10,
          padding: 20,
          color: "#F0F0FF",
        }}
      >
        <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 12 }}>
          Something went wrong — your session is safe.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            background: "#4F46E5",
            border: "none",
            borderRadius: 8,
            color: "white",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 500,
            padding: "8px 14px",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
