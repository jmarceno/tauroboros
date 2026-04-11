/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Cursor IDE inspired - True dark theme with glass effects
        dark: {
          bg: '#000000',           // Pure black background
          surface: 'rgba(20, 20, 20, 0.6)',   // Glass panels - subtle transparency
          surface2: 'rgba(30, 30, 30, 0.8)',  // Cards with slight transparency
          surface3: 'rgba(50, 50, 50, 0.6)',  // Borders with transparency
          border: 'rgba(60, 60, 60, 0.5)',    // Subtle borders
          text: '#e0e0e0',         // Soft white text
          'text-muted': '#888888',  // Muted gray text
          'text-dim': '#555555',    // Very dim text
        },
        // Subtle accent colors (not overpowering)
        accent: {
          primary: 'rgba(100, 100, 100, 0.5)',    // Gray primary for subtle UI
          'primary-hover': 'rgba(120, 120, 120, 0.6)',
          success: 'rgba(50, 150, 80, 0.7)',     // Muted green
          'success-hover': 'rgba(50, 150, 80, 0.9)',
          warning: 'rgba(200, 150, 50, 0.7)',     // Muted amber
          danger: 'rgba(200, 80, 80, 0.7)',       // Muted red
          info: 'rgba(80, 130, 200, 0.7)',       // Muted blue
        },
        // Column header colors - subtle glass with color tints
        column: {
          template: { 
            bg: 'rgba(80, 80, 120, 0.15)',   // Subtle indigo tint
            text: '#a0a0d0',                  // Soft indigo text
            border: 'rgba(100, 100, 150, 0.4)'
          },
          backlog: { 
            bg: 'rgba(150, 120, 60, 0.15)',  // Subtle amber tint
            text: '#d0b080',                  // Soft amber text
            border: 'rgba(180, 140, 70, 0.4)'
          },
          executing: { 
            bg: 'rgba(60, 150, 80, 0.15)',   // Subtle green tint
            text: '#80d0a0',                  // Soft green text
            border: 'rgba(70, 180, 100, 0.4)'
          },
          review: { 
            bg: 'rgba(140, 80, 140, 0.15)', // Subtle purple tint
            text: '#d080d0',                  // Soft purple text
            border: 'rgba(160, 90, 160, 0.4)'
          },
          done: { 
            bg: 'rgba(60, 140, 160, 0.15)',  // Subtle cyan tint
            text: '#80d0e0',                  // Soft cyan text
            border: 'rgba(70, 160, 180, 0.4)'
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
