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
const timeoutMs = Number.parseInt(process.env.STREAMING_TEST_TIMEOUT_MS ?? "15000", 10);
const chunkIndex = 0;

function printFailure(message, detail) {
  console.error("LAYER 2 STREAMING TEST: FAIL");
  console.error(message);
  if (detail) {
    console.error(detail);
  }
}

function fail(message, detail, exitCode = 1) {
  printFailure(message, detail);
  process.exit(exitCode);
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

async function main() {
  await ensureReadableFile(inputPath);

  const fileBuffer = await readFile(inputPath);
  const createEndpoint = new URL("/api/transcribe/stream/session", baseUrl).toString();

  console.log("LAYER 2 STREAMING TEST: START");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Input file: ${inputPath}`);
  console.log(`Bytes: ${fileBuffer.byteLength}`);

  const createResponse = await fetch(createEndpoint, {
    method: "POST",
  }).catch((error) => {
    fail(
      "Request to create a streaming session failed before a response was received.",
      error instanceof Error ? error.message : String(error)
    );
  });

  const createPayload = await parseJsonResponse(createResponse);
  console.log("Create session response:");
  console.log(JSON.stringify(createPayload, null, 2));

  if (!createResponse.ok) {
    fail(`Session create route returned HTTP ${createResponse.status}.`);
  }

  const sessionId =
    createPayload && typeof createPayload.sessionId === "string"
      ? createPayload.sessionId.trim()
      : "";

  if (!sessionId) {
    fail("Session create route succeeded, but no sessionId was returned.");
  }

  const eventsEndpoint = new URL(
    `/api/transcribe/stream/session/${sessionId}/events`,
    baseUrl
  ).toString();
  const chunkEndpoint = new URL(
    `/api/transcribe/stream/session/${sessionId}/chunk`,
    baseUrl
  ).toString();
  const stopEndpoint = new URL(
    `/api/transcribe/stream/session/${sessionId}/stop`,
    baseUrl
  ).toString();

  const sseAbortController = new AbortController();
  const sseReady = createDeferred();
  const chunkResult = createDeferred();
  let settled = false;
  let exitCode = 0;
  let failureMessage = "";
  let failureDetail = "";
  let sseConnected = false;

  const failAfterCleanup = (message, detail, nextExitCode = 1) => {
    if (!failureMessage) {
      failureMessage = message;
      failureDetail = detail ?? "";
      exitCode = nextExitCode;
    }
  };

  const settleFailure = (message) => {
    if (settled) return;
    settled = true;
    chunkResult.reject(new Error(message));
  };

  const settleSuccess = (payload) => {
    if (settled) return;
    settled = true;
    chunkResult.resolve(payload);
  };

  const readEventsPromise = (async () => {
    const response = await fetch(eventsEndpoint, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
      signal: sseAbortController.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Events route returned HTTP ${response.status}.`);
    }

    if (!response.body) {
      throw new Error("Events route did not provide a readable SSE body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const lines = frame.split("\n").map((line) => line.trimEnd());
        let eventName = "message";
        const dataLines = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
            continue;
          }

          if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart());
          }
        }

        if (dataLines.length === 0) continue;

        let payload;
        try {
          payload = JSON.parse(dataLines.join("\n"));
        } catch (error) {
          throw new Error(
            `Unable to parse SSE payload as JSON: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        console.log(`SSE event (${eventName}):`);
        console.log(JSON.stringify(payload, null, 2));

        if (
          payload &&
          payload.type === "status" &&
          payload.sessionId === sessionId &&
          payload.status === "connected"
        ) {
          sseConnected = true;
          sseReady.resolve(payload);
        }

        if (
          payload &&
          payload.type === "chunk-result" &&
          payload.sessionId === sessionId &&
          payload.chunkIndex === chunkIndex
        ) {
          const transcriptText =
            payload.response && typeof payload.response.text === "string"
              ? payload.response.text.trim()
              : "";

          if (!transcriptText) {
            settleFailure(
              "Deepgram returned empty transcript — fixture may be silent or contain no recognizable speech."
            );
            failAfterCleanup(
              "Deepgram returned empty transcript — fixture may be silent or contain no recognizable speech.",
              "",
              2
            );
            continue;
          }

          settleSuccess(payload);
          continue;
        }

        if (
          payload &&
          payload.type === "chunk-error" &&
          payload.sessionId === sessionId &&
          payload.chunkIndex === chunkIndex
        ) {
          const errorMessage =
            payload.error && typeof payload.error.message === "string"
              ? payload.error.message
              : "Streaming session returned a chunk-error event.";
          settleFailure(errorMessage);
        }
      }
    }

    if (!settled) {
      settleFailure("SSE stream ended before a matching chunk-result event was received.");
    }
  })().catch((error) => {
    if (sseAbortController.signal.aborted && !settled) {
      const message = sseConnected
        ? "SSE connection was aborted before receiving a chunk result."
        : "SSE connection failed before the connected event was received.";
      sseReady.reject(new Error(message));
      settleFailure(message);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    sseReady.reject(new Error(message));
    if (!settled) {
      settleFailure(message);
    }
  });

  const timeoutId = setTimeout(() => {
    const message = sseConnected
      ? `Timed out after ${timeoutMs}ms waiting for a chunk-result SSE event.`
      : `Timed out after ${timeoutMs}ms waiting for the SSE connected event.`;
    sseReady.reject(new Error(message));
    settleFailure(message);
    sseAbortController.abort();
  }, timeoutMs);

  try {
    await sseReady.promise;

    console.log(`POST ${chunkEndpoint}`);
    const chunkResponse = await fetch(chunkEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": String(chunkIndex),
        "X-Transcript-Source": "system-audio",
      },
      body: fileBuffer,
    });

    const chunkPayload = await parseJsonResponse(chunkResponse);
    console.log("Chunk ingest response:");
    console.log(JSON.stringify(chunkPayload, null, 2));

    if (!chunkResponse.ok) {
      throw new Error(`Chunk route returned HTTP ${chunkResponse.status}.`);
    }

    const resultPayload = await chunkResult.promise;
    const transcriptText = resultPayload.response.text.trim();

    console.log("LAYER 2 STREAMING TEST: PASS");
    console.log(`Session ID: ${sessionId}`);
    console.log(`Chunk index: ${resultPayload.chunkIndex}`);
    console.log(`Transcript chars: ${transcriptText.length}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Streaming verification failed unexpectedly.";
    if (!failureMessage) {
      failAfterCleanup(message);
    }
  } finally {
    clearTimeout(timeoutId);
    sseAbortController.abort();
    await fetch(stopEndpoint, { method: "POST" }).catch(() => undefined);
    await readEventsPromise.catch(() => undefined);
  }

  if (failureMessage) {
    fail(failureMessage, failureDetail, exitCode);
  }
}

await main();
