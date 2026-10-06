import { chromium, type FullConfig } from '@playwright/test';

/**
 * Loads the app once before any test runs. Vite compiles modules on first request, so without this
 * the first few tests (started in parallel) race a cold dev server and occasionally time out.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5199';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
    await page.goto(`${baseURL}/?reduced`, { timeout: 120_000 });
    await page.locator('.shell, .onb').first().waitFor({ timeout: 120_000 });
    // Visit the lazily loaded routes too, so their chunks are compiled.
    for (const name of ['Library', 'Journal', 'Performance', 'Moments', 'Storage', 'Constellation', 'Assistant', 'Settings']) {
      const button = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${name}`) }).first();
      if (await button.count()) await button.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  } finally {
    await browser.close();
  }
}
