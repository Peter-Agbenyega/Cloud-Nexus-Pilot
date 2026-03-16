import { ContactForm } from "@/components/contact-form";
import { PageHero } from "@/components/page-hero";

export default function LeadFormPage() {
  return (
    <>
      <PageHero
        eyebrow="Lead Form"
        title="Qualify the project before the first call."
        description="Capture enough signal to tailor discovery and accelerate the proposal process."
      />
      <section className="section-shell pb-16">
        <ContactForm
          submitLabel="Submit lead"
          context="Current environment, delivery blockers, compliance needs, budget range, and urgency."
        />
      </section>
    </>
  );
}
