import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./features/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Semantic background layers */
        background: "rgb(var(--color-bg-base) / <alpha-value>)",
        surface: "rgb(var(--color-bg-surface) / <alpha-value>)",
        elevated: "rgb(var(--color-bg-elevated) / <alpha-value>)",
        subtle: "rgb(var(--color-bg-subtle) / <alpha-value>)",

        /* Border */
        border: "rgb(var(--color-border) / <alpha-value>)",

        /* Text */
        foreground: "rgb(var(--color-text-primary) / <alpha-value>)",
        "text-secondary": "rgb(var(--color-text-secondary) / <alpha-value>)",
        "text-disabled": "rgb(var(--color-text-disabled) / <alpha-value>)",

        /* Brand */
        primary: "rgb(var(--color-primary) / <alpha-value>)",
        "primary-hover": "rgb(var(--color-primary-hover) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        "accent-muted": "rgb(var(--color-accent-muted) / <alpha-value>)",

        /* Status */
        success: "rgb(var(--color-success) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        error: "rgb(var(--color-error) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "Fira Code", "Courier New", "monospace"],
      },
      borderRadius: {
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "20px",
      },
      boxShadow: {
        soft: "0 20px 80px rgba(0, 0, 0, 0.28)",
        glow: "0 0 20px rgba(79, 70, 229, 0.15)",
        "glow-accent": "0 0 20px rgba(6, 182, 212, 0.15)",
      },
      backgroundImage: {
        grid: "linear-gradient(to right, rgb(var(--color-border) / 0.12) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--color-border) / 0.12) 1px, transparent 1px)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 12px rgba(6, 182, 212, 0.3)" },
          "50%": { boxShadow: "0 0 24px rgba(6, 182, 212, 0.6)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
