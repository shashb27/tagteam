import { defineConfig } from '@playwright/test';

// Real-opencode E2E config — runs the same two-browser flow against a
// live opencode provider (no MOCK_CLAUDE). Separate port (3998) so it
// never clashes with the default mock server (3999).
//
// Run with: npm run test:e2e:real
// Gated: not part of the default `npm run test:e2e` (which stays mock).

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false, // two-browser tests share one server
  workers: 1,
  timeout: 180_000, // real model latency: generous global cap
  expect: { timeout: 30_000 },
  use: { baseURL: 'http://localhost:0' }, // overridden per test
  webServer: {
    command: 'PORT=3998 node server/index.js',
    port: 3998,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
