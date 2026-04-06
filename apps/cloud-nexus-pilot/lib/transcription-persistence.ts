"use client";

import type { User } from "@supabase/supabase-js";

import { supabase, supabaseConfigError } from "@/lib/supabase";
import {
  buildTranscriptSummary,
  createTranscriptRecord,
  updateTranscriptRecord,
  type TranscriptCaptureMode,
  type TranscriptId,
  type TranscriptListResponse,
  type TranscriptRecord,
  type TranscriptResponse,
  type TranscriptSegment,
  type TranscriptSource,
  type TranscriptStatus,
  type TranscriptSummary,
  type UploadTranscriptInput,
  type UploadTranscriptResponse,
} from "@/lib/contracts/transcription";

export const TRANSCRIPT_STORAGE_KEY = "cloudnexus.transcripts.v1";
const TRANSCRIPT_IMPORT_MARKER_PREFIX = "cloudnexus.transcripts.imported";

export type TranscriptionPersistenceInfo = {
  mode: "local" | "supabase-ready" | "supabase-active";
  note: string;
  cloudSyncReady: boolean;
  authState: "signed-out-local" | "supabase-ready" | "signed-in-cloud";
  userEmail: string | null;
};

export type TranscriptionRepositoryResult<T> = T & {
  persistence: TranscriptionPersistenceInfo;
};

export type TranscriptImportStatus = {
  available: boolean;
  localTranscriptCount: number;
  cloudTranscriptCount: number;
  importableCount: number;
  note: string;
  markerApplied: boolean;
};

export type TranscriptLoadResult = TranscriptionRepositoryResult<TranscriptListResponse> & {
  importStatus: TranscriptImportStatus;
};

export type TranscriptImportResult = TranscriptionRepositoryResult<TranscriptListResponse> & {
  importStatus: TranscriptImportStatus;
  importedCount: number;
};

export type TranscriptLookupResponse = {
  transcript: TranscriptRecord | null;
  source: "local" | "remote";
};

export interface TranscriptionRepository {
  listTranscripts(): Promise<TranscriptLoadResult>;
  getTranscriptById(id: TranscriptId): Promise<TranscriptionRepositoryResult<TranscriptLookupResponse>>;
  createTranscript(
    input: UploadTranscriptInput,
    options?: {
      transcriptText?: string;
      segments?: TranscriptRecord["segments"];
      status?: TranscriptStatus;
    }
  ): Promise<TranscriptionRepositoryResult<UploadTranscriptResponse>>;
  updateTranscript(
    id: TranscriptId,
    updates: Parameters<typeof updateTranscriptRecord>[1]
  ): Promise<TranscriptionRepositoryResult<TranscriptResponse>>;
  deleteTranscript(
    id: TranscriptId
  ): Promise<TranscriptionRepositoryResult<{ id: TranscriptId; deleted: true; source: "local" | "remote" }>>;
  importLocalTranscriptsToCloud(): Promise<TranscriptImportResult>;
}

type TranscriptSupabaseRow = {
  id: string;
  user_id: string;
  title: string;
  filename: string;
  status: TranscriptStatus;
  capture_mode: TranscriptCaptureMode;
  source: TranscriptSource | null;
  content_type: string;
  transcript_text: string;
  segments: TranscriptSegment[] | null;
  summary: TranscriptSummary | null;
  byte_size: number;
  duration_ms: number | null;
  storage_key: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

function createLocalPersistenceInfo(note?: string): TranscriptionPersistenceInfo {
  return {
    mode: "local",
    note:
      note ||
      "Transcript persistence is local-first. Cloud sync activates only when Supabase env, auth, and transcript_records table access are ready.",
    cloudSyncReady: false,
    authState: "signed-out-local",
    userEmail: null,
  };
}

function parseStoredTranscripts(rawValue: string | null): TranscriptRecord[] {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as TranscriptRecord[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item === "object")
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

function readStoredTranscripts(): TranscriptRecord[] {
  if (typeof window === "undefined") return [];
  return parseStoredTranscripts(window.localStorage.getItem(TRANSCRIPT_STORAGE_KEY));
}

export function readLocalStoredTranscripts(): TranscriptRecord[] {
  return readStoredTranscripts();
}

export function getLocalStoredTranscriptById(id: TranscriptId): TranscriptRecord | null {
  return readStoredTranscripts().find((item) => item.id === id) ?? null;
}

function writeStoredTranscripts(items: ReadonlyArray<TranscriptRecord>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRANSCRIPT_STORAGE_KEY, JSON.stringify(items));
}

function getTranscriptImportMarkerKey(userId: string): string {
  return `${TRANSCRIPT_IMPORT_MARKER_PREFIX}.${userId}`;
}

function readTranscriptImportMarker(userId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(getTranscriptImportMarkerKey(userId)) === "true";
}

function writeTranscriptImportMarker(userId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getTranscriptImportMarkerKey(userId), "true");
}

