import { PageHero } from "@/components/page-hero";
import { InterviewReportWorkbench } from "@/components/interview-report-workbench";

export default function SummaryPage() {
  return (
    <>
      <PageHero
        eyebrow="Interview Report"
        title="Post-interview intelligence for saved or pasted transcripts."
        description="Generate a concise debrief with questions, missed concepts, likely follow-ups, and study recommendations."
      />
      <InterviewReportWorkbench />
    </>
  );
}
