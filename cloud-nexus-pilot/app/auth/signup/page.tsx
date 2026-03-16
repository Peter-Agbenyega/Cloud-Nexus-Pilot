export default function SignupPage() {
  return (
    <section className="section-shell flex min-h-[70vh] items-center justify-center py-16">
      <div className="panel w-full max-w-md p-8">
        <span className="pill">Create account</span>
        <h1 className="mt-6 text-3xl font-semibold text-slate-950">Start your first AI copilot workspace.</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">Swap these inputs for real auth wiring when your provider is selected.</p>
        <div className="mt-8 space-y-4">
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" placeholder="Full name" />
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" placeholder="Work email" />
          <button className="w-full rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">Create workspace</button>
        </div>
      </div>
    </section>
  );
}
