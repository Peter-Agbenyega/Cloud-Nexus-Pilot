export type GuidanceTiming = { completed: number; totalMs: number };

/** Counts completed requests only; idle time and failed requests are not latency. */
export function recordGuidanceTiming(current: GuidanceTiming, startedAt: number, completedAt: number): GuidanceTiming {
  const elapsed = completedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return current;
  return { completed: current.completed + 1, totalMs: current.totalMs + elapsed };
}

export function formatGuidanceTiming(current: GuidanceTiming): string {
  return current.completed ? `${(current.totalMs / current.completed / 1000).toFixed(1)}s` : "--";
}

/** An acknowledged guidance result cannot erase an earlier audio-save failure. */
export function describeSaveAcknowledgement(state: string, processingError: string, feedback: string): string {
  return processingError
    ? `Processing issue: ${processingError} Saved guidance is tracked separately below.`
    : `Server acknowledgement: ${state}. ${feedback}`;
}
