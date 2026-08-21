export const tokens = {
  primary: '#2563EB', 'primary-dark': '#1D4ED8', accent: '#60A5FA',
  success: '#16A34A', warning: '#92660A', danger: '#991B1B',
  bg: '#F8FAFC', surface: '#FFFFFF', text: '#0F172A',
  muted: '#64748B', border: '#E2E8F0',
}

export const lpTokens = {
  'lp-paper': '#FFFFFF', 'lp-surface': '#FFFFFF', 'lp-raise': '#F7F7F6',
  'lp-ink': '#18181B', 'lp-ink-soft': '#52525B', 'lp-muted': '#8A8A93',
  'lp-faint': '#B4B4BB', 'lp-line': '#E7E7E9', 'lp-line-2': '#F1F1F2',
  'lp-accent': '#E6396B', 'lp-accent-ink': '#B4234F', 'lp-accent-soft': '#FBE1EA',
  'lp-green': '#1C9C5F', 'lp-green-soft': '#E1F2E8',
  'lp-amber': '#B0730A', 'lp-amber-soft': '#F6ECD6',
  'lp-danger': '#D23B3B', 'lp-danger-soft': '#FBE6E6',
  'lp-usdc': '#2775CA',
}

const preset = {
  theme: {
    extend: {
      colors: { ...tokens, ...lpTokens },
      borderRadius: {
        cta: '12px', card: '14px',
        'lp-card': '20px', 'lp-card-lg': '24px', 'lp-tile': '16px',
        'lp-cta': '15px', 'lp-pill': '9px',
      },
      boxShadow: {
        'lp-cta': '0 8px 20px -8px #E6396B',
        'lp-brand': '0 14px 30px -12px #E6396B',
      },
      fontFamily: {
        geist: ['var(--font-geist)', 'system-ui', 'sans-serif'],
        'geist-mono': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'lp-rise': { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'lp-pulse': { '0%,100%': { opacity: '1', transform: 'scale(1)' }, '50%': { opacity: '.35', transform: 'scale(.82)' } },
        'lp-scan': { '0%': { transform: 'translateY(-38px)' }, '50%': { transform: 'translateY(38px)' }, '100%': { transform: 'translateY(-38px)' } },
      },
      animation: {
        'lp-rise': 'lp-rise .4s ease',
        'lp-pulse': 'lp-pulse 1.6s ease-in-out infinite',
        'lp-scan': 'lp-scan 2.6s ease-in-out infinite',
      },
    },
  },
}
export default preset
