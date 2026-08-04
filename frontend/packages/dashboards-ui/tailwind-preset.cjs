/**
 * Tailwind preset for @recon/dashboards-ui consumers.
 *
 * Maps rcd-* color tokens onto the CSS custom properties defined in styles.css,
 * so library components use literal class names (`bg-rcd-surface`) that any
 * host's Tailwind build can generate. Dark mode matches the hosts' selector
 * convention: html[data-theme="dark"].
 */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        'rcd-bg': 'var(--rcd-bg)',
        'rcd-surface': 'var(--rcd-surface)',
        'rcd-text': 'var(--rcd-text)',
        'rcd-text-2': 'var(--rcd-text-2)',
        'rcd-muted': 'var(--rcd-muted)',
        'rcd-accent': 'var(--rcd-accent)',
        'rcd-border': 'var(--rcd-border)',
        'rcd-grid-line': 'var(--rcd-grid-line)',
      },
    },
  },
};
