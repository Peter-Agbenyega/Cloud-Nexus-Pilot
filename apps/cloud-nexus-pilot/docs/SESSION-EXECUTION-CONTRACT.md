# Session Execution Contract

## Purpose

This document defines the frontend-safe session execution contract for `apps/cloud-nexus-pilot`.

It sits above the session context layer and below future interview or consultation runtime behavior.

## Contract Files

- `lib/contracts/session-execution.ts`
- `lib/contracts/session-execution-client.ts`

## What This Layer Does

The session execution layer defines the request and response shapes for:

- create or resume session execution
- append session turns
- request a non-streaming answer
- request a streaming answer

It keeps Prompt Vault and Transcription linked by reference only through existing session context reference types.

## What This Layer Does Not Do

- no backend execution runtime
- no streaming engine
- no persistence repository
- no summarization pipeline
- no semantic memory

## Core Types

Defined in `lib/contracts/session-execution.ts`:

- `SessionExecutionId`
- `SessionTurnId`
- `SessionTurnRole`
- `SessionExecutionStatus`
- `SessionTurnRecord`
- `CreateOrResumeSessionInput`
- `CreateOrResumeSessionResponse`
- `AppendSessionTurnInput`
- `AppendSessionTurnResponse`
- `RequestSessionAnswerInput`
- `SessionAnswerChunk`
- `SessionAnswerResponse`
- `StreamSessionAnswerRequest`
- `SessionExecutionValidationError`
- `SessionExecutionApiError`

## Endpoint Shape

Reserved execution endpoints:

- `POST /sessions/execute`
- `POST /sessions/execute/:id/turns`
- `POST /sessions/execute/:id/answer`
- `POST /sessions/execute/:id/stream`

These endpoints are contract placeholders only for now.

## Relationship To Session Context

Session context remains the source of truth for:

- mode
- selected prompt references
- selected transcript references
- current goal

Session execution remains the source of truth for:

- active execution id
- appended turns
- answer request envelopes
- answer and stream response envelopes

That boundary keeps orchestration separate from asset storage and from session context mutation.

## Reference Safety

Execution requests reuse `SessionPromptRef` and `SessionTranscriptRef` so:

- prompt bodies are not duplicated into a separate contract family
- transcript records are not tightly coupled to execution implementation
- future backend runtime can hydrate the needed assets by reference

## Intentionally Deferred

- runtime session engine
- stream parser or SSE orchestration
- answer ranking or follow-up logic execution
- note promotion
- durable turn persistence strategy

This contract exists to keep the next implementation milestone bounded and backend-safe.
