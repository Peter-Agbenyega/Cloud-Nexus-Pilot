/* ============================================================
   Cloud Nexus Pilot — Design System Constants v2.0
   JS-accessible theme values for programmatic use (inline styles,
   canvas rendering, dynamic calculations).
   For component styling, prefer Tailwind classes referencing CSS vars.
   ============================================================ */

export type ThemeMode = "dark" | "light" | "cosmos";

export type AnswerColorMode = "aurora" | "ocean" | "neon" | "parchment" | "minimal";

export const THEME_STORAGE_KEY = "cloudnexus.theme-mode";
export const ANSWER_MODE_STORAGE_KEY = "cloudnexus.answer-color-mode";

/** Brand colors — constant across all themes */
export const brand = {
  primary: "#4F46E5",
  primaryHover: "#4338CA",
  accent: "#06B6D4",
  accentMuted: "#0891B2",
  success: "#10B981",
  warning: "#F59E0B",
  error: "#EF4444",
} as const;

/** Per-theme background/text palettes */
export const themes: Record<ThemeMode, {
  bgBase: string;
  bgSurface: string;
  bgElevated: string;
  bgSubtle: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;
}> = {
  dark: {
    bgBase: "#0D0D1A",
    bgSurface: "#13131F",
    bgElevated: "#1C1C2E",
    bgSubtle: "#252535",
    border: "#2E2E45",
    textPrimary: "#F0F0FF",
    textSecondary: "#A0A0C0",
    textDisabled: "#505070",
  },
  light: {
    bgBase: "#F8F8FC",
    bgSurface: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgSubtle: "#F1F1F8",
    border: "#E2E2EE",
    textPrimary: "#0D0D1A",
    textSecondary: "#5A5A7A",
    textDisabled: "#AAAABF",
  },
  cosmos: {
    bgBase: "#050510",
    bgSurface: "#0A0A1F",
    bgElevated: "#10103A",
    bgSubtle: "#16164A",
    border: "#1E1E5A",
    textPrimary: "#E8E8FF",
    textSecondary: "#8888CC",
    textDisabled: "#3A3A70",
  },
};

/** Answer color mode display metadata */
export const answerColorModes: Record<AnswerColorMode, {
  label: string;
  className: string;
}> = {
  aurora: { label: "Aurora", className: "answer-mode-aurora" },
  ocean: { label: "Ocean", className: "answer-mode-ocean" },
  neon: { label: "Neon", className: "answer-mode-neon" },
  parchment: { label: "Parchment", className: "answer-mode-parchment" },
  minimal: { label: "Minimal", className: "answer-mode-minimal" },
};

/** Design tokens for programmatic access */
export const tokens = {
  radius: {
    sm: "8px",
    md: "12px",
    lg: "16px",
    xl: "20px",
    full: "999px",
  },
  shadow: {
    soft: "0 20px 80px rgba(0, 0, 0, 0.28)",
    glow: "0 0 20px rgba(79, 70, 229, 0.15)",
    glowAccent: "0 0 20px rgba(6, 182, 212, 0.15)",
  },
} as const;