function createTranscriptFingerprint(
  transcript: Pick<
    TranscriptRecord,
    "title" | "filename" | "captureMode" | "contentType" | "transcriptText" | "byteSize"
  >
): string {
  return [
    transcript.title.trim().toLowerCase(),
    transcript.filename.trim().toLowerCase(),
    transcript.captureMode,
    transcript.contentType.trim().toLowerCase(),
    transcript.transcriptText.trim().toLowerCase(),
    String(transcript.byteSize),
  ].join("::");
}

function createImportStatus(
  localTranscripts: ReadonlyArray<TranscriptRecord>,
  cloudTranscripts: ReadonlyArray<TranscriptRecord>,
  markerApplied: boolean
): TranscriptImportStatus {
  const localTranscriptCount = localTranscripts.length;
  const cloudTranscriptCount = cloudTranscripts.length;
  const cloudFingerprints = new Set(cloudTranscripts.map(createTranscriptFingerprint));
  const importableCount = localTranscripts.filter(
    (transcript) => !cloudFingerprints.has(createTranscriptFingerprint(transcript))
  ).length;

  if (localTranscriptCount === 0) {
    return {
      available: false,
      localTranscriptCount,
      cloudTranscriptCount,
      importableCount: 0,
      note: "No local transcripts are waiting for cloud import.",
      markerApplied,
    };
  }

  if (importableCount === 0) {
    return {
      available: false,
      localTranscriptCount,
      cloudTranscriptCount,
      importableCount,
      note: markerApplied
        ? "Your local transcript history has already been safely represented in cloud storage."
        : "Your cloud transcript history already contains the current local transcript set.",
      markerApplied,
    };
  }

  if (cloudTranscriptCount === 0) {
    return {
      available: true,
      localTranscriptCount,
      cloudTranscriptCount,
      importableCount,
      note: `You have ${importableCount} local transcript${importableCount === 1 ? "" : "s"} ready for a first safe import into cloud history.`,
      markerApplied,
    };
  }

  return {
    available: true,
    localTranscriptCount,
    cloudTranscriptCount,
    importableCount,
    note: markerApplied
      ? `${importableCount} new local transcript${importableCount === 1 ? "" : "s"} were created after your last import. Import adds only missing transcripts and never overwrites cloud history.`
      : `${importableCount} local transcript${importableCount === 1 ? "" : "s"} are not in cloud history yet. Import is additive only and does not overwrite cloud data.`,
    markerApplied,
  };
}

function toEpoch(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function mapSupabaseRowToTranscript(row: TranscriptSupabaseRow): TranscriptRecord {
  const segments = Array.isArray(row.segments) ? row.segments : [];
  const transcriptText = row.transcript_text ?? "";
  const latestSegment = segments.at(-1)?.text ?? "";
  const summary =
    row.summary && typeof row.summary === "object"
      ? row.summary
      : buildTranscriptSummary(transcriptText, latestSegment);

  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    status: row.status,
    captureMode: row.capture_mode,
    source: row.source,
    contentType: row.content_type,
    transcriptText,
    segments,
    summary,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    storageKey: row.storage_key,
    errorMessage: row.error_message,
    createdAt: toEpoch(row.created_at),
    updatedAt: toEpoch(row.updated_at),
    ownerScope: "authenticated-user",
    ownerId: row.user_id,
    version: 1,
  };
}

