"use client";

import Link from "next/link";
import { useRef } from "react";

import type { LiveTranscriptionSource } from "@/features/transcription/audio-capture";
import type { UseTranscriptionWorkflowResult } from "@/features/transcription/use-transcription-workflow";

const STATUS_LABELS = {
  idle: "Idle",
  connecting: "Connecting",
  listening: "Listening",
  "receiving-transcript": "Receiving Transcript",
  "no-speech-yet": "No Speech Yet",
  stopped: "Stopped",
  unsupported: "Unsupported",
  failed: "Failed",
} as const;

type TranscriptionRuntimeSurfaceProps = {
  workflow: UseTranscriptionWorkflowResult;
  variant: "standalone" | "workspace";
};

export function TranscriptionRuntimeSurface({
  workflow,
  variant,
}: TranscriptionRuntimeSurfaceProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    status,
    transcript,
    latestSegment,
    segments,
    selectedFileName,
    error,
    feedback,
    source,
    isSupported,
    systemAudioSupported,
    isRecording,
    isTranscribing,
    canUseTranscript,
    transcriptSummary,
    questionBoundaryDetected,
    transcriptRecords,
    activeTranscriptId,
    persistenceInfo,
    importStatus,
    isImporting,
    setSource,
    startCapture,
    stopCapture,
    clearTranscript,
    uploadFile,
    selectTranscript,
    deleteTranscript,
    importLocalTranscripts,
  } = workflow;

  const isWorkspaceVariant = variant === "workspace";

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    await uploadFile(file);
    event.target.value = "";
  }

  function handleSourceChange(nextSource: LiveTranscriptionSource) {
    setSource(nextSource);
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
      <section className="panel p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="pill">
              {isWorkspaceVariant ? "Workspace Transcript Runtime" : "Transcription Workspace"}
            </span>
            <h2 className="mt-4 text-3xl font-semibold text-slate-950">
              {isWorkspaceVariant
                ? "Run the same browser-local transcript workflow inside the workspace shell."
                : "Capture live audio or stage uploads with real Deepgram transcription."}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
              {isWorkspaceVariant
                ? "This workspace transcript lane can attach directly to the active browser-local stream. Transcript output comes from Deepgram and remains visible in this local runtime surface."
                : "This workflow sends captured audio chunks to a secure server route, which calls Deepgram for transcription. No Deepgram secrets are exposed in the browser."}
            </p>
            <p className="mt-3 text-sm leading-7 text-slate-500">{persistenceInfo.note}</p>
            {!isWorkspaceVariant ? (
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                {persistenceInfo.authState === "signed-in-cloud" ? (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 font-medium text-emerald-700">
                    Cloud transcript history active for{" "}
                    {persistenceInfo.userEmail ?? "authenticated user"}
                  </span>
                ) : (
                  <>
                    <Link
                      href="/auth/login?next=%2Ftranscripts"
                      className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800"
                    >
                      Sign In for Cloud History
                    </Link>
                    <Link
                      href="/auth/signup?next=%2Ftranscripts"
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                    >
                      Create Account
                    </Link>
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
            Status:{" "}
            <span
              className={error ? "font-semibold text-rose-700" : "font-semibold text-slate-900"}
            >
              {STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        {feedback ? (
          <p className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {feedback}
          </p>
        ) : null}
        {error ? (
          <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <div className="mt-8 grid gap-5 md:grid-cols-[220px_1fr]">
          <label className="text-sm font-medium text-slate-700">
            Audio Source
            <select
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
              value={source}
              onChange={(event) => handleSourceChange(event.target.value as LiveTranscriptionSource)}
              disabled={isRecording}
            >
              <option value="microphone">Microphone</option>
              <option value="system-audio" disabled={!systemAudioSupported}>
                Tab / System Audio
              </option>
            </select>
          </label>

          <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
            {isSupported
              ? "MediaRecorder is available. Live capture can stream chunks to Deepgram through the server route."
              : "This browser does not support MediaRecorder. Upload mode still works for transcript flow validation."}
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Live Audio Stream
            </p>
            <p className="mt-2 font-semibold text-slate-900">
              {isRecording ? "Active" : "Not Active"}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Transcription Engine
            </p>
            <p className="mt-2 font-semibold text-slate-900">
              {status === "failed"
                ? "Failed"
                : status === "idle" || status === "stopped"
                  ? "Not Active"
                  : "Active"}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Transcript Intake
            </p>
            <p className="mt-2 font-semibold text-slate-900">
              {status === "no-speech-yet"
                ? "Listening, no words yet"
                : transcript
                  ? "Receiving transcript"
                  : "Waiting for transcript"}
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
          Persistence mode:{" "}
          <span className="font-semibold text-slate-900">{persistenceInfo.mode}</span>
          <p className="mt-2 leading-7">{persistenceInfo.note}</p>
        </div>

        {!isWorkspaceVariant && persistenceInfo.mode === "supabase-active" ? (
          <div className="mt-5 rounded-3xl border border-sky-200 bg-sky-50 p-5 text-sm text-sky-900">
            <p className="font-semibold">Local-to-cloud import</p>
            <p className="mt-2 leading-7">{importStatus.note}</p>
            {importStatus.available ? (
              <button
                type="button"
                onClick={() => void importLocalTranscripts()}
                disabled={isImporting}
                className="mt-4 rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isImporting
                  ? "Importing..."
                  : `Import ${importStatus.importableCount} Local Transcript${
                      importStatus.importableCount === 1 ? "" : "s"
                    }`}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void startCapture()}
            disabled={!isSupported || isRecording}
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Start Live Capture
          </button>
          <button
            type="button"
            onClick={stopCapture}
            disabled={!isRecording}
            className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Upload File
          </button>
          <button
            type="button"
            onClick={clearTranscript}
            disabled={!canUseTranscript && !selectedFileName}
            className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorkspaceVariant ? "Clear Local Transcript Lane" : "Clear Workspace"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".txt,.md,.json,.srt,.vtt,audio/*"
            onChange={(event) => void handleFileChange(event)}
          />
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Latest Segment
            </p>
            <p className="mt-3 text-sm leading-7 text-slate-700">
              {latestSegment || "No segment captured yet."}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Transcript Summary
            </p>
            <p className="mt-3 text-sm leading-7 text-slate-700">{transcriptSummary}</p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Workspace Signal
            </p>
            <p className="mt-3 text-sm leading-7 text-slate-700">
              {questionBoundaryDetected
                ? "Question boundary detected. This transcript is a good candidate for future summary or answer generation."
                : "Keep capturing or upload a longer file to build a stronger transcript for downstream local operator flows."}
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div className="panel p-8">
          <h2 className="text-2xl font-semibold text-slate-950">Transcript Preview</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            Review the local-first transcript output here. This surface stays browser-local in both
            the standalone transcript route and the workspace shell.
          </p>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Active Intake
            </p>
            <p className="mt-3 text-sm text-slate-700">
              {selectedFileName
                ? `Uploaded file: ${selectedFileName}`
                : isRecording
                  ? "Live audio stream is active."
                  : isTranscribing
                    ? "Deepgram is processing incoming audio."
                    : status === "failed"
                      ? "Transcription failed to start or continue."
                      : "No active stream or upload yet."}
            </p>
          </div>

          <div className="mt-6 min-h-72 rounded-3xl border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-700">
            {transcript ? (
              <pre className="whitespace-pre-wrap font-[family-name:var(--font-sans)]">
                {transcript}
              </pre>
            ) : status === "failed" ? (
              <p className="text-rose-600">
                Transcription failed to start. Check permissions, Deepgram configuration, and try
                again.
              </p>
            ) : status === "no-speech-yet" || status === "listening" ? (
              <p className="text-slate-500">
                Listening is active. Transcript will appear here as speech is detected.
              </p>
            ) : (
              <p className="text-slate-500">
                Start live capture or upload a file to populate this transcript surface.
              </p>
            )}
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Segment Timeline</h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Each local segment stays aligned with the same browser-local runtime flow used
                across the transcript and workspace routes.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
              {segments.length} segments
            </span>
          </div>

          <div className="mt-6 space-y-3">
            {segments.length > 0 ? (
              segments.map((segment) => (
                <article
                  key={segment.id}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Chunk {segment.chunkIndex + 1}
                    </p>
                    <p className="text-xs text-slate-500">
                      {segment.source === "system-audio" ? "System audio" : "Microphone"}
                    </p>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-700">{segment.text}</p>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                No transcript segments yet. This area will update from the local runtime only.
              </div>
            )}
          </div>
        </div>

        <div className="panel p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-950">Saved Transcripts</h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                {isWorkspaceVariant
                  ? "Saved transcript history is browser-local here and opens back into the same local runtime lane used by this workspace shell."
                  : persistenceInfo.mode === "supabase-active"
                    ? "Authenticated cloud transcript history is active, with safe local fallback still available when sync is unavailable."
                    : persistenceInfo.mode === "supabase-ready"
                      ? "Local transcript history is active and Supabase is ready. Sign in to unlock cloud-owned transcript history."
                      : "Local transcript history is persisted in browser storage through the repository layer."}
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
              {persistenceInfo.mode === "supabase-active" && !isWorkspaceVariant
                ? `${transcriptRecords.length} in cloud`
                : `${transcriptRecords.length} saved`}
            </span>
          </div>

          <div className="mt-6 space-y-3">
            {transcriptRecords.length > 0 ? (
              transcriptRecords.map((record) => (
                <article
                  key={record.id}
                  className={`rounded-2xl border px-4 py-4 ${
                    activeTranscriptId === record.id
                      ? "border-slate-950 bg-slate-50"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-950">{record.title}</h3>
                      <p className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                        {record.captureMode === "file-upload" ? "File Upload" : "Live Capture"} •{" "}
                        {record.status}
                      </p>
                      <p className="mt-3 text-sm leading-7 text-slate-600">
                        {record.summary.preview}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void selectTranscript(record.id)}
                        className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteTranscript(record.id)}
                        className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                No saved transcripts yet. Live capture or upload a file to create your first persisted transcript.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
