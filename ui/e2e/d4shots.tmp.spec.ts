import { expect, test } from '@playwright/test';

const OUT = 'C:/Users/rduga/AppData/Local/Temp/claude/c--Users-rduga-Desktop-VYSTRAL-Windows-App/0bba2ae3-e4f0-413b-946d-dad9624cede0/scratchpad/shots';

test('d4 screenshots', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  await page.goto('/?reduced&reviews&tags&protondb');
  await expect(page.locator('.shell').first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByLabel('Filter library').fill('Circuit Apex');
  await page.getByRole('button', { name: /^Circuit Apex/ }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/hero.png` });
  await page.getByRole('region', { name: 'At a glance' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/glance.png` });
  await page.getByRole('tab', { name: /Versions/ }).click();
  await page.getByTestId('identity-card').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/card.png` });
  await page.getByRole('button', { name: 'Fix match' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/dialog.png` });
});
