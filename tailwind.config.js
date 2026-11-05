/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/src/**/*.{js,ts,jsx,tsx}"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        industrial: {
          950: '#0b0d10',
          900: '#111418',
          850: '#161a20',
          800: '#1b2028',
          750: '#232a35',
          700: '#2c3542',
          600: '#3e4a5c',
          500: '#55657d',
          400: '#7e90a8',
          300: '#a6b5c7',
          200: '#cbd5e1',
          100: '#e2e8f0'
        },
        siemens: {
          cyan: '#00a3a6',
          teal: '#0e7490',
          light: '#22d3ee'
        },
        s7: {
          ob: '#a855f7',
          fb: '#3b82f6',
          fc: '#10b981',
          db: '#f59e0b',
          udt: '#ec4899',
          tag: '#06b6d4'
        }
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
        sans: ['"Segoe UI"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
}
