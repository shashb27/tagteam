import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js'],
      // server/index.js is the HTTP + WebSocket entry point — it's covered by
      // the Playwright E2E suite (the merge gate), not unit tests. Excluding it
      // from the unit coverage gate matches the QA persona's "E2E is the merge
      // gate, not unit" + "don't gate on UI coverage" philosophy.
      exclude: ['server/index.js'],
      thresholds: { lines: 80 },
    },
  },
});
