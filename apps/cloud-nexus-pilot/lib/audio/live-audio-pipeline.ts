import {
  downsampleFloat32ToPcm16,
  encodePcm16ToWavBlob,
  mergeInt16Chunks,
} from "@/lib/audio/pcm-encoder";

export type LiveAudioPipelineChunk = {
  blob: Blob;
  contentType: string;
  sampleRate: number;
  frameCount: number;
  durationMs: number;
};

export type LiveAudioPipelineOptions = {
  stream: MediaStream;
  onChunk: (chunk: LiveAudioPipelineChunk) => void;
  onError?: (error: Error) => void;
  onDebug?: (event: string, metadata?: Record<string, number | string>) => void;
  targetSampleRate?: number;
  flushIntervalMs?: number;
  minFramesPerChunk?: number;
};

export type LiveAudioPipelineHandle = {
  stop: () => void;
};

type BrowserAudioContext = typeof AudioContext;
const shouldDebugLogs = process.env.NODE_ENV !== "production";

function getAudioContextClass(): BrowserAudioContext | null {
  if (typeof window === "undefined") return null;

  const value =
    window.AudioContext || ((window as Window & { webkitAudioContext?: BrowserAudioContext }).webkitAudioContext ?? null);
  return value ?? null;
}

export function isPcmAudioPipelineSupported(): boolean {
  return getAudioContextClass() !== null;
}

export async function createLiveAudioPipeline(
  options: LiveAudioPipelineOptions
): Promise<LiveAudioPipelineHandle> {
  // Migration foundation:
  // This module creates a browser-local PCM capture seam so live transcription does not
  // depend exclusively on MediaRecorder container chunk boundaries while keeping the
  // existing live UI wired to the persistent streaming transcription session.
  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) {
    throw new Error("Browser AudioContext is unavailable for PCM live capture.");
  }

  const targetSampleRate = options.targetSampleRate ?? 16_000;
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const minFramesPerChunk = options.minFramesPerChunk ?? 2_048;
  const minFramesForTimedFlush = Math.max(4_096, Math.floor(minFramesPerChunk / 2));

  const context = new AudioContextClass();
  try {
    if (context.state === "suspended") {
      await context.resume();
    }
    options.onDebug?.("audio-context-state", {
      state: context.state,
      sampleRate: context.sampleRate,
      targetSampleRate,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AudioContext failed to resume for PCM capture.";
    options.onDebug?.("audio-context-state", {
      state: context.state,
      sampleRate: context.sampleRate,
      targetSampleRate,
      error: message,
    });
    throw new Error(message);
  }

  const source = context.createMediaStreamSource(options.stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  const muteNode = context.createGain();
  muteNode.gain.value = 0;

  const pcmBuffer: Int16Array[] = [];
  let bufferedFrames = 0;
  let stopped = false;

  const flush = (reason: "timer" | "buffer-threshold" | "close") => {
    if (stopped && reason !== "close") return;
    const requiredFrames =
      reason === "timer" ? minFramesForTimedFlush : reason === "close" ? 1 : minFramesPerChunk;
    if (shouldDebugLogs) {
      options.onDebug?.("pcm-flush-check", {
        reason,
        bufferedFrames,
        requiredFrames,
        minFramesPerChunk,
        minFramesForTimedFlush,
      });
    }
    if (bufferedFrames < requiredFrames) {
      if (shouldDebugLogs) {
        options.onDebug?.("pcm-flush-skipped", {
          reason,
          skipReason: bufferedFrames === 0 ? "no-buffered-frames" : "below-required-frames",
          bufferedFrames,
          requiredFrames,
          minFramesPerChunk,
          minFramesForTimedFlush,
        });
      }
      return;
    }

    const merged = mergeInt16Chunks(pcmBuffer);
    pcmBuffer.length = 0;
    bufferedFrames = 0;

    const blob = encodePcm16ToWavBlob({
      pcm: merged,
      sampleRate: targetSampleRate,
      channels: 1,
    });
    if (shouldDebugLogs) {
      options.onDebug?.("pcm-flush-triggered", {
        reason,
        bytes: blob.size,
        frames: merged.length,
        durationMs: Math.round((merged.length / targetSampleRate) * 1000),
      });
      options.onDebug?.("pcm-flush", {
        bytes: blob.size,
        frames: merged.length,
        sampleRate: targetSampleRate,
      });
    }
    options.onChunk({
      blob,
      contentType: "audio/wav",
      sampleRate: targetSampleRate,
      frameCount: merged.length,
      durationMs: Math.round((merged.length / targetSampleRate) * 1000),
    });
  };

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const channelData = event.inputBuffer.getChannelData(0);
    if (!channelData || channelData.length === 0) return;

    const pcm = downsampleFloat32ToPcm16({
      samples: channelData,
      inputSampleRate: context.sampleRate,
      outputSampleRate: targetSampleRate,
    });
    if (pcm.length === 0) return;

    pcmBuffer.push(pcm);
    bufferedFrames += pcm.length;
    if (shouldDebugLogs) {
      options.onDebug?.("pcm-buffered", {
        addedFrames: pcm.length,
        bufferedFrames,
        inputSampleRate: context.sampleRate,
        targetSampleRate,
      });
    }
    if (bufferedFrames >= minFramesPerChunk) {
      flush("buffer-threshold");
    }
  };

  source.connect(processor);
  processor.connect(muteNode);
  muteNode.connect(context.destination);
  const timer = window.setInterval(() => {
    flush("timer");
  }, flushIntervalMs);

  const close = () => {
    if (stopped) return;
    window.clearInterval(timer);
    try {
      flush("close");
      stopped = true;
      processor.disconnect();
      source.disconnect();
      muteNode.disconnect();
      void context.close();
    } catch (error) {
      const err = error instanceof Error ? error : new Error("Unable to stop audio pipeline.");
      options.onError?.(err);
    }
  };

  return {
    stop: close,
  };
}
