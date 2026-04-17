/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Prototype 6 - Cyberpunk Neon Theme (without gradients)
        dark: {
          bg: '#0c0c14',           // Deep dark background
          surface: '#151520',      // Slightly lighter panels
          surface2: '#1e1e2d',     // Cards, secondary surfaces
          surface3: '#252536',     // Hover states
          border: '#2a2a3e',       // Subtle borders
          'border-hover': '#3a3a52', // Hover borders
          text: '#f0f0f5',         // Primary text
          'text-secondary': '#a0a0b0', // Secondary text
          'text-muted': '#6a6a80',    // Muted text
          input: '#0a0a12',        // Input backgrounds
        },
        // Neon Accent Colors (high contrast)
        accent: {
          primary: '#00d4ff',      // Cyan primary
          secondary: '#ff00a0',  // Magenta secondary
          success: '#00ff88',      // Neon green
          warning: '#ffcc00',      // Yellow
          danger: '#ff3366',     // Red
          info: '#4488ff',       // Blue
        },
        // Column-specific colors
        column: {
          template: '#b388ff',   // Purple
          backlog: '#ffab40',    // Orange
          executing: '#69f0ae',  // Green
          review: '#ff4081',     // Pink
          'code-style': '#ffd740', // Amber/Yellow
          codestyle: '#8b5cf6',  // Violet/Purple
          done: '#18ffff',       // Cyan
        },
        // Legacy aliases for backward compatibility
        'accent-success': '#00ff88',
        'accent-danger': '#ff3366',
        'accent-warning': '#ffcc00',
        'dark-text': '#f0f0f5',
        'dark-text-muted': '#a0a0b0',
        'dark-dim': '#6a6a80',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Noto Sans', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      animation: {
        'spin': 'spin 0.6s linear infinite',
        'slide-in': 'slideIn 0.3s ease',
        'slide-out': 'slideOut 0.3s ease',
        'pulse': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blink': 'blink 1s infinite',
      },
      keyframes: {
        spin: {
          'to': { transform: 'rotate(360deg)' },
        },
        slideIn: {
          'from': { right: '-500px' },
          'to': { right: '0' },
        },
        slideOut: {
          'from': { right: '0' },
          'to': { right: '-500px' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.5' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
    },
  },
  plugins: [],
}
