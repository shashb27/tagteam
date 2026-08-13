import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false, // two-browser tests share one server
  workers: 1,
  // Default (mock) run excludes the @real spec — that one only runs via
  // `npm run test:e2e:real` (playwright.config.real.js, port 3998).
  grepInvert: /@real/,
  use: { baseURL: 'http://localhost:0' }, // overridden per test
  webServer: {
    command: 'MOCK_CLAUDE=1 PORT=3999 node server/index.js',
    port: 3999,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
