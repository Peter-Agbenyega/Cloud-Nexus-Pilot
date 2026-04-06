# Prompt Vault Backend Contract

## Purpose

This document defines the future persistence contract for the Prompt Vault feature in `apps/cloud-nexus-pilot`.

The current Prompt Vault is local-first and already working in the frontend. The contract below is designed so persistence can be added later without rewriting the current UI model.

## Contract Files

- `lib/contracts/prompt-vault.ts`
- `lib/contracts/prompt-vault-client.ts`

## Core Prompt Types

Defined in `lib/contracts/prompt-vault.ts`:

- `Prompt`
- `PromptId`
- `PromptVisibility`
- `PromptCategory`
- `CreatePromptInput`
- `UpdatePromptInput`
- `PromptListResponse`
- `PromptResponse`
- `DeletePromptResponse`
- `ClonePromptResponse`
- `PromptValidationError`
- `PromptApiError`

## Future Endpoints Needed

### 1. `GET /prompts`

Purpose:

- list prompts for the current owner scope

Expected response:

- `PromptListResponse`

Frontend features depending on it:

- prompt vault list
- active prompt preview hydration
- starter or user prompt sync

### 2. `POST /prompts`

Purpose:

- create a new prompt

Expected request:

- `CreatePromptInput`

Expected response:

- `PromptResponse`

### 3. `PATCH /prompts/:id`

Purpose:

- update an existing prompt

Expected request:

- `UpdatePromptInput`

Expected response:

- `PromptResponse`

### 4. `DELETE /prompts/:id`

Purpose:

- remove a prompt owned by the current user scope

Expected response:

- `DeletePromptResponse`

### 5. `POST /prompts/:id/clone`

Purpose:

- clone a starter or existing prompt into the current owner scope

Expected response:

- `ClonePromptResponse`

## Request/Response Mapping To Current Frontend

Current local-first Prompt Vault already uses:

- `title`
- `category`
- `promptText`
- `visibility`
- `description`
- `createdAt`
- `updatedAt`

The contract deliberately preserves those frontend names so the current UI state shape can remain stable.

## Validation/Error Format

Error shape:

- `PromptContractErrorResponse`

Expected error use cases:

- required field missing
- invalid category or visibility
- prompt not found
- prompt ownership mismatch
- backend temporarily unavailable

Validation rules expected in v1:

- `title` is required after trimming
- `promptText` is required after trimming
- `category` must match the current frontend category union
- `visibility` must match the current frontend visibility union
- `description` may be blank, but publish-ready prompts should keep a concise human-readable description

## Storage Ownership Assumptions

Current assumption:

- local-only user scope
- `ownerScope = "local-user"`
- `ownerId = null`

Current implementation status:

- local-first fallback is fully active
- authenticated Supabase CRUD is supported when env vars are valid, the user is signed in, and the `prompt_vault_items` table plus RLS policies exist
- if auth or table access fails, the repository falls back to local storage instead of claiming cloud sync
- when a signed-in user has local-only prompts, the UI offers an additive local-to-cloud import that skips prompts already represented in cloud storage

Future assumption:

- authenticated user scope via Supabase auth
- `ownerScope = "authenticated-user"`
- `ownerId = <supabase user id>`
- the API should return only prompts owned by the current authenticated user unless a later shared-library feature is introduced

Starter prompts:

- may use `ownerScope = "system-starter"`
- can remain cloneable into user-owned prompt space

## Versioning Note

Prompt Vault contract version:

- `version = 1`

Why:

- the frontend data model is already good enough to preserve
- future auth integration should only change ownership and persistence, not the prompt shape itself

## Current Placeholder Status

Still intentionally not implemented:

- live backend fetch execution
- server persistence
- auth-protected ownership enforcement
- shared published prompt service
- optimistic mutation syncing

The current local-first Prompt Vault remains the source of truth until a real backend is added.
