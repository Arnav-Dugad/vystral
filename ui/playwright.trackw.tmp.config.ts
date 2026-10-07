// Temporary (Track W): the base config on a unique port so parallel tracks don't collide. Deleted before commit.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const PORT = 5383;

export default defineConfig({
  ...base,
  outputDir: 'C:/Users/rduga/AppData/Local/Temp/claude/c--Users-rduga-Desktop-VYSTRAL-Windows-App/0bba2ae3-e4f0-413b-946d-dad9624cede0/scratchpad/pw-out',
  reporter: [['list']],
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: { command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 120_000 },
});
