import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Hide global site header/footer when inside workspace */}
      <style>{`[data-site-chrome] { display: none !important; } body > div > .flex.min-h-screen > main.flex-1 { padding: 0 !important; }`}</style>
      <Suspense fallback={<p role="status">Loading workspace…</p>}>
        <AppShell>{children}</AppShell>
      </Suspense>
    </>
  );
}
