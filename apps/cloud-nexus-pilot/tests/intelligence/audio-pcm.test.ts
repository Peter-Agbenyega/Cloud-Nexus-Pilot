import assert from "node:assert/strict";
import { test } from "node:test";
import { createPcm16Resampler, downsampleFloat32ToPcm16, encodePcm16ToWavBlob, mergeInt16Chunks } from "../../lib/audio/pcm-encoder";
import { createLiveAudioPipeline, type LiveAudioPipelineChunk } from "../../lib/audio/live-audio-pipeline";
import { cleanTranscriptText } from "../../features/transcription/transcript-bridge";
import { createCaptureStream, requireActiveAudioTracks } from "../../features/transcription/audio-capture";

for (const rate of [44_100, 48_000]) {
  test(`${rate} Hz capture preserves sample count and fractional phase over arbitrary callback boundaries`, () => {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i * 0.13) * 0.7);
    const expected = createPcm16Resampler(rate, 16_000).push(input);
    const resampler = createPcm16Resampler(rate, 16_000);
    const parts: Int16Array[] = [];
    for (let offset = 0; offset < input.length; offset += 2048) parts.push(resampler.push(input.subarray(offset, offset + 2048)));
    parts.push(resampler.finish());
    const actual = mergeInt16Chunks(parts);
    assert.equal(actual.length, 16_000);
    assert.deepEqual(actual, expected);
  });
}

test("PCM clamps clipping, normalizes nonfinite input, preserves silence and rejects upsampling", () => {
  assert.deepEqual([...downsampleFloat32ToPcm16({ samples: Float32Array.of(-2, -1, 0, 1, 2, NaN, Infinity), inputSampleRate: 16_000, outputSampleRate: 16_000 })], [-32768, -32768, 0, 32767, 32767, 0, 0]);
  assert.equal(createPcm16Resampler(48_000, 16_000).push(new Float32Array(48_000)).some(Boolean), false);
  for (const rates of [[16_000, 48_000], [0, 16_000], [48_000, NaN]]) assert.throws(() => createPcm16Resampler(rates[0]!, rates[1]!), RangeError);
});

test("first and later WAV chunks have complete headers, correct lengths and explicit stereo framing", async () => {
  for (const channels of [1, 2]) {
    for (const frames of [0, 6400, 1600]) {
      const blob = encodePcm16ToWavBlob({ pcm: new Int16Array(frames * channels), sampleRate: 16_000, channels });
      const bytes = await blob.arrayBuffer(); const view = new DataView(bytes);
      assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
      assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
      assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
      assert.equal(view.getUint32(40, true), frames * channels * 2);
      assert.equal(view.getUint16(22, true), channels);
      assert.equal(view.getUint32(28, true), 16_000 * channels * 2);
      assert.equal(view.getUint16(32, true), channels * 2);
    }
  }
  assert.throws(() => encodePcm16ToWavBlob({ pcm: new Int16Array(3), sampleRate: 16_000, channels: 2 }), RangeError);
  assert.throws(() => encodePcm16ToWavBlob({ pcm: new Int16Array(0), sampleRate: 0 }), RangeError);
});

class FakeNode {
  disconnected = 0; channelCount = 1; channelCountMode = "explicit"; gain = { value: 1 };
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
  connect() {} disconnect() { this.disconnected += 1; }
}
class FakeAudioContext {
  static current: FakeAudioContext; static failResume = false; static hangResume = false;
  state = "suspended"; sampleRate = 48_000; destination = new FakeNode(); closed = 0;
  source = new FakeNode(); processor = new FakeNode(); mute = new FakeNode();
  constructor() { FakeAudioContext.current = this; }
  async resume() { if (FakeAudioContext.hangResume) await new Promise<void>(() => {}); if (FakeAudioContext.failResume) throw new Error("resume denied"); this.state = "running"; }
  async close() { this.closed += 1; this.state = "closed"; }
  createMediaStreamSource() { return this.source; }
  createScriptProcessor() { return this.processor; }
  createGain() { return this.mute; }
  feed(samples: Float32Array) { this.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } } as unknown as AudioProcessingEvent); }
}
const audioStream = () => ({ getAudioTracks: () => [{ readyState: "live", enabled: true }] }) as unknown as MediaStream;
function fakeWindow(t: { after: (fn: () => void) => void }) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: FakeAudioContext, setInterval, clearInterval, setTimeout, clearTimeout } });
  t.after(() => { if (old) Object.defineProperty(globalThis, "window", old); else Reflect.deleteProperty(globalThis, "window"); FakeAudioContext.failResume = false; FakeAudioContext.hangResume = false; });
}

