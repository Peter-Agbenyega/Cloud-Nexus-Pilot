type ContactFormProps = {
  submitLabel: string;
  context: string;
};

export function ContactForm({ submitLabel, context }: ContactFormProps) {
  return (
    <form className="panel p-8">
      <div className="grid gap-5 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          Name
          <input className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" placeholder="Your name" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Email
          <input className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" placeholder="you@company.com" />
        </label>
      </div>
      <label className="mt-5 block text-sm font-medium text-slate-700">
        Company
        <input className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" placeholder="Company name" />
      </label>
      <label className="mt-5 block text-sm font-medium text-slate-700">
        Project context
        <textarea
          rows={6}
          defaultValue={context}
          className="mt-2 w-full rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm"
        />
      </label>
      <button
        type="submit"
        className="mt-6 inline-flex rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        {submitLabel}
      </button>
    </form>
  );
}
