# Session Context Contract

## Purpose

This document defines the frontend-safe contract layer for future session context in `apps/cloud-nexus-pilot`.

It sits above Prompt Vault and Transcription without changing either feature's current local-first or provider-aware behavior.

## Contract Files

- `lib/contracts/session-context.ts`
- `lib/contracts/session-context-client.ts`

## What This Layer Does

The session context layer defines how the frontend can describe a working copilot session without implementing backend runtime yet.

It provides:

- typed session identity and mode models
- reference-only links to prompts and transcripts
- request and response shapes for future session endpoints
- passive endpoint and `RequestInit` helpers

It does not provide:

- live backend fetch execution
- session storage runtime
- interview orchestration
- semantic memory

## Core Types

Defined in `lib/contracts/session-context.ts`:

- `SessionContextId`
- `SessionMode`
- `SessionContextStatus`
- `SessionContextRecord`
- `SessionAttachmentRef`
- `SessionPromptRef`
- `SessionTranscriptRef`
- `CreateSessionContextInput`
- `UpdateSessionContextInput`
- `SessionContextResponse`
- `SessionContextListResponse`
- `SessionContextValidationError`
- `SessionContextApiError`

## Reference-Only Linking Model

Session context connects to other mature lanes by reference only.

### Prompt references

Session context stores:

- `promptId`
- prompt title/category/visibility snapshot metadata
- whether a session-only override exists

It does not mutate Prompt Vault records.

### Transcript references

Session context stores:

- `transcriptId`
- transcript title/status snapshot metadata
- optional excerpt text
- optional excerpt segment ids

It does not duplicate the full transcript record by default.

## Future Endpoints

The contract reserves these endpoints for future implementation:

- `GET /sessions`
- `POST /sessions`
- `GET /sessions/:id`
- `PATCH /sessions/:id`

These are intentionally limited to context hydration and context mutation.

Execution endpoints such as interview generation or streaming should remain separate.

## Ownership Model

Current contract assumption:

- local-safe shape
- no runtime persistence yet
- `ownerScope = "local-user"`
- `ownerId = null`

Future persistent assumption:

- authenticated user ownership through Supabase or backend auth
- session context records remain distinct from prompt and transcript storage

## Why This Contract Is Safe

This layer preserves the architecture direction already proven by Prompt Vault and Transcription:

- asset lanes stay durable and independent
- session context stays orchestration-focused
- local fallback patterns in existing features do not need to change
- backend implementation can arrive later without reshaping current frontend models

## Intentionally Deferred

- session persistence repository
- session provider adapter
- session execution runtime
- turn streaming
- note promotion flows
- summary generation

This contract exists only to make the next implementation milestone bounded and predictable.
