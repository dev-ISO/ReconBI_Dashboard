import { defineConfig } from 'vitest/config';

// Standalone vitest config — vitest prefers this file over vite.config.ts,
// which is the LIBRARY build config (react + dts plugins) and has no business
// running for unit tests. Tests live in test/ (outside src/) deliberately:
// the library build's vite-plugin-dts declaration pass covers everything the
// tsconfig includes (src), so a colocated src/*.test.ts would leak a stray
// *.test.d.ts into the published dist.
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Pure-math tests (print geometry/pagination) — no DOM needed.
    environment: 'node',
  },
});
