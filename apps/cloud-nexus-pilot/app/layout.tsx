import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Cloud Nexus Pilot — Real-Time AI Interview Copilot",
  description:
    "Live answers for interviews and mock interviews, with real-time coaching and international candidate support.",
  openGraph: {
    title: "Cloud Nexus Pilot — Real-Time AI Interview Copilot",
    description:
      "Live answers for interviews and mock interviews, with real-time coaching and international candidate support.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans text-foreground antialiased">
        <div className="relative flex min-h-screen flex-col">
          <SiteHeader />
          {process.env.NEXT_PUBLIC_PILOT_TEST_FIXTURE === "1" ? (
            <aside role="status" className="border-b border-amber-500 bg-amber-50 px-4 py-2 text-sm text-amber-950">
              SYNTHETIC TEST MODE — audio is delivered to a test fixture. Spoken words are not recognized; transcripts and answers are fixed test text. Live speech transcription and question-specific AI answers are not enabled.
            </aside>
          ) : null}
          {process.env.NEXT_PUBLIC_PILOT_LIVE_ACCEPTANCE === "1" ? (
            <aside role="status" className="border-b border-amber-500 bg-amber-50 px-4 py-2 text-sm text-amber-950">
              LIVE PROVIDER TEST — submitted audio and questions are sent to OpenAI and may incur API charges. Sessions use the isolated local test account. Capture starts only when you choose Start Session. Provider readiness still requires a successful test.
            </aside>
          ) : null}
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
