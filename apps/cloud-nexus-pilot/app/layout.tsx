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
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