test("pipeline reports actual RMS, pauses without frames, flushes final WAV once and tears down", async (t) => {
  fakeWindow(t); const chunks: LiveAudioPipelineChunk[] = []; const levels: number[] = [];
  const handle = await createLiveAudioPipeline({ stream: audioStream(), onChunk: c => chunks.push(c), onLevel: v => levels.push(v), minFramesPerChunk: 1000 });
  const context = FakeAudioContext.current;
  context.feed(new Float32Array(2048).fill(0.5));
  handle.pause(); const pausedFrames = chunks.reduce((n, c) => n + c.frameCount, 0);
  context.feed(new Float32Array(2048).fill(0.8));
  assert.equal(chunks.reduce((n, c) => n + c.frameCount, 0), pausedFrames);
  handle.resume(); context.feed(new Float32Array(2048).fill(0.25));
  handle.stop(); handle.stop();
  assert.ok(levels.includes(0.5)); assert.ok(levels.includes(0.25)); assert.equal(levels.at(-1), 0);
  assert.equal(context.closed, 1); assert.equal(context.processor.onaudioprocess, null);
  for (const node of [context.source, context.processor, context.mute]) assert.equal(node.disconnected, 1);
  for (const chunk of chunks) {
    assert.equal(chunk.blob.size, 44 + chunk.frameCount * 2);
    assert.equal(chunk.durationMs, chunk.frameCount / chunk.sampleRate * 1000);
  }
});

test("throwing final consumer and failed startup cannot leave audio nodes or contexts running", async (t) => {
  fakeWindow(t); let errors = 0;
  const handle = await createLiveAudioPipeline({ stream: audioStream(), onChunk: () => { throw new Error("consumer failed"); }, onError: () => { errors += 1; }, minFramesPerChunk: 10_000 });
  const context = FakeAudioContext.current; context.feed(new Float32Array(2048)); handle.stop(); handle.stop();
  assert.equal(errors, 1); assert.equal(context.closed, 1);
  for (const node of [context.source, context.processor, context.mute]) assert.equal(node.disconnected, 1);
  FakeAudioContext.failResume = true;
  await assert.rejects(createLiveAudioPipeline({ stream: audioStream(), onChunk() {} }), /resume denied/);
  assert.equal(FakeAudioContext.current.closed, 1);
});

test("video-only sharing releases acquired tracks and never silently acquires a microphone", async (t) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "navigator"); let stopped = 0, microphones = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getDisplayMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [{ stop: () => { stopped += 1; } }] }),
    getUserMedia: async () => { microphones += 1; return audioStream(); },
  } } });
  t.after(() => { if (old) Object.defineProperty(globalThis, "navigator", old); else Reflect.deleteProperty(globalThis, "navigator"); });
  await assert.rejects(createCaptureStream("system-audio"), /did not provide active audio/);
  assert.equal(stopped, 1); assert.equal(microphones, 0);
  assert.throws(() => requireActiveAudioTracks({ getAudioTracks: () => [{ readyState: "ended", enabled: true }] } as unknown as MediaStream), /active audio/);
});

test("transcript cleanup preserves short answers, negations and technical LIKE rather than guessing filler", () => {
  for (const text of ["No.", "I did not deploy it.", "What does the SQL LIKE operator do?", "I like Kubernetes.", "Thank you."]) {
    assert.equal(cleanTranscriptText(text), text);
  }
});

test("cancelling suspended audio startup closes its context rather than hanging past Stop", async (t) => {
  fakeWindow(t); FakeAudioContext.hangResume = true;
  const controller = new AbortController();
  const pending = createLiveAudioPipeline({ stream: audioStream(), signal: controller.signal, onChunk() {} });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(FakeAudioContext.current.closed, 1);
});
