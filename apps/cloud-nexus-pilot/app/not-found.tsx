import Link from "next/link";

export default function NotFound() {
  return (
    <section className="section-shell flex min-h-[70vh] items-center justify-center py-16">
      <div className="panel w-full max-w-3xl p-10 text-center">
        <span className="pill">404 · Route not found</span>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-slate-950 lg:text-5xl">
          This Cloud Nexus Pilot page does not exist.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-slate-600">
          The route may have changed during product hardening, or the link may be incomplete.
          Use one of the primary paths below to get back into the product.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link
            href="/"
            className="rounded-full bg-slate-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Back to Home
          </Link>
          <Link
            href="/workspace"
            className="rounded-full border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
          >
            Open Workspace
          </Link>
        </div>
      </div>
    </section>
  );
}