function mapTranscriptToSupabaseInsert(
  user: User,
  transcript: TranscriptRecord
): Omit<TranscriptSupabaseRow, "id" | "created_at" | "updated_at"> {
  return {
    user_id: user.id,
    title: transcript.title,
    filename: transcript.filename,
    status: transcript.status,
    capture_mode: transcript.captureMode,
    source: transcript.source,
    content_type: transcript.contentType,
    transcript_text: transcript.transcriptText,
    segments: transcript.segments,
    summary: transcript.summary,
    byte_size: transcript.byteSize,
    duration_ms: transcript.durationMs ?? null,
    storage_key: transcript.storageKey ?? null,
    error_message: transcript.errorMessage ?? null,
  };
}

async function getAuthenticatedSupabaseUser(): Promise<{
  user: User | null;
  persistence: TranscriptionPersistenceInfo;
}> {
  if (!supabase) {
    return {
      user: null,
      persistence: createLocalPersistenceInfo(
        supabaseConfigError ||
          "Supabase is not configured yet. Transcript persistence is staying in dependable local mode."
      ),
    };
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    return {
      user: null,
      persistence: createLocalPersistenceInfo(
        "Supabase auth check failed, so transcript persistence is using local fallback mode."
      ),
    };
  }

  if (!user) {
    return {
      user: null,
      persistence: {
        mode: "supabase-ready",
        note:
          "Supabase is configured, but no authenticated user is active. Transcript persistence stays local until sign-in is complete.",
        cloudSyncReady: true,
        authState: "supabase-ready",
        userEmail: null,
      },
    };
  }

  return {
    user,
    persistence: {
      mode: "supabase-active",
      note:
        "Authenticated cloud transcript mode is active. Transcript records are reading and writing through Supabase.",
      cloudSyncReady: true,
      authState: "signed-in-cloud",
      userEmail: user.email ?? null,
    },
  };
}

async function listSupabaseTranscripts(user: User): Promise<TranscriptRecord[]> {
  const { data, error } = await supabase!
    .from("transcript_records")
    .select(
      "id,user_id,title,filename,status,capture_mode,source,content_type,transcript_text,segments,summary,byte_size,duration_ms,storage_key,error_message,created_at,updated_at"
    )
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(
      `Supabase transcript query failed. Confirm the transcript_records table and RLS policies are applied. ${error.message}`
    );
  }

  return ((data ?? []) as TranscriptSupabaseRow[]).map(mapSupabaseRowToTranscript);
}

async function listCloudTranscriptsWithImportState(user: User): Promise<{
  transcripts: TranscriptRecord[];
  importStatus: TranscriptImportStatus;
}> {
  const transcripts = await listSupabaseTranscripts(user);
  const importStatus = createImportStatus(
    readStoredTranscripts(),
    transcripts,
    readTranscriptImportMarker(user.id)
  );

  return {
    transcripts,
    importStatus,
  };
}

