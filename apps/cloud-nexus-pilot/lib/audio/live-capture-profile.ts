// Two-second complete PCM windows reduce capture latency without sending
// the subsecond residual fragments that produced unstable transcription.
export const LIVE_CAPTURE_SAMPLE_RATE = 16_000;
export const LIVE_CAPTURE_INTERVAL_MS = 2_000;
export const LIVE_CAPTURE_MIN_FRAMES = LIVE_CAPTURE_SAMPLE_RATE * LIVE_CAPTURE_INTERVAL_MS / 1_000;
