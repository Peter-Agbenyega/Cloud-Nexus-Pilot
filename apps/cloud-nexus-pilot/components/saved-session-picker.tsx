"use client";

import { useEffect, useState } from "react";
import type { OwnedTranscriptSessionSummary } from "@/features/transcription/saved-session-service";

export function SavedSessionPicker(props: {
  sessions: OwnedTranscriptSessionSummary[];
  loading: boolean;
  disabled: boolean;
  find: () => Promise<void>;
  recover: (sessionId?: string) => Promise<void>;
  appearance?: "light" | "dark";
}) {
  const [selectedId, setSelectedId] = useState("");
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    if (selectedId && !props.sessions.some(session => session.sessionId === selectedId)) setSelectedId("");
  }, [props.sessions, selectedId]);
  const dark = props.appearance === "dark";
  const style = { color: dark ? "#F0F0FF" : "#334155", background: dark ? "#34344F" : "#FFFFFF", border: `1px solid ${dark ? "#636386" : "#CBD5E1"}`, borderRadius: 6, padding: "7px 10px" };
  return <div style={{ marginTop: 12 }}>
    <button type="button" disabled={props.loading || recovering} onClick={() => void props.find()} style={style}>{props.loading ? "Finding saved sessions…" : "Find saved sessions"}</button>
    <p style={{ marginTop: 6, fontSize: 12 }}>Find the most recent 100 saved sessions at most for your signed-in account, including work from another browser.</p>
    {props.sessions.length ? <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
      <label style={{ fontSize: 13 }}>Saved session
        <select aria-label="Saved session to recover" value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={props.disabled || recovering} style={{ ...style, marginLeft: 8, maxWidth: "100%" }}>
          <option value="">Choose a saved session</option>
          {props.sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{new Date(session.updatedAt).toLocaleString()} — {session.status}</option>)}
        </select>
      </label>
      <button type="button" disabled={!selectedId || props.disabled || recovering} onClick={() => {
        setRecovering(true);
        void props.recover(selectedId).finally(() => setRecovering(false));
      }} style={style}>{recovering ? "Recovering…" : "Recover selected session"}</button>
    </div> : null}
  </div>;
}
