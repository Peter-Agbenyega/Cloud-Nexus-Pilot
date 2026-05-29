import { ContactForm } from "@/components/contact-form";
import { PageHero } from "@/components/page-hero";

export default function ContactPage() {
  return (
    <>
      <PageHero eyebrow="Contact" title="Talk through your platform, security, or automation roadmap." description="Use this page to start consulting conversations with engineering leaders, founders, and operations teams." />
      <section className="section-shell grid gap-8 pb-16 lg:grid-cols-[1fr_320px]">
        <ContactForm submitLabel="Send inquiry" context="We need help modernizing CI/CD, security controls, and AWS delivery workflows." />
        <aside className="panel p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Next step</p>
          <h2 className="mt-3 text-2xl font-semibold text-slate-950">We reply with a clear recommended path.</h2>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Use this space for response times, a sales inbox, booking links, or trust signals once the live workflow is chosen.
          </p>
        </aside>
      </section>
    </>
  );
}