async function getSupabaseTranscriptById(
  user: User,
  id: TranscriptId
): Promise<TranscriptRecord | null> {
  const { data, error } = await supabase!
    .from("transcript_records")
    .select(
      "id,user_id,title,filename,status,capture_mode,source,content_type,transcript_text,segments,summary,byte_size,duration_ms,storage_key,error_message,created_at,updated_at"
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase transcript lookup failed. Confirm the transcript_records table and select policy are applied. ${error.message}`
    );
  }

  return data ? mapSupabaseRowToTranscript(data as TranscriptSupabaseRow) : null;
}

async function createSupabaseTranscript(user: User, transcript: TranscriptRecord) {
  const { data, error } = await supabase!
    .from("transcript_records")
    .insert(mapTranscriptToSupabaseInsert(user, transcript))
    .select(
      "id,user_id,title,filename,status,capture_mode,source,content_type,transcript_text,segments,summary,byte_size,duration_ms,storage_key,error_message,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(
      `Supabase transcript create failed. Confirm the transcript_records table and insert policy exist. ${error?.message ?? ""}`.trim()
    );
  }

  return mapSupabaseRowToTranscript(data as TranscriptSupabaseRow);
}

async function updateSupabaseTranscript(user: User, transcript: TranscriptRecord) {
  const { data, error } = await supabase!
    .from("transcript_records")
    .update({
      title: transcript.title,
      filename: transcript.filename,
      status: transcript.status,
      capture_mode: transcript.captureMode,
      source: transcript.source,
      content_type: transcript.contentType,
      transcript_text: transcript.transcriptText,
      segments: transcript.segments,
      summary: transcript.summary,
      byte_size: transcript.byteSize,
      duration_ms: transcript.durationMs ?? null,
      storage_key: transcript.storageKey ?? null,
      error_message: transcript.errorMessage ?? null,
    })
    .eq("id", transcript.id)
    .eq("user_id", user.id)
    .select(
      "id,user_id,title,filename,status,capture_mode,source,content_type,transcript_text,segments,summary,byte_size,duration_ms,storage_key,error_message,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(
      `Supabase transcript update failed. Confirm the transcript exists for the signed-in user and RLS update policy is active. ${error?.message ?? ""}`.trim()
    );
  }

  return mapSupabaseRowToTranscript(data as TranscriptSupabaseRow);
}

async function deleteSupabaseTranscript(user: User, id: TranscriptId) {
  const { error } = await supabase!
    .from("transcript_records")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    throw new Error(
      `Supabase transcript delete failed. Confirm the transcript exists for the signed-in user and RLS delete policy is active. ${error.message}`
    );
  }
}

const localTranscriptionRepository: TranscriptionRepository = {
  async listTranscripts() {
    const transcripts = readStoredTranscripts();
    return {
      transcripts,
      source: "local",
      persistence: createLocalPersistenceInfo(),
      importStatus: createImportStatus(transcripts, [], false),
    };
  },

  async getTranscriptById(id) {
    const transcript = readStoredTranscripts().find((item) => item.id === id) ?? null;
    return {
      transcript,
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async createTranscript(input, options = {}) {
    const transcript = createTranscriptRecord(
      input,
      options.transcriptText ?? "",
      options.segments ?? [],
      options.status ?? "uploaded"
    );
    const nextItems = [transcript, ...readStoredTranscripts()].sort(
      (left, right) => right.updatedAt - left.updatedAt
    );

    writeStoredTranscripts(nextItems);

    return {
      transcript,
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async updateTranscript(id, updates) {
    const currentItems = readStoredTranscripts();
    const currentTranscript = currentItems.find((item) => item.id === id);

    if (!currentTranscript) {
      throw new Error("Transcript could not be found in local storage.");
    }

    const nextTranscript = updateTranscriptRecord(currentTranscript, updates);
    const nextItems = currentItems
      .map((item) => (item.id === id ? nextTranscript : item))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    writeStoredTranscripts(nextItems);

    return {
      transcript: nextTranscript,
      source: "local",
      persistence: createLocalPersistenceInfo(),
    };
  },

  async deleteTranscript(id) {
    const nextItems = readStoredTranscripts().filter((item) => item.id !== id);
    writeStoredTranscripts(nextItems);

    return {
      id,
      deleted: true as const,
      source: "local" as const,
      persistence: createLocalPersistenceInfo(),
    };
  },

  async importLocalTranscriptsToCloud() {
    const transcripts = readStoredTranscripts();
    return {
      transcripts,
      source: "local",
      persistence: createLocalPersistenceInfo(
        "Local transcript history is ready, but sign-in is still required before cloud import can run."
      ),
      importStatus: createImportStatus(transcripts, [], false),
      importedCount: 0,
    };
  },
};

export function createLocalTranscriptionRepository(): TranscriptionRepository {
  return localTranscriptionRepository;
}

export function createTranscriptionRepository(): TranscriptionRepository {
  async function runWithFallback<T>(
    action: (user: User) => Promise<T>,
    fallback: () => Promise<TranscriptionRepositoryResult<T>>
  ): Promise<TranscriptionRepositoryResult<T>> {
    const { user, persistence } = await getAuthenticatedSupabaseUser();

    if (!user) {
      const result = await fallback();
      return {
        ...result,
        persistence,
      };
    }

    try {
      const result = await action(user);
      return {
        ...result,
        persistence,
      };
    } catch (error) {
      const fallbackResult = await fallback();
      const message =
        error instanceof Error ? error.message : "Supabase transcript sync failed unexpectedly.";

      return {
        ...fallbackResult,
        persistence: createLocalPersistenceInfo(`${message} Falling back to local transcript storage.`),
      };
    }
  }

  return {
    async listTranscripts() {
      return runWithFallback(
        async (user) => {
          const { transcripts, importStatus } = await listCloudTranscriptsWithImportState(user);
          return {
            transcripts,
            source: "remote",
            importStatus,
          };
        },
        () => localTranscriptionRepository.listTranscripts()
      );
    },

    async getTranscriptById(id) {
      return runWithFallback(
        async (user) => {
          const transcript = await getSupabaseTranscriptById(user, id);
          return {
            transcript,
            source: "remote",
          };
        },
        () => localTranscriptionRepository.getTranscriptById(id)
      );
    },

    async createTranscript(input, options = {}) {
      return runWithFallback(
        async (user) => {
          const localTranscript = createTranscriptRecord(
            input,
            options.transcriptText ?? "",
            options.segments ?? [],
            options.status ?? "uploaded"
          );
          const transcript = await createSupabaseTranscript(user, localTranscript);
          return {
            transcript,
            source: "remote",
          };
        },
        () => localTranscriptionRepository.createTranscript(input, options)
      );
    },

    async updateTranscript(id, updates) {
      return runWithFallback(
        async (user) => {
          const existingTranscript = await getSupabaseTranscriptById(user, id);
          if (!existingTranscript) {
            throw new Error("Transcript could not be found in cloud storage.");
          }

          const transcript = await updateSupabaseTranscript(
            user,
            updateTranscriptRecord(existingTranscript, updates)
          );
          return {
            transcript,
            source: "remote",
          };
        },
        () => localTranscriptionRepository.updateTranscript(id, updates)
      );
    },

    async deleteTranscript(id) {
      return runWithFallback(
        async (user) => {
          await deleteSupabaseTranscript(user, id);
          return {
            id,
            deleted: true as const,
            source: "remote" as const,
          };
        },
        () => localTranscriptionRepository.deleteTranscript(id)
      );
    },

    async importLocalTranscriptsToCloud() {
      return runWithFallback(
        async (user) => {
          const localTranscripts = readStoredTranscripts();
          const existingCloudTranscripts = await listSupabaseTranscripts(user);
          const existingFingerprints = new Set(
            existingCloudTranscripts.map(createTranscriptFingerprint)
          );
          const transcriptsToImport = localTranscripts.filter(
            (transcript) => !existingFingerprints.has(createTranscriptFingerprint(transcript))
          );

          let importedCount = 0;
          for (const transcript of transcriptsToImport) {
            await createSupabaseTranscript(user, transcript);
            importedCount += 1;
          }

          writeTranscriptImportMarker(user.id);
          const { transcripts, importStatus } = await listCloudTranscriptsWithImportState(user);

          return {
            transcripts,
            source: "remote",
            importStatus,
            importedCount,
          };
        },
        () => localTranscriptionRepository.importLocalTranscriptsToCloud()
      );
    },
  };
}
