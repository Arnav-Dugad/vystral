// Dev helper: drives the installed app's updater over CDP (port 9333): waits for "Update x", downloads, then restarts.
import { chromium } from '@playwright/test';
const step = process.argv[2] ?? 'wait';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const pill = page.locator('.update-pill');
if (step === 'wait') {
  await pill.waitFor({ timeout: 300_000 });
  console.log('pill:', await pill.textContent());
} else if (step === 'download') {
  await pill.click();
  await page.waitForTimeout(800);
  const dl = page.getByRole('button', { name: /^Download/ });
  if (await dl.count()) await dl.first().click();
  await page.locator('.update-pill', { hasText: 'Restart to update' }).waitFor({ timeout: 600_000 });
  console.log('ready:', await pill.textContent());
} else if (step === 'restart') {
  await pill.click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Restart/ }).last().click();
  console.log('restart clicked');
}
await browser.close().catch(() => {});
