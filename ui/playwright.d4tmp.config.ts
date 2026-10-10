// TEMPORARY (Track D4): same config on a unique port; deleted before committing.
import base from './playwright.config';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://localhost:5357' },
  webServer: { ...(base.webServer as object), command: 'npx vite --port 5357 --strictPort', url: 'http://localhost:5357', reuseExistingServer: false } as never,
});
