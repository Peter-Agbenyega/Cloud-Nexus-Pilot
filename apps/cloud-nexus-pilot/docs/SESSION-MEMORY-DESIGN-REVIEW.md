# Cloud Nexus Pilot Session Memory Design Review

## Purpose

This document prepares M16: the wider backend and session-memory promotion review for `apps/cloud-nexus-pilot`.

It does not implement backend or session-memory runtime behavior. Its job is to define the safest architecture direction now that two feature lanes are mature:

- Prompt Vault
- Transcription

## Current Baseline

Cloud Nexus Pilot already has two strong frontend-to-provider lanes:

### Prompt Vault

- typed prompt domain model
- local-first persistence
- authenticated Supabase CRUD
- auth-aware local / ready / cloud mode UX
- safe local-to-cloud import

### Transcription

- typed transcript domain model
- local-first persistence
- authenticated Supabase CRUD
- auth-aware local / ready / cloud mode UX
- safe local-to-cloud import

This is enough maturity to define session-memory architecture without guessing.

## What Session Memory Means In Cloud Nexus Pilot

Session memory is the working context that binds a single active copilot flow together.

In Cloud Nexus Pilot, session memory should mean:

- the active objective for the current interaction
- the current working transcript or excerpt set
- the active prompt selection and prompt parameters
- recent turns between user and copilot
- lightweight derived notes that improve continuity
- references to durable source records rather than duplicated full records when possible

Session memory should not be the same thing as long-term storage.

The distinction should be:

- durable records live in Prompt Vault and Transcript storage
- session memory composes those records into a short-lived working context
- long-lived user knowledge should only be promoted intentionally

## What Should Be Stored Per User vs Per Session

### Per User

Store durable assets that should survive across multiple sessions:

- Prompt Vault items
- transcript records
- transcript summaries once real summarization exists
- reusable preferences such as preferred consultation style or interview mode defaults
- resume profile data and role-target preferences when that feature lands

These belong to authenticated ownership and should remain independently queryable.

### Per Session

Store only the active working set needed for the current copilot flow:

- `sessionId`
- current mode such as consultation, interview, notes, or resume-writing
- selected prompt ids and any temporary prompt overrides
- selected transcript ids and selected transcript excerpts
- recent turn history
- pending goals, open questions, and temporary working notes
- UI-safe metadata such as current source route or active workspace pane

Per-session memory should be bounded and replaceable. It should not become a second permanent database of everything the user has ever done.

## How Prompt Vault And Transcription Should Connect

Prompt Vault and Transcription should connect through references and composition, not through direct feature coupling.

Recommended model:

1. Prompt Vault remains the source of truth for reusable prompt assets.
2. Transcription remains the source of truth for recorded transcript artifacts.
3. Session memory stores links to:
   - one or more selected prompt ids
   - one or more selected transcript ids
   - optional extracted transcript snippets
4. An orchestration layer builds a session context packet from those linked records.
5. Interview or consultation endpoints consume that packet.

This avoids:

- copying prompt bodies into multiple places unnecessarily
- bloating transcript tables with AI interaction state
- making either feature depend directly on the other feature’s storage implementation

## Recommended Architecture Direction

### Core Direction

Use a three-layer model:

1. Durable asset layer
   - prompts
   - transcripts
   - future user profile assets

2. Session context layer
   - active mode
   - selected assets
   - recent turns
   - transient notes
   - orchestration metadata

3. Execution layer
   - interview generation
   - consultation workflows
   - note generation
   - resume-writing assistance

### Why This Direction

It keeps the product flexible across multiple modes without forcing one giant table or one giant backend service contract too early.

## Recommended Mode Support

### Consultation Mode

Session memory should prioritize:

- current business or cloud problem statement
- chosen expert prompt
- selected transcript excerpts
- recent recommendations and follow-up questions

### Interview Mode

Session memory should prioritize:

- role target
- job description summary
- resume profile reference
- recent Q&A turns
- active interview prompt template
- transcript segments tied to the current answer window

### Note Taking

Session memory should prioritize:

- active transcript id
- rolling summary state
- decisions, risks, owners, and action items
- lightweight note blocks that can be promoted to durable notes later

