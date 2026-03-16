import { ContactForm } from "@/components/contact-form";
import { PageHero } from "@/components/page-hero";

export default function IntakePage() {
  return (
    <>
      <PageHero
        eyebrow="Intake"
        title="Collect the operational context before you scope the build."
        description="Use this form page to gather systems involved, human review requirements, and automation goals."
      />
      <section className="section-shell pb-16">
        <ContactForm
          submitLabel="Submit intake"
          context="Key workflows, systems to integrate, team members involved, failure risks, and desired outcomes."
        />
      </section>
    </>
  );
}
