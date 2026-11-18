/** @type {import('tailwindcss').Config} */
// Lumen dark theme: neutral charcoal surfaces with a restrained gold accent.
// Ramps are inverted relative to the old light theme so existing utility
// classes (bg-surface, text-primary-700, bg-accent-100, ...) land correctly
// on the dark scheme without touching component markup.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Base — neutral charcoal
        white: '#1C1C1B', // former white surfaces/text-on-accent -> dark scheme
        background: '#151514',
        surface: '#1C1C1B',
        'surface-2': '#1C1C1B',
        'surface-3': '#232322',
        border: '#2E2E2B',
        'border-2': '#333330',
        'hover-state': '#232322',

        // Primary — Lumen gold (ramp inverted for dark: higher = lighter)
        primary: {
          DEFAULT: '#C9A961',
          50: '#262214',
          100: '#2B2718',
          200: '#403820',
          300: '#5C4F2A',
          400: '#8A743A',
          500: '#C9A961',
          600: '#D8BC79',
          700: '#E5CE96',
          800: '#EFDFB4',
          900: '#F7EFD8',
        },

        // Accent — dark neutral tints (was light sage)
        accent: {
          DEFAULT: '#2B2718',
          50: '#1A1A19',
          100: '#232322',
          200: '#2B2B29',
          300: '#333330',
          400: '#3B3B37',
          500: '#4A4A45',
          600: '#8F8F87',
          700: '#B9B9B1',
          800: '#D3D3CC',
          900: '#EAEAE5',
        },

        // Warning — warm amber
        warning: {
          DEFAULT: '#D3A75F',
          500: '#D3A75F',
          400: '#E0BC7E',
          600: '#B98D45',
        },

        // Danger — soft rose
        danger: {
          DEFAULT: '#DE8B74',
          500: '#DE8B74',
          400: '#E8A794',
          600: '#C9704F',
        },

        // Gold — brand gold
        gold: {
          DEFAULT: '#C9A961',
          500: '#C9A961',
          400: '#D8BC79',
          600: '#B08F45',
        },

        // Info — sage
        info: {
          DEFAULT: '#84A97E',
          500: '#84A97E',
          400: '#9FBF99',
          600: '#69875F',
        },

        // Text
        'text-primary': '#EAEAE5',
        'text-secondary': '#C9C9C1',
        'text-muted': '#9C9C93',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-glow': 'linear-gradient(135deg, #C9A961 0%, #2B2718 100%)',
        'gradient-primary': 'linear-gradient(135deg, #C9A961 0%, #B08F45 100%)',
        'gradient-accent': 'linear-gradient(135deg, #232322 0%, #2A2A28 100%)',
        'gradient-gold': 'linear-gradient(135deg, #D8BC79 0%, #C9A961 100%)',
        'gradient-danger': 'linear-gradient(135deg, #DE8B74 0%, #E8A794 100%)',
        'gradient-surface': 'linear-gradient(180deg, #1C1C1B 0%, #151514 100%)',
        'gradient-card': 'linear-gradient(135deg, rgba(201,169,97,0.04) 0%, rgba(255,255,255,0.02) 100%)',
        'gradient-glass': 'linear-gradient(135deg, rgba(28,28,27,0.95) 0%, rgba(21,21,20,0.98) 100%)',
      },
      boxShadow: {
        'glow-primary': '0 2px 10px rgba(201, 169, 97, 0.18)',
        'glow-accent': '0 2px 8px rgba(201, 169, 97, 0.10)',
        'glow-gold': '0 2px 10px rgba(201, 169, 97, 0.18)',
        'glow-sm': '0 1px 4px rgba(0, 0, 0, 0.3)',
        card: '0 4px 20px rgba(0, 0, 0, 0.35), 0 1px 2px rgba(0, 0, 0, 0.25)',
        'card-hover': '0 10px 30px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.3)',
        glass: '0 4px 20px rgba(0, 0, 0, 0.3)',
        'inner-glow': 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(0,0,0,0.2)',
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
        '3xl': '24px',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease forwards',
        'slide-up': 'slideUp 0.4s ease forwards',
        'slide-in-left': 'slideInLeft 0.3s ease forwards',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
        float: 'float 4s ease-in-out infinite',
        shimmer: 'shimmer 1.5s infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideInLeft: {
          from: { opacity: '0', transform: 'translateX(-16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(201,169,97,0.15)' },
          '50%': { boxShadow: '0 0 40px rgba(201,169,97,0.35)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
}
