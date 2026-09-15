/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Devanagari text in the header; system fonts cover it if the web font cannot load.
        hindi: ['"Noto Sans Devanagari"', '"Kohinoor Devanagari"', 'Mangal', '"Nirmala UI"', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
