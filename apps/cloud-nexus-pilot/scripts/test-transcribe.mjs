import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const defaultFixturePath = path.join(appRoot, "test-fixtures", "known-sample.wav");
const inputArg = process.argv[2]?.trim();
const inputPath = inputArg ? path.resolve(process.cwd(), inputArg) : defaultFixturePath;
const baseUrl =
  process.env.CLOUD_NEXUS_TEST_BASE_URL?.trim() ||
  process.env.TEST_BASE_URL?.trim() ||
  "http://127.0.0.1:3000";
const timeoutMs = Number.parseInt(process.env.TRANSCRIBE_TEST_TIMEOUT_MS ?? "30000", 10);

function printFailure(message, detail) {
  console.error("LAYER 1 TRANSCRIBE TEST: FAIL");
  console.error(message);
  if (detail) {
    console.error(detail);
  }
}

function fail(message, detail, exitCode = 1) {
  printFailure(message, detail);
  process.exit(exitCode);
}

function warnEmptyTranscript() {
  console.error("LAYER 1 TRANSCRIBE TEST: EMPTY TRANSCRIPT");
  console.error(
    "OpenAI returned an empty transcript. The fixture may be silent or contain no recognizable speech."
  );
  process.exit(2);
}

async function ensureReadableFile(filePath) {
  try {
    await access(filePath);
  } catch {
    fail(
      `Audio fixture not found at ${filePath}`,
      "Provide a WAV file as the first CLI arg, or place one at apps/cloud-nexus-pilot/test-fixtures/known-sample.wav"
    );
  }
}

async function parseJsonResponse(response) {
  const bodyText = await response.text();
  try {
    return bodyText ? JSON.parse(bodyText) : null;
  } catch {
    return { raw: bodyText };
  }
}

async function main() {
  await ensureReadableFile(inputPath);

  const fileBuffer = await readFile(inputPath);
  const endpoint = new URL("/api/transcribe", baseUrl).toString();

  console.log("LAYER 1 TRANSCRIBE TEST: START");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Input file: ${inputPath}`);
  console.log(`Bytes: ${fileBuffer.byteLength}`);
  console.log(`POST ${endpoint}`);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      "X-Chunk-Index": "0",
      "X-Transcript-Source": "system-audio",
    },
    body: fileBuffer,
    signal: abortController.signal,
  }).catch((error) => {
    if (error instanceof Error && error.name === "AbortError") {
      fail(
        `Request to /api/transcribe timed out after ${timeoutMs}ms.`,
        "The backend or OpenAI request did not complete before the timeout."
      );
    }
    fail(
      "Request to /api/transcribe failed before a response was received.",
      error instanceof Error ? error.message : String(error)
    );
  });
  clearTimeout(timeoutId);

  const payload = await parseJsonResponse(response);

  console.log("Response JSON:");
  console.log(JSON.stringify(payload, null, 2));

  if (!response.ok) {
    fail(`Route returned HTTP ${response.status}.`);
  }

  const transcriptText =
    payload && typeof payload.text === "string" ? payload.text.trim() : "";

  if (!transcriptText) {
    warnEmptyTranscript();
  }

  console.log("LAYER 1 TRANSCRIBE TEST: PASS");
  console.log(`Transcript chars: ${transcriptText.length}`);
}

await main();
