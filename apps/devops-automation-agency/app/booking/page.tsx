import { PageHero } from "@/components/page-hero";

export default function BookingPage() {
  return (
    <>
      <PageHero
        eyebrow="Booking"
        title="A scheduling integration will live here."
        description="Wire this route to Calendly, Cal.com, or a custom booking flow once the sales process is finalized."
      />
      <section className="section-shell pb-16">
        <div className="panel p-8 text-sm leading-7 text-slate-600">
          This placeholder is intentionally lightweight so you can add the provider embed or API flow that fits your consulting process.
        </div>
      </section>
    </>
  );
}
