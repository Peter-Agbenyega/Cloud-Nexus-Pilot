function downsampleChunk(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (inputSampleRate === outputSampleRate) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < output.length) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      accum += input[i] ?? 0;
      count += 1;
    }
    const average = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, average));
    output[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return output;
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
  return downsampleChunk(params.samples, params.inputSampleRate, params.outputSampleRate);
}
