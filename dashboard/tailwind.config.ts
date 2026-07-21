import type { Config } from "tailwindcss";

// Ari's light-only palette. Semantic aliases keep shared components aligned
// while the older card names remain compatible with existing feature views.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Inter"', '"Segoe UI"', "system-ui", "sans-serif"],
        sans: ['"Inter"', '"Segoe UI"', "system-ui", "sans-serif"],
        serif: ['"Inter"', '"Segoe UI"', "system-ui", "sans-serif"],
      },
      colors: {
        "ari-product-canvas": "var(--ari-product-canvas)",
        "ari-nav": "var(--ari-nav)",
        "ari-nav-active": "var(--ari-nav-active)",
        "ari-ink": "var(--ari-ink)",
        "ari-accent": "var(--ari-accent)",
        "ari-accent-strong": "var(--ari-accent-strong)",
        "ari-focus": "var(--ari-focus)",
        "ari-success": "var(--ari-success)",
        "ari-danger": "var(--ari-danger)",
        "ari-lilac": "var(--ari-lilac)",
        "ari-blue": "var(--ari-blue)",
        "ari-lime": "var(--ari-lime)",
        "ari-peach": "var(--ari-peach)",
        "ari-surface": "var(--ari-surface)",
        "ari-canvas": "var(--ari-canvas)",
        "ari-subtle": "var(--ari-surface-subtle)",
        "ari-soft": "var(--ari-accent-soft)",
        "ari-border": "var(--ari-border)",
        "ari-border-strong": "var(--ari-border-strong)",
        "ari-text": "var(--ari-text)",
        "ari-muted": "var(--ari-text-muted)",
        "ari-violet-700": "var(--ari-violet-700)",
        "ari-violet-600": "var(--ari-violet-600)",
        "ari-violet-500": "var(--ari-violet-500)",
        "ari-violet-400": "var(--ari-violet-400)",
        "ari-lavender": "var(--ari-lavender)",
        "ari-midnight": "var(--ari-midnight)",
        page: "var(--ari-canvas)",
        card: "var(--ari-surface)",
        "card-lime": "var(--ari-lime)",
        "card-lemon": "var(--ari-accent)",
        "card-purple": "var(--ari-lilac)",
        "card-teal": "var(--ari-blue)",
        "card-orange": "var(--ari-peach)",
        "card-pink": "var(--ari-lilac)",
        "card-dark": "var(--ari-midnight)",
        "btn-cta": "var(--ari-ink)",
        "txt-muted": "var(--ari-text-muted)",
        "purple-brand": "var(--ari-violet-500)",
      },
      boxShadow: {
        brutal: "4px 4px 0 var(--ari-midnight)",
        "brutal-hover": "2px 2px 0 var(--ari-midnight)",
        "brutal-lg": "6px 6px 0 var(--ari-midnight)",
      },
      borderWidth: {
        brutal: "2px",
      },
    },
  },
  plugins: [],
};
export default config;
