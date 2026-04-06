# Cloud Nexus Pilot Backend Contracts

## Purpose

This document defines the frontend-facing backend contract layer for `apps/cloud-nexus-pilot` before any backend code is migrated. The goal is to keep the Next.js app ready for future interview, transcription, and session-memory integration without importing donor backend implementation directly.

## Contract Files

- `lib/contracts/interview.ts`
- `lib/contracts/transcription.ts`
- `lib/contracts/backend-client.ts`

These files are intentionally frontend-safe and passive:

- typed request and response contracts
- endpoint path constants
- request payload builders
- request-init builders

They do not trigger live backend calls by themselves.

## Future Backend Endpoints Required

### 1. `POST /interview`

Purpose:

- generate a non-streaming interview or copilot answer

Frontend features that depend on it:

- dashboard workspace answer generation
- transcript-to-answer workflow
- future AI summary assistance for interview content

Expected request fields:

- `prompt`
- optional `question` alias
- optional `role`
- optional `answer_mode`
- optional `session_id`
- optional `resume_text`
- optional `job_description_text`
- optional `interview_intent`

Expected response fields:

- `answer`
- optional `session_id`
- `answer_mode`
- optional `metadata`
- optional `suggested_followups`

### 2. `POST /interview/stream`

Purpose:

- stream interview answers with incremental tokens and metadata

Frontend features that depend on it:

- future live copilot workspace
- transcript-driven answer streaming
- lower-latency workspace interactions

Expected SSE events:

- `start`
- `meta`
- `token`
- `final`
- `error`
- `done`

### 3. `POST /transcribe`

Purpose:

- accept an audio chunk and return transcript text

Frontend features that depend on it:

- future transcript upload enhancement
- future live transcription flow
- meeting or interview capture workflows

Expected request shape:

- binary audio body
- headers:
  - `Content-Type`
  - `X-Chunk-Index`
  - `X-Transcript-Source`
  - `X-Audio-Filename`

Expected response fields:

- `text`
- `chunk_index`
- `source`
- `content_type`
- optional `duration_ms`

## Session-Memory Concepts Identified From Donor Backend

These concepts are explicitly preserved in the frontend contract layer for future compatibility:

- `sessionId`
- recent prompt-answer turns
- `resumeSummary`
- `jobSummary`
- interview intent detection and carry-forward

Current frontend contract types:

- `SessionMemoryTurn`
- `SessionMemoryContext`

These are not yet persisted or connected to a real API.

## Donor Backend Sources Used

- `../final-round-ai/backend/app/api/interview.py`
- `../final-round-ai/backend/app/services/interview_service.py`
- `../final-round-ai/backend/app/services/transcription_service.py`
- `../final-round-ai/backend/app/services/prompt_builder.py`
- `../final-round-ai/backend/app/services/session_store.py`
- `../final-round-ai/backend/app/schemas/interview.py`
- `../final-round-ai/backend/app/schemas/transcription.py`
- `../final-round-ai/backend/app/tests/test_interview_endpoint.py`
- `../final-round-ai/backend/app/tests/test_transcription_endpoint.py`

## Frontend Helper Surface Now Available

From `lib/contracts/interview.ts`:

- endpoint constants for interview routes
- request and response types
- stream event union types
- payload builder for backend-compatible JSON shape

From `lib/contracts/transcription.ts`:

- transcription endpoint constant
- response type
- request header contract and header builder

From `lib/contracts/backend-client.ts`:

- endpoint URL builders using the app API base URL helper
- request-init builders for future integration points

## What Is Still Placeholder By Design

- no actual backend fetch execution
- no backend service inside the Next app
- no session persistence wiring
- no transcription UI integration
- no interview answer UI integration

## Recommended Next Use

The next implementation pass should consume these contracts from route-level frontend features instead of inventing ad hoc request shapes. That keeps the future backend migration bounded and testable.
