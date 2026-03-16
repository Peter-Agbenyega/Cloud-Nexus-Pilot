export default function LoginPage() {
  return (
    <section className="section-shell flex min-h-[70vh] items-center justify-center py-16">
      <div className="panel w-full max-w-md p-8">
        <span className="pill">Welcome back</span>
        <h1 className="mt-6 text-3xl font-semibold text-slate-950">Sign in to your workspace.</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">Connect your real auth provider later. This page is ready for UI integration.</p>
        <div className="mt-8 space-y-4">
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" placeholder="Email" />
          <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" placeholder="Password" type="password" />
          <button className="w-full rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">Sign in</button>
        </div>
      </div>
    </section>
  );
}
