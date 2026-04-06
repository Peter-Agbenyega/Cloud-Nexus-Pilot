import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";

export default function SignupPage() {
  return (
    <section className="section-shell flex min-h-[70vh] items-center justify-center py-16">
      <Suspense fallback={<div className="panel w-full max-w-md p-8 text-sm text-slate-600">Loading account setup...</div>}>
        <AuthForm mode="signup" />
      </Suspense>
    </section>
  );
}
