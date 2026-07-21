import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Figtree"', '"Plus Jakarta Sans"', "system-ui", "sans-serif"],
        sans: ['"Figtree"', '"Plus Jakarta Sans"', "system-ui", "sans-serif"],
        serif: ['"EB Garamond"', "Georgia", "serif"],
      },
      colors: {
        page: "#F2F5F2",
        card: "#FCFDFF",
        "card-lime": "#DAF464",
        "card-lemon": "#7DFFB3",
        "card-purple": "#818CF8",
        "card-teal": "#4ADBC8",
        "card-orange": "#FD693F",
        "card-pink": "#F2A3D8",
        "card-dark": "#1C221B",
        "btn-cta": "#7DFFB3",
        "txt-muted": "#6C6C6C",
        "purple-brand": "#818CF8",
      },
      boxShadow: {
        brutal: "4px 4px 0 rgb(0, 0, 0)",
        "brutal-hover": "2px 2px 0 rgb(0, 0, 0)",
        "brutal-lg": "6px 6px 0 rgb(0, 0, 0)",
      },
      borderWidth: {
        brutal: "2px",
      },
    },
  },
  plugins: [],
};
export default config;
