"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  checkSupabaseConnectivity,
  getSupabaseAuthErrorMessage,
  supabase,
  supabaseConfigError,
} from "@/lib/supabase";

type AuthFormMode = "login" | "signup";

type AuthFormProps = {
  mode: AuthFormMode;
};

function resolveSafeReturnPath(rawNext: string | null): string {
  if (!rawNext) return "/prompt-library";
  if (!rawNext.startsWith("/")) return "/prompt-library";
  if (rawNext.startsWith("//")) return "/prompt-library";
  return rawNext;
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnPath = useMemo(
    () => resolveSafeReturnPath(searchParams.get("next")),
    [searchParams]
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (!supabase) return;

    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace(returnPath);
        router.refresh();
      }
    });
  }, [returnPath, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");
    setSuccess("");

    if (!email.trim()) {
      setError("Email is required.");
      return;
    }

    if (!password.trim()) {
      setError("Password is required.");
      return;
    }

    if (!supabase) {
      setError(supabaseConfigError || "Supabase auth is not configured yet.");
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (signInError) {
          const baseMessage = getSupabaseAuthErrorMessage(signInError, "signin");
          if (/could not reach Supabase/i.test(baseMessage)) {
            const connectivity = await checkSupabaseConnectivity();
            if (!connectivity.reachable) {
              setError(`${baseMessage}\n\nConnectivity check: ${connectivity.error}`);
              return;
            }
          }
          setError(baseMessage);
          return;
        }

        router.replace(returnPath);
        router.refresh();
        return;
      }

      const origin =
        typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
      const emailRedirectTo = `${origin}${returnPath}`;
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo,
        },
      });

      if (signUpError) {
        const baseMessage = getSupabaseAuthErrorMessage(signUpError, "signup");
        if (/could not reach Supabase/i.test(baseMessage)) {
          const connectivity = await checkSupabaseConnectivity();
          if (!connectivity.reachable) {
            setError(`${baseMessage}\n\nConnectivity check: ${connectivity.error}`);
            return;
          }
        }
        setError(baseMessage);
        return;
      }

      if (data.session) {
        router.replace(returnPath);
        router.refresh();
        return;
      }

      setSuccess(
        "Check your email to confirm your account. After confirmation, return to Prompt Vault to activate cloud sync and import local prompts."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="panel w-full max-w-md p-8">
      <span className="pill">{mode === "login" ? "Welcome back" : "Create account"}</span>
      <h1 className="mt-6 text-3xl font-semibold text-slate-950">
        {mode === "login" ? "Sign in to your workspace." : "Start your AI copilot workspace."}
      </h1>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        {mode === "login"
          ? "Sign in to enable cloud sync for Prompt Vault and complete any local-to-cloud import."
          : "Create your account to enable authenticated Prompt Vault sync while keeping local mode as a fallback."}
      </p>
      <p className="mt-3 text-sm text-slate-500">
        Return path: <span className="font-medium text-slate-700">{returnPath}</span>
      </p>

      {supabaseConfigError ? (
        <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {supabaseConfigError}
        </p>
      ) : null}
      {error ? (
        <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}
        </p>
      ) : null}

      <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
        <label className="block text-sm font-medium text-slate-700">
          Email
          <input
            className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
            placeholder="you@company.com"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Password
          <input
            className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
            placeholder={mode === "login" ? "Enter your password" : "Create a secure password"}
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button
          className="w-full rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting
            ? mode === "login"
              ? "Signing in..."
              : "Creating account..."
            : mode === "login"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>

      <div className="mt-6 text-sm text-slate-600">
        {mode === "login" ? (
          <p>
            Need an account?{" "}
            <Link
              href={`/auth/signup?next=${encodeURIComponent(returnPath)}`}
              className="font-semibold text-slate-950 underline-offset-4 hover:underline"
            >
              Create one
            </Link>
          </p>
        ) : (
          <p>
            Already have an account?{" "}
            <Link
              href={`/auth/login?next=${encodeURIComponent(returnPath)}`}
              className="font-semibold text-slate-950 underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
