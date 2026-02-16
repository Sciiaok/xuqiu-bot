/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Attio-inspired dark theme
        background: {
          DEFAULT: '#0A0A0A',
          secondary: '#111111',
          tertiary: '#1A1A1A',
        },
        surface: {
          DEFAULT: '#141414',
          hover: '#1C1C1C',
          active: '#242424',
        },
        border: {
          DEFAULT: '#2A2A2A',
          subtle: '#1F1F1F',
          strong: '#3A3A3A',
        },
        text: {
          primary: '#FFFFFF',
          secondary: '#A1A1A1',
          tertiary: '#6B6B6B',
          muted: '#4A4A4A',
        },
        accent: {
          blue: '#3B82F6',
          purple: '#8B5CF6',
          green: '#22C55E',
          amber: '#F59E0B',
          red: '#EF4444',
        },
        // Semantic colors
        success: '#22C55E',
        warning: '#F59E0B',
        danger: '#EF4444',
        info: '#3B82F6',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      borderRadius: {
        DEFAULT: '8px',
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
    },
  },
  plugins: [],
};
