import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./hooks/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: v("canvas"),
        surface: v("surface"),
        elevated: v("elevated"),
        sunken: v("sunken"),
        sidebar: v("sidebar"),
        bubble: v("bubble"),
        ink: v("ink"),
        muted: v("muted"),
        line: v("line"),
        focus: v("focus"),
        accent: v("accent"),
        accent2: v("accent2"),
        "on-accent": v("on-accent"),
        danger: v("danger"),
        warn: v("warn"),
        ok: v("ok"),
        agg: v("agg"),
        local: v("local"),
        web: v("web"),
        cloud: v("cloud"),
        mcp: v("mcp"),
      },
      fontFamily: {
        display: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
        serif: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        // Neutral, quiet elevation only — no colored glows in the monochrome theme.
        glow: "0 1px 2px rgb(0 0 0 / 0.06), 0 4px 16px -6px rgb(0 0 0 / 0.18)",
        "glow-sm": "0 1px 2px rgb(0 0 0 / 0.05)",
        float: "0 1px 2px rgb(0 0 0 / 0.04), 0 12px 32px -12px rgb(0 0 0 / 0.22)",
        soft: "0 1px 2px rgb(0 0 0 / 0.04)",
        composer: "0 0.25rem 1.25rem rgb(0 0 0 / 0.04), 0 0 0 0.5px rgb(0 0 0 / 0.04)",
      },
      borderRadius: { node: "14px" },
      keyframes: {
        "gradient-pan": { to: { backgroundPosition: "200% center" } },
        shimmer: { "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(100%)" } },
        "pulse-ring": { "0%": { transform: "scale(1)", opacity: "0.5" }, "100%": { transform: "scale(1.8)", opacity: "0" } },
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-4px)" } },
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0" } },
      },
      animation: {
        "gradient-pan": "gradient-pan 6s linear infinite",
        shimmer: "shimmer 1.6s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.2, 0.6, 0.4, 1) infinite",
        float: "float 5s ease-in-out infinite",
        blink: "blink 1s steps(1) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
