import { createPcm16Resampler, encodePcm16ToWavBlob, mergeInt16Chunks } from "./pcm-encoder";

export type LiveAudioPipelineChunk = {
  blob: Blob;
  contentType: string;
  sampleRate: number;
  frameCount: number;
  durationMs: number;
};

export type LiveAudioPipelineOptions = {
  stream: MediaStream;
  signal?: AbortSignal;
  onChunk: (chunk: LiveAudioPipelineChunk) => void;
  onError?: (error: Error) => void;
  onLevel?: (rms: number) => void;
  onDebug?: (event: string, metadata?: Record<string, number | string>) => void;
  targetSampleRate?: number;
  flushIntervalMs?: number;
  minFramesPerChunk?: number;
};

export type LiveAudioPipelineHandle = {
  stop: () => void;
  pause: () => void;
  resume: () => void;
};

type BrowserAudioContext = typeof AudioContext;
function getAudioContextClass(): BrowserAudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext || (window as Window & { webkitAudioContext?: BrowserAudioContext }).webkitAudioContext || null;
}

export function isPcmAudioPipelineSupported(): boolean {
  return getAudioContextClass() !== null;
}

/** Captures explicit mono (Web Audio downmix), emitting independently valid WAVs. */
export async function createLiveAudioPipeline(options: LiveAudioPipelineOptions): Promise<LiveAudioPipelineHandle> {
  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) throw new Error("Browser AudioContext is unavailable for PCM live capture.");
  const targetSampleRate = options.targetSampleRate ?? 16_000;
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const minFramesPerChunk = options.minFramesPerChunk ?? 2_048;
  if (!Number.isInteger(minFramesPerChunk) || minFramesPerChunk < 1 || minFramesPerChunk > targetSampleRate * 30 ||
      !Number.isFinite(flushIntervalMs) || flushIntervalMs < 10 || flushIntervalMs > 30_000) {
    throw new RangeError("PCM buffering must be bounded to at most 30 seconds.");
  }
  if (!options.stream.getAudioTracks().some((track) => track.readyState === "live" && track.enabled)) {
    throw new Error("The selected source has no active audio track.");
  }

  const context = new AudioContextClass();
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let muteNode: GainNode | undefined;
  let timer: number | undefined;
  let stopped = false;
  let abortHandler: (() => void) | undefined;
  let paused = false;
  const pcmBuffer: Int16Array[] = [];
  let bufferedFrames = 0;
  const cleanup = () => {
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    if (timer !== undefined) window.clearInterval(timer);
    if (processor) processor.onaudioprocess = null;
    // Teardown each resource independently even if a browser or callback throws.
    for (const node of [processor, source, muteNode]) {
      try { node?.disconnect(); } catch { /* An already disconnected node needs no further action. */ }
    }
    pcmBuffer.length = 0;
    bufferedFrames = 0;
    try { options.onLevel?.(0); } catch { /* Meter callbacks cannot prevent teardown. */ }
    void context.close().catch(() => undefined);
  };

  try {
    const resampler = createPcm16Resampler(context.sampleRate, targetSampleRate);
    if (options.signal?.aborted) throw new DOMException("Audio capture was cancelled.", "AbortError");
    if (context.state === "suspended") {
      let rejectStartup: (error: Error) => void = () => {};
      const abortStartup = () => rejectStartup(new DOMException("Audio capture was cancelled.", "AbortError"));
      const timeout = window.setTimeout(() => rejectStartup(new Error("AudioContext did not start in time. Retry with a user gesture.")), 5_000);
      const interrupted = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
      options.signal?.addEventListener("abort", abortStartup, { once: true });
      try { await Promise.race([context.resume(), interrupted]); }
      finally { window.clearTimeout(timeout); options.signal?.removeEventListener("abort", abortStartup); }
    }
    if (options.signal?.aborted) throw new DOMException("Audio capture was cancelled.", "AbortError");
    abortHandler = () => { if (!stopped) { stopped = true; cleanup(); } };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    if (context.state !== "running") throw new Error("AudioContext is not running. Retry capture with a user gesture.");
    options.onDebug?.("audio-context-state", { state: context.state, sampleRate: context.sampleRate, targetSampleRate });
    source = context.createMediaStreamSource(options.stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    processor.channelCount = 1;
    processor.channelCountMode = "explicit";
    muteNode = context.createGain();
    muteNode.gain.value = 0;

    const append = (pcm: Int16Array) => {
      if (!pcm.length) return;
      pcmBuffer.push(pcm);
      bufferedFrames += pcm.length;
    };
    const flush = () => {
      if (!bufferedFrames) return;
      const merged = mergeInt16Chunks(pcmBuffer);
      pcmBuffer.length = 0;
      bufferedFrames = 0;
      options.onChunk({
        blob: encodePcm16ToWavBlob({ pcm: merged, sampleRate: targetSampleRate, channels: 1 }),
        contentType: "audio/wav",
        sampleRate: targetSampleRate,
        frameCount: merged.length,
        durationMs: (merged.length / targetSampleRate) * 1000,
      });
    };
    const fail = (error: unknown) => {
      stopped = true;
      cleanup();
      options.onError?.(error instanceof Error ? error : new Error("PCM capture failed."));
    };
    processor.onaudioprocess = (event) => {
      if (stopped || paused) return;
      try {
        const samples = event.inputBuffer.getChannelData(0);
        let squares = 0;
        for (const value of samples) squares += Number.isFinite(value) ? value * value : 0;
        options.onLevel?.(samples.length ? Math.min(1, Math.sqrt(squares / samples.length)) : 0);
        append(resampler.push(samples));
        if (bufferedFrames >= minFramesPerChunk) flush();
      } catch (error) { fail(error); }
    };
    source.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(context.destination);
    timer = window.setInterval(() => {
      // The frame threshold may have just flushed a full chunk. Do not send
      // its tiny remainder on an independent timer tick; Pause/Stop still flush it.
      if (stopped || paused || bufferedFrames < minFramesPerChunk) return;
      try { flush(); } catch (error) { fail(error); }
    }, flushIntervalMs);
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          append(resampler.finish());
          flush();
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error("Unable to flush final audio."));
        } finally { cleanup(); }
      },
      pause() {
        if (stopped || paused) return;
        paused = true;
        try { append(resampler.finish()); flush(); } catch (error) { fail(error); }
        options.onLevel?.(0);
      },
      resume() { if (!stopped) paused = false; },
    };
  } catch (error) {
    stopped = true;
    cleanup();
    throw error;
  }
}
