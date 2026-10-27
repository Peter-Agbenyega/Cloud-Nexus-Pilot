function toPcm16(sample: number): number {
  const finite = Number.isFinite(sample) ? sample : 0;
  const clamped = Math.max(-1, Math.min(1, finite));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/** Area-average resampling with fractional phase carried across capture callbacks. */
export function createPcm16Resampler(inputSampleRate: number, outputSampleRate: number) {
  if (!Number.isFinite(inputSampleRate) || !Number.isFinite(outputSampleRate) ||
      inputSampleRate <= 0 || outputSampleRate <= 0 || outputSampleRate > inputSampleRate) {
    throw new RangeError("PCM capture requires positive sample rates and does not support upsampling.");
  }
  const ratio = inputSampleRate / outputSampleRate;
  let weightedSum = 0;
  let filled = 0;
  return {
    push(input: Float32Array): Int16Array {
      const output: number[] = [];
      for (const value of input) {
        let remaining = 1;
        const sample = Number.isFinite(value) ? value : 0;
        while (remaining > 1e-10) {
          const take = Math.min(remaining, ratio - filled);
          weightedSum += sample * take;
          filled += take;
          remaining -= take;
          if (ratio - filled < 1e-10) {
            output.push(toPcm16(weightedSum / ratio));
            filled = 0;
            weightedSum = 0;
          }
        }
      }
      return Int16Array.from(output);
    },
    finish(): Int16Array {
      if (filled === 0) return new Int16Array(0);
      const result = Int16Array.of(toPcm16(weightedSum / filled));
      filled = 0;
      weightedSum = 0;
      return result;
    },
  };
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

export function mergeInt16Chunks(chunks: Int16Array[]): Int16Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function encodePcm16ToWavBlob(params: {
  pcm: Int16Array;
  sampleRate: number;
  channels?: number;
}): Blob {
  const channels = params.channels ?? 1;
  if (!Number.isInteger(params.sampleRate) || params.sampleRate <= 0 || params.sampleRate > 384_000) {
    throw new RangeError("WAV sample rate is invalid.");
  }
  if ((channels !== 1 && channels !== 2) || params.pcm.length % channels !== 0) {
    throw new RangeError("WAV requires complete mono or interleaved stereo frames.");
  }
  const bytesPerSample = 2;
  const dataSize = params.pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, params.sampleRate, true);
  view.setUint32(28, params.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < params.pcm.length; i += 1) {
    view.setInt16(offset, params.pcm[i] ?? 0, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function downsampleFloat32ToPcm16(params: {
  samples: Float32Array;
  inputSampleRate: number;
  outputSampleRate: number;
}): Int16Array {
  return createPcm16Resampler(params.inputSampleRate, params.outputSampleRate).push(params.samples);
}
