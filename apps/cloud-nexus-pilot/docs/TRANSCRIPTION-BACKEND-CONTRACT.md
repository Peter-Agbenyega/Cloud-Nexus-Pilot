# Transcription Backend Contract

## Purpose

This document defines the future persistence and processing contract for the transcription workflow in `apps/cloud-nexus-pilot`.

The current frontend is intentionally local-first. It already supports live capture controls, upload flow shape, transcript preview, and segment review. The contract below keeps that behavior stable so a real backend can be added later without rewriting the UI.

## Contract Files

- `lib/contracts/transcription.ts`
- `lib/contracts/transcription-client.ts`

## Core Types

Defined in `lib/contracts/transcription.ts`:

- `TranscriptId`
- `TranscriptStatus`
- `TranscriptRecord`
- `TranscriptSegment`
- `TranscriptSummary`
- `UploadTranscriptInput`
- `UploadTranscriptResponse`
- `TranscriptListResponse`
- `TranscriptResponse`
- `TranscriptProcessingResponse`
- `TranscriptValidationError`
- `TranscriptApiError`

## Status Lifecycle

The backend-facing transcript lifecycle for v1 is:

- `uploaded`
- `processing`
- `completed`
- `failed`

How the current frontend maps to that lifecycle:

- local file selection or local chunk intake maps to `uploaded`
- mock processing / active live chunk handling maps to `processing`
- transcript preview ready maps to `completed`
- capture or processing failure maps to `failed`

## Future Endpoints Needed

### 1. `POST /transcribe`

Purpose:

- process a live audio chunk from microphone or shared-tab capture

Expected request:

- binary audio body
- request headers from `TranscriptionRequestHeaders`

Expected response:

- `TranscriptionResponse`
- optionally wrapped into `TranscriptProcessingResponse` at a higher orchestration layer

Frontend features depending on it:

- live chunk capture
- segment timeline
- latest segment preview

### 2. `POST /transcripts`

Purpose:

- create a transcript record for uploaded files or staged transcription jobs

Expected request:

- `UploadTranscriptInput`
- future versions may use multipart upload or signed storage URLs

Expected response:

- `UploadTranscriptResponse`

Frontend features depending on it:

- upload intake
- transcript workspace metadata
- recent transcript history

### 3. `GET /transcripts`

Purpose:

- list transcript records owned by the current user scope

Expected response:

- `TranscriptListResponse`

Frontend features depending on it:

- transcript history
- workspace hydration

### 4. `GET /transcripts/:id`

Purpose:

- retrieve a single transcript with text, segments, and summary

Expected response:

- `TranscriptResponse`

Frontend features depending on it:

- transcript review page state
- follow-on AI summary workflows

### 5. `GET /transcripts/:id/status`

Purpose:

- poll transcript processing state for uploads or longer async jobs

Expected response:

- `TranscriptProcessingResponse`

Frontend features depending on it:

- upload progress
- async transcription completion

## Request / Response Shapes

### `UploadTranscriptInput`

Captures the current frontend intake model:

- filename
- content type
- byte size
- capture mode: `live-capture` or `file-upload`
- optional source for live audio
- optional storage key for future object storage handoff
- optional chunk index for chunk-oriented flows

### `TranscriptRecord`

Represents the persisted transcript entity used by the frontend:

- transcript identity and title
- source and capture mode
- transcript status
- transcript text
- transcript segments
- transcript summary
- file metadata
- ownership metadata
- timestamps
- version number

## Validation Rules

The backend should enforce at minimum:

- `filename` is required and trimmed
- `contentType` is required and must be an allowed transcript or audio type
- `byteSize` must be greater than zero
- `source` must match the known transcript source union when present
- `chunkIndex` must be zero or greater when present
- transcript binary payloads must respect backend size limits

## Error Model

Use `TranscriptApiError` for structured API failures.

Expected error cases:

- invalid or missing upload metadata
- unsupported file type or content type
- oversized audio chunk or file
- transcript not found
- transcript ownership mismatch
- backend transcription service unavailable

## Ownership And Storage Assumptions

Current v1 assumption:

- local-first browser workflow
- `ownerScope = "local-user"`
- `ownerId = null`

Current implementation status:

- local-first fallback is fully active
- authenticated Supabase transcript CRUD is supported when env vars are valid, the user is signed in, and the `transcript_records` table plus RLS policies exist
- transcript onboarding now supports additive local-to-cloud import with a per-user browser marker so first authenticated import can complete without destructive overwrite
- if auth or table access fails, the repository falls back to local transcript storage instead of claiming cloud sync

Future persistent assumption:

- transcript metadata stored in the backend
- large files or raw audio stored in object storage
- transcript records linked to an authenticated user

Future auth note:

- `ownerScope` should transition to authenticated ownership using Supabase auth user ids without changing the frontend transcript record shape

Future file boundary note:

- live chunks may remain direct binary uploads to `/transcribe`
- larger uploaded files may move to signed storage upload plus job orchestration

## Mapping From Current Frontend To Future Persistence

The current frontend already models the right workflow seams:

- live capture creates chunk-like transcript segments
- file upload creates a staged transcript workspace
- transcript preview and timeline map naturally to `TranscriptRecord` and `TranscriptSegment`
- transcript summary cards map to `TranscriptSummary`

That means the current UI can keep its structure while backend persistence replaces the local/mock processing seam.

## Current Placeholder Status

Still intentionally not implemented:

- real backend fetch execution
- signed object storage uploads
- async processing jobs