### ATS-Friendly Resume Writing

Session memory should prioritize:

- target role
- job description input
- current resume version reference
- selected prompts for rewrite style
- draft sections and recent edits

### Future Live Meeting / Tab-Share Transcription

Session memory should prioritize:

- live transcript stream reference
- rolling segment window
- active meeting goal
- note-taking or consultation prompt
- bounded recent context rather than the full raw transcript on every request

## Contracts Needed Before Implementation

The following contract families should exist before wider session-memory implementation starts.

### 1. Session Context Contract

Needed types:

- `SessionId`
- `SessionMode`
- `SessionContext`
- `SessionContextReference`
- `SessionTurn`
- `SessionNote`
- `SessionHydrationResponse`
- `SessionMutationResponse`

Purpose:

- define how the frontend reads and writes active working context

### 2. Prompt Attachment Contract

Needed shapes:

- selected prompt ids
- resolved prompt content snapshot metadata
- optional per-session prompt overrides

Purpose:

- let a session reference a prompt without mutating the durable prompt record

### 3. Transcript Attachment Contract

Needed shapes:

- selected transcript ids
- excerpt references
- segment range references
- optional imported summary references

Purpose:

- allow downstream AI workflows to consume only the necessary transcript scope

### 4. Session Execution Contract

Needed endpoints:

- create or resume session
- update session context
- append session turn
- request non-streaming response
- request streaming response

Purpose:

- separate context management from model execution

### 5. Promotion Contract

Needed shapes:

- convert session notes into durable assets later
- optionally save a generated prompt or summary artifact

Purpose:

- avoid mixing transient session output with durable user records by default

## Suggested Backend Shape

Recommended backend shape for first implementation:

- keep Prompt Vault and Transcript persistence as asset services
- add a separate session service or session module
- let interview / generation services consume hydrated session context

Suggested backend entity boundaries:

- `prompt_vault_items`
- `transcript_records`
- `session_contexts`
- `session_turns`
- optional future `session_notes`

Keep session writes lightweight and frequent. Keep durable asset writes explicit.

## What Should Remain Deferred

Do not implement these in the first session-memory pass:

- semantic memory or embeddings
- cross-session auto-learning
- large-scale analytics over session turns
- automatic prompt mutation from session usage
- automatic transcript summarization pipelines
- shared team workspaces
- collaborative live sessions
- billing-aware usage metering inside session logic

These are all attractive, but they expand surface area before the core model is proven.

## Risks If Implemented Too Early

### 1. Asset / Session Boundary Collapse

If prompts, transcripts, and session state are mixed together too early, the product becomes hard to reason about and harder to migrate later.

### 2. Unbounded Context Growth

If every transcript segment and every turn is always appended to active context, model requests become expensive, slow, and noisy.

### 3. False Coupling Between Features

If Prompt Vault or Transcription becomes responsible for session orchestration directly, those features stop being reusable foundations.

### 4. Premature Backend Lock-In

If backend implementation starts before the session contract is stable, frontend work will be forced to adapt around backend shortcuts.

### 5. Ownership Ambiguity

Without clear user-owned assets and session-owned state, auth and future sharing rules become much harder to enforce correctly.

## Recommended Implementation Order After This Review

1. Define the session context contract types and endpoint contracts in the frontend-safe contract layer.
2. Add a passive session client helper layer similar to Prompt Vault and Transcription contracts.
3. Introduce a session workspace shell in the frontend that can hold selected prompt and transcript references.
4. Only then promote donor backend session-store concepts into a dedicated backend service.
5. Add interview or consultation execution on top of hydrated session context.

## Decision Summary

Recommended decision for M16:

- keep Prompt Vault and Transcription as durable asset lanes
- introduce session memory as a separate orchestration layer
- connect assets into sessions by reference, not duplication
- define contracts before moving backend code
- defer advanced memory, analytics, and autonomous behaviors until the first session model is stable

This is the safest path to grow Cloud Nexus Pilot into consultation, interview, note-taking, resume-writing, and future live meeting copilot workflows without breaking the strong foundation already in place.
