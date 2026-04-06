"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createEmptyPromptDraft,
  PROMPT_VAULT_CATEGORIES,
  PROMPT_VAULT_STARTERS,
  type PromptCategory,
  type PromptVaultDraft,
  type PromptVaultItem,
  type PromptVisibility,
  validatePromptDraft,
} from "@/lib/prompt-vault";
import {
  createPromptVaultRepository,
  type PromptVaultImportStatus,
  type PromptVaultPersistenceInfo,
} from "@/lib/prompt-vault-persistence";
import { supabase } from "@/lib/supabase";

export function PromptVault() {
  const [draft, setDraft] = useState<PromptVaultDraft>(createEmptyPromptDraft);
  const [savedPrompts, setSavedPrompts] = useState<PromptVaultItem[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [editingPromptId, setEditingPromptId] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [persistenceInfo, setPersistenceInfo] = useState<PromptVaultPersistenceInfo>({
    mode: "local",
    note: "Prompt Vault is loading its current persistence mode.",
    cloudSyncReady: false,
    authState: "signed-out-local",
    userEmail: null,
  });
  const [importStatus, setImportStatus] = useState<PromptVaultImportStatus>({
    available: false,
    localPromptCount: 0,
    cloudPromptCount: 0,
    importableCount: 0,
    note: "Checking whether a local-to-cloud import is needed.",
  });
  const [isImporting, setIsImporting] = useState(false);

  const repository = useMemo(() => createPromptVaultRepository(), []);

  useEffect(() => {
    let isActive = true;

    async function loadPromptVault() {
      try {
        const result = await repository.loadPrompts();
        if (!isActive) return;

        const promptItems = result.prompts;
        setSavedPrompts(promptItems);
        setSelectedPromptId((promptItems[0] ?? PROMPT_VAULT_STARTERS[0])?.id ?? "");
        setPersistenceInfo(result.persistence);
        setImportStatus(result.importStatus);
      } catch (loadError) {
        if (!isActive) return;

        const message =
          loadError instanceof Error ? loadError.message : "Unable to load your prompt vault.";
        setError(message);
        setSavedPrompts([...PROMPT_VAULT_STARTERS]);
      } finally {
        if (isActive) setIsHydrated(true);
      }
    }

    void loadPromptVault();

    return () => {
      isActive = false;
    };
  }, [repository]);

  useEffect(() => {
    if (!supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void repository.loadPrompts().then((result) => {
        setSavedPrompts(result.prompts);
        setSelectedPromptId((result.prompts[0] ?? PROMPT_VAULT_STARTERS[0])?.id ?? "");
        setPersistenceInfo(result.persistence);
        setImportStatus(result.importStatus);
      });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [repository]);

  const selectedPrompt = useMemo(
    () => savedPrompts.find((item) => item.id === selectedPromptId) ?? null,
    [savedPrompts, selectedPromptId]
  );

  function resetForm() {
    setDraft(createEmptyPromptDraft());
    setEditingPromptId("");
  }

  function updateDraft<K extends keyof PromptVaultDraft>(key: K, value: PromptVaultDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleSave() {
    setFeedback("");
    const validationError = validatePromptDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");

    try {
      if (editingPromptId) {
        const result = await repository.updatePrompt({
          id: editingPromptId,
          ...draft,
        });

        setSavedPrompts((current) =>
          current.map((item) => (item.id === editingPromptId ? result.prompt : item))
        );
        setPersistenceInfo(result.persistence);
        setFeedback(
          result.persistence.mode === "supabase-active"
            ? "Prompt updated in your authenticated cloud vault."
            : result.persistence.mode === "supabase-ready"
              ? "Prompt updated locally. Sign in to activate cloud sync."
              : "Prompt updated in your local vault."
        );
        resetForm();
        return;
      }

      const result = await repository.createPrompt(draft);
      setSavedPrompts((current) => [result.prompt, ...current]);
      setSelectedPromptId(result.prompt.id);
      setPersistenceInfo(result.persistence);
      setFeedback(
        result.persistence.mode === "supabase-active"
          ? "Prompt saved to your authenticated cloud vault."
          : result.persistence.mode === "supabase-ready"
            ? "Prompt saved locally. Supabase is ready, but sign-in is still required for cloud sync."
            : "Prompt saved to your local vault."
      );
      resetForm();
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Unable to save your prompt right now.";
      setError(message);
    }
  }

  function handleEdit(item: PromptVaultItem) {
    setEditingPromptId(item.id);
    setDraft({
      title: item.title,
      category: item.category,
      promptText: item.promptText,
      visibility: item.visibility,
      description: item.description,
    });
    setFeedback("");
    setError("");
  }

  async function handleDelete(item: PromptVaultItem) {
    try {
      const result = await repository.deletePrompt(item.id);
      setSavedPrompts((current) => current.filter((entry) => entry.id !== item.id));
      setSelectedPromptId((current) => (current === item.id ? "" : current));
      setPersistenceInfo(result.persistence);
      if (editingPromptId === item.id) {
        resetForm();
      }
      setFeedback(
        result.persistence.mode === "supabase-active"
          ? "Prompt removed from your authenticated cloud vault."
          : "Prompt removed from your local vault."
      );
      setError("");
    } catch (deleteError) {
      const message =
        deleteError instanceof Error ? deleteError.message : "Unable to delete the selected prompt.";
      setError(message);
    }
  }

  async function handleClone(item: PromptVaultItem) {
    try {
      const result = await repository.clonePrompt(item, savedPrompts);
      setSavedPrompts((current) => [result.prompt, ...current]);
      setSelectedPromptId(result.prompt.id);
      setPersistenceInfo(result.persistence);
      setFeedback(
        result.persistence.mode === "supabase-active"
          ? "Prompt cloned into your authenticated cloud vault."
          : result.persistence.mode === "supabase-ready"
            ? "Prompt cloned locally. Sign in to move clones into cloud sync."
            : "Starter prompt cloned into your vault."
      );
      setError("");
    } catch (cloneError) {
      const message =
        cloneError instanceof Error ? cloneError.message : "Unable to clone the selected prompt.";
      setError(message);
    }
  }

  function handleUse(item: PromptVaultItem) {
    setSelectedPromptId(item.id);
    setFeedback(`"${item.title}" is now active for future workspace wiring.`);
    setError("");
  }

  async function handleImportLocalPrompts() {
    setIsImporting(true);
    setError("");
    setFeedback("");

    try {
      const result = await repository.importLocalPromptsToCloud();
      setSavedPrompts(result.prompts);
      setSelectedPromptId((result.prompts[0] ?? PROMPT_VAULT_STARTERS[0])?.id ?? "");
      setPersistenceInfo(result.persistence);
      setImportStatus(result.importStatus);
      setFeedback(
        result.importedCount > 0
          ? `Imported ${result.importedCount} local prompt${result.importedCount === 1 ? "" : "s"} into your cloud vault without overwriting existing cloud data.`
          : "No local prompts needed import. Your cloud vault already contains the current prompt set."
      );
    } catch (importError) {
      const message =
        importError instanceof Error ? importError.message : "Unable to import local prompts right now.";
      setError(message);
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <section className="section-shell pb-16">
      <div className="grid gap-8 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-6">
          <div className="panel p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <span className="pill">Prompt Vault</span>
                <h2 className="mt-4 text-3xl font-semibold text-slate-950">
                  Save, refine, and reuse your best working prompts.
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
                  This first version is local-first by design. It gives Cloud Nexus Pilot a real
                  prompt workflow now, while keeping the persistence layer easy to upgrade to
                  Supabase or backend APIs later.
                </p>
                <p className="mt-3 text-sm leading-7 text-slate-500">{persistenceInfo.note}</p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm">
                  {persistenceInfo.authState === "signed-in-cloud" ? (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 font-medium text-emerald-700">
                      Cloud vault active for {persistenceInfo.userEmail ?? "authenticated user"}
                    </span>
                  ) : (
                    <>
                      <Link
                        href="/auth/login?next=%2Fprompt-library"
                        className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800"
                      >
                        Sign In for Cloud Sync
                      </Link>
                      <Link
                        href="/auth/signup?next=%2Fprompt-library"
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Create Account
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
                {isHydrated
                  ? persistenceInfo.mode === "supabase-active"
                    ? `${savedPrompts.length} prompts in cloud vault`
                    : persistenceInfo.mode === "supabase-ready"
                      ? `${savedPrompts.length} prompts in local vault • ready to sign in`
                      : `${savedPrompts.length} prompts in local vault`
                  : "Loading local vault..."}
              </div>
            </div>

            {feedback ? (
              <p className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {feedback}
              </p>
            ) : null}
            {error ? (
              <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </p>
            ) : null}

            {persistenceInfo.mode === "supabase-active" ? (
              <div className="mt-5 rounded-3xl border border-sky-200 bg-sky-50 p-5 text-sm text-sky-900">
                <p className="font-semibold">Local-to-cloud import</p>
                <p className="mt-2 leading-7">{importStatus.note}</p>
                {importStatus.available ? (
                  <button
                    type="button"
                    onClick={() => void handleImportLocalPrompts()}
                    disabled={isImporting}
                    className="mt-4 rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isImporting
                      ? "Importing..."
                      : `Import ${importStatus.importableCount} Local Prompt${importStatus.importableCount === 1 ? "" : "s"}`}
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="mt-8 grid gap-5">
              <label className="text-sm font-medium text-slate-700">
                Prompt Title
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                  placeholder="e.g. Interview debrief with hiring signal"
                  value={draft.title}
                  onChange={(event) => updateDraft("title", event.target.value)}
                />
              </label>

              <div className="grid gap-5 md:grid-cols-2">
                <label className="text-sm font-medium text-slate-700">
                  Category
                  <select
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    value={draft.category}
                    onChange={(event) =>
                      updateDraft("category", event.target.value as PromptCategory)
                    }
                  >
                    {PROMPT_VAULT_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm font-medium text-slate-700">
                  Visibility
                  <select
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    value={draft.visibility}
                    onChange={(event) =>
                      updateDraft("visibility", event.target.value as PromptVisibility)
                    }
                  >
                    <option value="private">Private</option>
                    <option value="publish_ready">Publish Ready</option>
                  </select>
                </label>
              </div>

              <label className="text-sm font-medium text-slate-700">
                Prompt Text
                <textarea
                  rows={8}
                  className="mt-2 w-full rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm"
                  placeholder="Write the reusable prompt here"
                  value={draft.promptText}
                  onChange={(event) => updateDraft("promptText", event.target.value)}
                />
              </label>

              {draft.visibility === "publish_ready" ? (
                <label className="text-sm font-medium text-slate-700">
                  Short Description
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    placeholder="What this prompt is best used for"
                    maxLength={160}
                    value={draft.description}
                    onChange={(event) => updateDraft("description", event.target.value)}
                  />
                </label>
              ) : null}
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  {editingPromptId ? "Update Prompt" : "Save Prompt"}
                </button>
              {editingPromptId ? (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  Cancel Edit
                </button>
              ) : null}
            </div>
          </div>

          <div className="panel p-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-slate-950">Saved Prompts</h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {persistenceInfo.mode === "supabase-active"
                    ? "Authenticated cloud prompts are shown here. Local-only prompts can be imported safely when available."
                    : "Local-first vault entries live in browser storage for now."}
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {savedPrompts.map((item) => (
                <article
                  key={item.id}
                  className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-950">{item.title}</h3>
                        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                          {item.category}
                        </span>
                        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700">
                          {item.visibility === "publish_ready" ? "Publish Ready" : "Private"}
                        </span>
                      </div>
                      <p className="mt-3 text-sm leading-7 text-slate-600">{item.promptText}</p>
                      {item.description ? (
                        <p className="mt-3 text-sm text-slate-500">Description: {item.description}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => handleUse(item)}
                      className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      Use in Workspace
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(item)}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleClone(item)}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                    >
                      Clone
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(item)}
                      className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="panel p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Active prompt</p>
            <h2 className="mt-3 text-2xl font-semibold text-slate-950">
              {selectedPrompt ? selectedPrompt.title : "Select a prompt"}
            </h2>
            <p className="mt-4 text-sm leading-7 text-slate-600">
              This preview is the handoff point for future workspace actions. Later, this selected
              prompt can feed transcript review, AI summaries, or meeting workflows without
              changing the vault model.
            </p>
            {selectedPrompt ? (
              <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                    {selectedPrompt.category}
                  </span>
                  <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700">
                    {selectedPrompt.visibility === "publish_ready" ? "Publish Ready" : "Private"}
                  </span>
                </div>
                <p className="mt-4 text-sm leading-7 text-slate-700">{selectedPrompt.promptText}</p>
                {selectedPrompt.description ? (
                  <p className="mt-4 text-sm text-slate-500">{selectedPrompt.description}</p>
                ) : null}
              </div>
            ) : (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-500">
                Save or clone a prompt to make it active.
              </div>
            )}
          </div>

          <div className="panel p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Starter library</p>
            <h2 className="mt-3 text-2xl font-semibold text-slate-950">Curated prompts to get moving fast.</h2>
            <div className="mt-6 space-y-4">
              {PROMPT_VAULT_STARTERS.map((item) => (
                <article key={item.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <h3 className="text-lg font-semibold text-slate-950">{item.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600">{item.description}</p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void handleClone(item)}
                      className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      Clone to Vault
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUse(item)}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                    >
                      Preview
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
