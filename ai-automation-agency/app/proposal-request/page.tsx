import { ContactForm } from "@/components/contact-form";
import { PageHero } from "@/components/page-hero";

export default function ProposalRequestPage() {
  return (
    <>
      <PageHero
        eyebrow="Proposal Request"
        title="Start a proposal request with enough detail to move fast."
        description="This route is designed for buyers who are past browsing and ready to discuss scope and delivery."
      />
      <section className="section-shell pb-16">
        <ContactForm
          submitLabel="Request proposal"
          context="Business problem, current process, expected ROI, timeline, stakeholders, and procurement needs."
        />
      </section>
    </>
  );
}
