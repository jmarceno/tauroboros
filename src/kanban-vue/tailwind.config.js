/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Base dark theme (modern slate-based)
        dark: {
          bg: '#0f172a',           // slate-900 - main background
          surface: '#1e293b',      // slate-800 - cards, panels
          surface2: '#334155',     // slate-700 - hover states, inputs
          surface3: '#475569',     // slate-600 - borders, dividers
          border: '#475569',       // slate-600
          text: '#f1f5f9',         // slate-100 - primary text
          'text-muted': '#94a3b8',  // slate-400 - secondary text
          'text-dim': '#64748b',    // slate-500 - disabled text
        },
        // Accent colors
        accent: {
          primary: '#6366f1',      // indigo-500 - primary actions
          'primary-hover': '#4f46e5', // indigo-600
          success: '#22c55e',      // green-500
          'success-hover': '#16a34a', // green-600
          warning: '#f59e0b',      // amber-500
          danger: '#ef4444',       // red-500
          info: '#3b82f6',         // blue-500
        },
        // Column header colors (modern glass effect)
        column: {
          template: { 
            bg: 'rgba(99, 102, 241, 0.15)',  // indigo
            text: '#818cf8',                  // indigo-400
            border: '#6366f1'                 // indigo-500
          },
          backlog: { 
            bg: 'rgba(245, 158, 11, 0.15)',  // amber
            text: '#fbbf24',                  // amber-400
            border: '#f59e0b'                 // amber-500
          },
          executing: { 
            bg: 'rgba(34, 197, 94, 0.15)',   // green
            text: '#4ade80',                  // green-400
            border: '#22c55e'                 // green-500
          },
          review: { 
            bg: 'rgba(168, 85, 247, 0.15)',  // purple
            text: '#c084fc',                  // purple-400
            border: '#a855f7'                 // purple-500
          },
          done: { 
            bg: 'rgba(6, 182, 212, 0.15)',   // cyan
            text: '#22d3ee',                  // cyan-400
            border: '#06b6d4'                 // cyan-500
          },
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      animation: {
        'spin': 'spin 0.6s linear infinite',
        'slide-in': 'slideIn 0.2s ease',
        'pulse': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        spin: {
          'to': { transform: 'rotate(360deg)' },
        },
        slideIn: {
          'from': { transform: 'translateX(100%)', opacity: '0' },
          'to': { transform: 'translateX(0)', opacity: '1' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.5' },
        },
      },
    },
  },
  plugins: [],
}
