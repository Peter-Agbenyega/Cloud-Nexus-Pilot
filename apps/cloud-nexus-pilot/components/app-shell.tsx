"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconMicrophone,
  IconMessages,
  IconFileText,
  IconSearch,
  IconHistory,
  IconSettings,
} from "@tabler/icons-react";

type AppShellProps = {
  children: React.ReactNode;
};

const NAV_MAIN = [
  { label: "Interview Copilot", href: "/workspace", icon: IconMicrophone },
  { label: "Mock Interview", href: "/workspace?demo=true", icon: IconMessages },
  { label: "Resume Studio", href: "/transcripts", icon: IconFileText },
];

const NAV_TOOLS = [
  { label: "Culture Scanner", href: "/prompt-library", icon: IconSearch },
  { label: "Session History", href: "/summary", icon: IconHistory },
];

function NavItem({
  item,
  active,
}: {
  item: (typeof NAV_MAIN)[number];
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: active ? "8px 8px 8px 8px" : "8px 10px",
        borderRadius: 8,
        fontSize: 13,
        color: active ? "#7C6CFF" : "#7070A0",
        background: active ? "rgba(79,70,229,0.12)" : "transparent",
        borderLeft: active ? "2px solid #4F46E5" : "2px solid transparent",
        marginBottom: 2,
        textDecoration: "none",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "rgba(255,255,255,0.04)";
          e.currentTarget.style.color = "#C0C0E0";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "#7070A0";
        }
      }}
    >
      <Icon size={16} stroke={1.5} />
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* === TOP BAR === */}
      <header
        style={{
          height: 48,
          background: "#13131F",
          borderBottom: "0.5px solid rgba(255,255,255,0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          flexShrink: 0,
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "#4F46E5",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            CN
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#F0F0FF" }}>
            Cloud Nexus Pilot
          </span>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 999,
              background: "rgba(79,70,229,0.15)",
              color: "#7C6CFF",
              border: "0.5px solid rgba(124,108,255,0.3)",
            }}
          >
            Free plan
          </span>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "#4F46E5",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            PA
          </span>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1 }}>
        {/* === SIDEBAR === */}
        <aside
          style={{
            width: 200,
            background: "#0F0F1E",
            borderRight: "0.5px solid rgba(255,255,255,0.06)",
            padding: "16px 8px",
            flexShrink: 0,
            overflowY: "auto",
          }}
        >
          {/* MAIN section */}
          <p
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: "#4A4A6A",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              padding: "0 8px",
              marginBottom: 6,
            }}
          >
            Main
          </p>
          {NAV_MAIN.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              active={pathname === item.href || (item.href === "/workspace" && pathname === "/workspace" && !item.href.includes("?"))}
            />
          ))}

          {/* Divider */}
          <div
            style={{
              height: 0.5,
              background: "rgba(255,255,255,0.06)",
              margin: "10px 8px",
            }}
          />

          {/* TOOLS section */}
          <p
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: "#4A4A6A",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              padding: "0 8px",
              marginBottom: 6,
            }}
          >
            Tools
          </p>
          {NAV_TOOLS.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              active={pathname === item.href}
            />
          ))}

          {/* Divider */}
          <div
            style={{
              height: 0.5,
              background: "rgba(255,255,255,0.06)",
              margin: "10px 8px",
            }}
          />

          {/* Settings */}
          <NavItem
            item={{ label: "Settings", href: "/billing", icon: IconSettings }}
            active={pathname === "/billing"}
          />
        </aside>

        {/* === MAIN CONTENT === */}
        <main
          style={{
            flex: 1,
            background: "#0D0D1A",
            padding: 24,
            overflowY: "auto",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
