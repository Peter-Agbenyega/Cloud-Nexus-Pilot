# Cloud Nexus Pilot Migration Plan

## Purpose

This document defines the migration preparation strategy for moving the strongest product features from the legacy donor project at `../final-round-ai` into the monorepo master app at `apps/cloud-nexus-pilot`.

Rules for this migration:

- `apps/cloud-nexus-pilot` is the final master home.
- `../final-round-ai` is a legacy feature donor only.
- Do not copy the legacy app wholesale.
- Prefer extracting well-bounded logic over porting legacy UI state machines directly.
- Preserve independent deployability for the monorepo app and any future backend service.

## Current Monorepo Baseline

`apps/cloud-nexus-pilot` already has:

- stable Next.js + TypeScript + Tailwind foundation
- system-font-safe build flow
- app-router marketing/auth/dashboard/transcript/prompt/pricing pages
- SaaS-grade shell components and content structure
- no backend coupling yet
- no Supabase or billing runtime integration yet

This means the migration should focus on capability import, not layout replacement.

## Legacy Donor Assets Reviewed

Frontend donor:

- `../final-round-ai/web/src/App.tsx`
- `../final-round-ai/web/src/lib/api.ts`
- `../final-round-ai/web/src/lib/supabase.ts`
- `../final-round-ai/web/src/components/PromptVault.tsx`
- `../final-round-ai/web/src/components/LiveTranscriptPanel.tsx`
- `../final-round-ai/docs/supabase/prompt_vault_items.sql`

Backend donor:

- `../final-round-ai/backend/app/api/interview.py`
- `../final-round-ai/backend/app/api/endpoints/transcription.py`
- `../final-round-ai/backend/app/services/interview_service.py`
- `../final-round-ai/backend/app/services/prompt_builder.py`
- `../final-round-ai/backend/app/services/session_store.py`
- `../final-round-ai/backend/app/services/transcription_service.py`
- `../final-round-ai/backend/app/tests/test_interview_endpoint.py`
- `../final-round-ai/backend/app/tests/test_transcription_endpoint.py`
- `../final-round-ai/backend/app/tests/test_session_memory.py`

## Keep As-Is In Monorepo

These parts are already stronger in the monorepo shape than they would be if copied from legacy:

- `apps/cloud-nexus-pilot/app/*` route segmentation for marketing, auth, dashboard, transcripts, summary, pricing
- `apps/cloud-nexus-pilot/components/*` shell and layout primitives
- current Tailwind styling direction and system-font-safe layout
- current monorepo placement and build tooling
- local docs in `apps/cloud-nexus-pilot/docs/*`

Recommendation:

- Keep the current route tree and page boundaries.
- Use the legacy project to enrich behavior inside these routes, not to replace the route structure.

## Import From Legacy Frontend

These donor pieces are strong enough to import mostly as logic or typed feature slices:

### 1. Supabase environment validation and client bootstrap

Source:

- `../final-round-ai/web/src/lib/supabase.ts`

Why import:

- good validation for placeholder env values
- clear diagnostics for broken URL/key setup
- useful auth error normalization

Migration note:

- port this into a new monorepo-friendly helper such as `apps/cloud-nexus-pilot/lib/supabase.ts`
- convert `VITE_*` env usage to `NEXT_PUBLIC_*`
- do not import legacy browser-only assumptions unchanged

### 2. API base URL handling

Source:

- `../final-round-ai/web/src/lib/api.ts`

Why import:

- good local-vs-configured API resolution behavior
- useful production/local fallback logic

Migration note:

- translate to Next-compatible env names and server/client-safe access
- likely destination: `apps/cloud-nexus-pilot/lib/api-base-url.ts`

### 3. Prompt Vault domain model and CRUD behavior

Source:

- `../final-round-ai/web/src/components/PromptVault.tsx`
- `../final-round-ai/docs/supabase/prompt_vault_items.sql`

Why import:

- strongest reusable feature on the frontend side
- includes categories, publish-ready state, descriptions, clone/use flows
- already paired with a Supabase schema and RLS policy example

Migration note:

- import the feature model and behavior, not the old CSS or monolithic wiring
- rebuild UI in Tailwind using monorepo components

### 4. Live transcript interaction patterns

Source:

- `../final-round-ai/web/src/components/LiveTranscriptPanel.tsx`

Why import:

- practical UX around start/stop/clear/use transcript/generate answer
- low-latency transcript operator flow is aligned with Cloud Nexus Pilot

Migration note:

- import the interaction model, not the legacy component styling
- preserve as a feature module under transcripts/workspace, not as global App state

## Translate Into Monorepo-Friendly Code

These donor features are valuable, but they should be translated rather than copied directly:

### 1. Route logic for workspace, billing, auth, and not-found behavior

Legacy source:

- `../final-round-ai/web/src/App.tsx`

Why translate:

- legacy app is a large client-side route state machine
- monorepo app already uses Next app-router pages

Translation target:

- map `/workspace` behavior into `apps/cloud-nexus-pilot/app/dashboard`
- map `/signin` and `/signup` behavior into `app/auth/login` and `app/auth/signup`
- create explicit app-router routes for billing success/cancel and `not-found.tsx`
- preserve user flows, not the manual pathname router

### 2. Dashboard/workspace UI behavior

Legacy source:

- `../final-round-ai/web/src/App.tsx`
- `../final-round-ai/web/src/App.css`

Why translate:

- useful workspace section model exists
- styling and state management are tightly coupled to a single-file Vite app

Translation target:

- feature-specific components under `apps/cloud-nexus-pilot/components`
- route-level state instead of one giant root component
- server/client boundary discipline for Next

### 3. Transcription feature logic

Legacy source:

- `../final-round-ai/web/src/components/LiveTranscriptPanel.tsx`
- `../final-round-ai/backend/app/api/endpoints/transcription.py`
- `../final-round-ai/backend/app/services/transcription_service.py`
- `../final-round-ai/backend/app/tests/test_transcription_endpoint.py`

Why translate:

- frontend and backend pieces are good, but monorepo routing and API strategy differ

Translation target:

- transcript upload/live transcript UI inside `apps/cloud-nexus-pilot/app/transcripts`
- typed frontend request helpers
- backend endpoint contract captured first, then implemented in a dedicated backend service

### 4. Published prompts flow

Legacy source:

- `../final-round-ai/web/src/App.tsx`
- donor backend published prompt support in `../final-round-ai/backend/app/main.py`

Why translate:

- the concept is strong, but legacy implementation is mixed into a monolith

Translation target:

- separate prompt-vault and published-prompt feature modules
- read-only published prompts can land before full prompt publishing workflows

### 5. Session memory and interview prompting

Legacy source:

- `../final-round-ai/backend/app/services/prompt_builder.py`
- `../final-round-ai/backend/app/services/session_store.py`
- `../final-round-ai/backend/app/services/interview_service.py`

Why translate:

- these are strong logic assets
- they should become clean backend domain services, not ad hoc frontend behavior

Translation target:

- preserve the session/context concepts
- rewrite around explicit API contracts and persistence strategy

## Defer For Later

These items should not be first-wave migration work:

- legacy single-file frontend app architecture in `../final-round-ai/web/src/App.tsx`
- Stripe billing implementation details from `../final-round-ai/backend/app/main.py`
- any donor CSS in `../final-round-ai/web/src/App.css`
- built frontend/static serving logic in legacy backend `main.py`
- local fallback AI behavior mixed into legacy backend boot logic
- full prompt publishing marketplace mechanics
- broad resume studio and job match modules unless they become a deliberate Cloud Nexus Pilot scope expansion

Reason:

- these add complexity quickly and would blur the current monorepo product boundary

## Backend Integration Strategy

Recommendation:

- treat the legacy FastAPI backend as a contract donor, not a folder to copy directly
- keep frontend migration and backend migration loosely coupled
- preserve independent deployment for the frontend app and the backend service

Suggested strategy:

1. Extract the backend API surface area first.
   - interview request/response contract
   - streaming interview contract
   - transcription contract
   - prompt vault and published prompt contract

2. Define a monorepo-friendly integration contract.
   - add typed request/response interfaces later under `packages/types`
   - keep implementation details out of the frontend app

3. Create a future dedicated backend home instead of embedding FastAPI inside the Next app.
   - likely future location: `services/cloud-nexus-pilot-api` or a similarly explicit backend folder
   - keep `apps/cloud-nexus-pilot` frontend-only

4. Port backend tests and service logic selectively.
   - start with `interview.py`, `transcription.py`, `prompt_builder.py`, `session_store.py`
   - preserve test coverage from donor backend where contracts are strong

5. Introduce Supabase intentionally.
   - frontend auth/session wiring via translated Supabase helper
   - prompt vault table via `prompt_vault_items.sql`
   - do not mix Stripe, auth admin logic, and prompt vault migration in one pass

## Recommended Migration Order

1. Route and shell hardening for app-router parity
2. Supabase config/client translation
3. Prompt Vault migration
4. API base URL and backend contract layer
5. Transcription workflow migration
6. Interview/session-memory backend integration
7. Billing and workspace entitlements
8. Published prompts refinement

## First 5 Implementation Tasks

1. Add missing Next app-router endpoints for Cloud Nexus Pilot flow completeness.
   - create `app/not-found.tsx`
   - plan billing routes such as `app/billing`, `app/billing/success`, and `app/billing/cancel`
   - keep current dashboard as the workspace anchor

2. Translate donor API base URL and Supabase helpers into monorepo-safe libs.
   - source from `../final-round-ai/web/src/lib/api.ts`
   - source from `../final-round-ai/web/src/lib/supabase.ts`
   - convert env names to `NEXT_PUBLIC_*`

3. Build Prompt Vault as a proper Next feature module inside `apps/cloud-nexus-pilot`.
   - port domain types and CRUD behavior from donor `PromptVault.tsx`
   - recreate UI in Tailwind
   - wire local-only fallback first if needed, then Supabase

4. Define backend contracts before backend code movement.
   - capture interview/transcription request-response types
   - document which endpoints are required from donor backend
   - map them to future frontend fetch helpers

5. Prepare transcription migration in two layers.
   - frontend transcript panel and action flow from donor `LiveTranscriptPanel.tsx`
   - backend transcription contract from donor FastAPI endpoint and tests

## Decision Guardrails

- Do not import legacy `App.tsx` wholesale.
- Do not move the donor backend into the monorepo until contracts are separated from legacy boot code.
- Do not mix billing migration into prompt vault migration.
- Do not let Supabase auth become a prerequisite for every first-wave frontend feature.
- Prefer typed, route-local feature modules over a global client-side state machine.

## Outcome Target

After migration, `apps/cloud-nexus-pilot` should remain the single product home with:

- modern Next app-router UX
- imported donor strengths where they genuinely help
- a clean path to a dedicated backend service
- no dependency on the legacy donor app continuing as a living product
