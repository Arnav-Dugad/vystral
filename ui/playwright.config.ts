import { defineConfig, devices } from '@playwright/test';

// UI tests run against the preview backend (fictional sample data) in Chromium, the same
// engine WebView2 uses. Native integration is covered by the .NET test suite.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
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
