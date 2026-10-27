"use client";

import Link from "next/link";
import { CaptureDisclosure } from "@/components/capture-disclosure";
import { SavedSessionPicker } from "@/components/saved-session-picker";
import { useRef } from "react";

import type { LiveTranscriptionSource } from "@/features/transcription/audio-capture";
import type { UseTranscriptionWorkflowResult } from "@/features/transcription/use-transcription-workflow";

const STATUS_LABELS = {
  idle: "Idle",
  connecting: "Connecting",
  listening: "Listening",
  "receiving-transcript": "Receiving Transcript",
  "no-speech-yet": "No Speech Yet",
  paused: "Paused",
  stopping: "Finishing bounded uploads",
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
    isPaused,
    audioLevel,
    pauseCapture,
    resumeCapture,
    transportStatus,
    serverSessionId,
    savedGuidance,
    serverSaveState,
    recoverServerSession,
    exportServerSession,
    deleteServerSession,
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
                : "Capture live audio or upload a completed recording."}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
              {isWorkspaceVariant
                ? "This transcript lane can attach to the selected active audio stream. Capture, transport and transcript progress are separate states."
                : "Capture is visible and user initiated. Audio is sent through the authenticated server to its configured transcription provider. Capture only content you are authorized to process; Stop releases the source. Provider secrets remain on the server."}
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

        <CaptureDisclosure sharedSession={isWorkspaceVariant} />

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
              disabled={isRecording || status === "stopping"}
            >
              <option value="microphone">Microphone</option>
              <option value="system-audio" disabled={!systemAudioSupported}>
                Tab / System Audio
              </option>
            </select>
          </label>

          <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
            {isSupported
              ? "PCM capture is available. Each upload is a complete mono WAV; check the meter before expecting transcript updates."
              : "Live PCM capture is unavailable. Explicitly upload a completed audio recording or text file instead."}
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Live Audio Stream
            </p>
            <p className="mt-2 font-semibold text-slate-900">
              {isRecording ? (isPaused ? "Acquired, processing paused" : "Capturing") : "Not capturing"}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Transport / Processing
            </p>
            <p className="mt-2 font-semibold text-slate-900">
              {transportStatus}; {isTranscribing ? "request in progress" : "no request in progress"}
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

        <label className="mt-5 block text-sm font-medium text-slate-700">
          Selected-source input level
          <meter className="mt-2 block w-full" min={0} max={1} value={audioLevel} aria-label="Selected-source audio level" />
          <span className="text-xs text-slate-500">{isRecording ? (isPaused ? "Paused; queued audio may still finish." : "A moving level confirms a captured signal, not provider success.") : "No active capture."}</span>
        </label>

        <div className="mt-5 rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
          Persistence mode:{" "}
          <span className="font-semibold text-slate-900">{persistenceInfo.mode}</span>
          <p className="mt-2 leading-7">{persistenceInfo.note}</p>
        </div>

        <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
          <p className="font-semibold">Server save: {serverSaveState}</p>
          <p className="mt-2">Only acknowledged final events are saved on the server. Browser-local history is separate. Live audio is not retained; interrupted audio may be missing.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" onClick={() => void recoverServerSession()} disabled={!serverSessionId || isRecording || status === "stopping"} className="rounded-full border px-4 py-2 disabled:opacity-50">Recover saved session</button>
            <button type="button" onClick={() => void exportServerSession()} disabled={!serverSessionId} className="rounded-full border px-4 py-2 disabled:opacity-50">Export server session</button>
            <button type="button" onClick={() => void deleteServerSession()} disabled={!serverSessionId || isRecording || status === "stopping"} className="rounded-full border px-4 py-2 disabled:opacity-50">Delete server session</button>
          </div>
          <SavedSessionPicker sessions={workflow.savedServerSessions} loading={workflow.isFindingServerSessions}
            disabled={isRecording || status === "stopping"} find={workflow.findServerSessions} recover={recoverServerSession} />
          {savedGuidance.length ? <div className="mt-4 space-y-3">
            <h3 className="font-semibold">Saved guidance for this session</h3>
            {savedGuidance.map(item => <article key={item.operationId} className="rounded-xl border border-slate-200 p-3">
              <p className="font-medium">{item.question}</p><p className="mt-2">{item.speakNow}</p>
              {item.fullAnswer ? <details className="mt-2"><summary>Full saved answer</summary><p className="mt-2 whitespace-pre-wrap">{item.fullAnswer}</p></details> : null}
            </article>)}
          </div> : null}
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
            disabled={!isSupported || isRecording || status === "stopping"}
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Start Live Capture
          </button>
          <button
            type="button"
            onClick={isPaused ? resumeCapture : pauseCapture}
            disabled={!isRecording || status === "connecting" || status === "stopping"}
            className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 disabled:opacity-60"
          >
            {isPaused ? "Resume" : "Pause"}
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
            Upload Transcript or PCM WAV
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
            accept=".txt,.md,.json,.srt,.vtt,.wav,audio/wav"
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
                    ? "The configured provider is processing incoming audio."
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
                Transcription failed to start. Check permissions, OpenAI configuration, and try
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
