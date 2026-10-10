import { defineConfig, devices } from '@playwright/test';

// UI tests run against the preview backend (fictional sample data) in Chromium, the same
// engine WebView2 uses. Native integration is covered by the .NET test suite.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // GitHub's runners are several times slower than a desktop PC: give each test and assertion more time there.
  timeout: process.env.GITHUB_ACTIONS ? 180_000 : 45_000, // no GPU there: Immersive's effects render in software
  expect: { timeout: process.env.GITHUB_ACTIONS ? 12_000 : 5_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  fullyParallel: true,
  retries: process.env.GITHUB_ACTIONS ? 2 : process.env.CI ? 1 : 0,
  // GitHub's 4-core Windows runners are overloaded with more than two browsers (CI shards the suite instead).
  workers: process.env.GITHUB_ACTIONS ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5199',
    viewport: { width: 1536, height: 960 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1536, height: 960 } } }],
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
