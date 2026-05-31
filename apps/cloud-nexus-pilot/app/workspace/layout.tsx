import { AppShell } from "@/components/app-shell";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Hide global site header/footer when inside workspace */}
      <style>{`[data-site-chrome] { display: none !important; } body > div > .flex.min-h-screen > main.flex-1 { padding: 0 !important; }`}</style>
      <AppShell>{children}</AppShell>
    </>
  );
}
