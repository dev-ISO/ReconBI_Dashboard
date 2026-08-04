module.exports = {
  presets: [require('../../packages/dashboards-ui/tailwind-preset.cjs')],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/dashboards-ui/src/**/*.{ts,tsx}',
  ],
};
