/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/client/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: "#0B2D6B",
          blue: "#007BFF",
          red: "#FF3B30",
          yellow: "#FFC700",
        },
      },
      fontFamily: {
        sans: ["Nunito", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 10px 30px rgba(11, 45, 107, 0.08)",
      },
    },
  },
  plugins: [],
};
