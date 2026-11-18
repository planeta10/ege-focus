/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] },
      colors: { stone: { 50: '#fafaf9', 100: '#f5f5f4', 800: '#292524', 900: '#1c1917' } }
    },
  },
  plugins: [],
}
