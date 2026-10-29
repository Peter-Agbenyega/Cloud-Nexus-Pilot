import type { TranscriptionStatus } from "./use-transcription-workflow";

/** Only an explicit capture start opens a new retry generation. */
export class CaptureRetryQueue {
  private epoch = 0;
  private active = false;
  private pending = new Set<number>();
  constructor(private timers = {
    set: (callback: () => void, delay: number): number => window.setTimeout(callback, delay),
    clear: (id: number) => window.clearTimeout(id),
  }) {}
  begin() { this.cancel(); this.active = true; }
  cancel() {
    this.active = false; this.epoch += 1;
    for (const id of this.pending) this.timers.clear(id);
    this.pending.clear();
  }
  schedule(callback: () => void, delay: number) {
    if (!this.active) return;
    const epoch = this.epoch;
    const id = this.timers.set(() => {
      this.pending.delete(id);
      if (this.active && epoch === this.epoch) callback();
    }, delay);
    this.pending.add(id);
  }
}

export function shouldRetryChunk(error: unknown, attempt: number): boolean {
  if (attempt >= 2) return false;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  // Auth, quota, invalid input, unknown settlement and unavailable configuration
  // require an explicit recovery action, not another upload of the same audio.
  return !(typeof status === "number" && (status >= 400 && status < 500 || status === 503));
}

export function capturePresentation(recording: boolean, paused: boolean, status: TranscriptionStatus) {
  const stopped = !recording || status === "failed" || status === "stopped" || status === "stopping";
  return {
    stopped,
    label: stopped ? (status === "stopping" ? "Stopping audio capture" : "Audio capture stopped") : paused ? "Audio processing paused" : "Audio capture active",
    canPause: !stopped && status !== "connecting",
    canRetry: stopped && status !== "stopping" && status !== "connecting",
  };
}
