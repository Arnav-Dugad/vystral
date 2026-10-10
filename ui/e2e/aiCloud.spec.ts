import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track C5: optional cloud AI providers and AI features, against the preview backend's FAKE provider (no AI is
// contacted; fictional data only). ?aiCloud = Claude connected, opted in and chosen; ?aiFail = the provider fails;
// ?aiInvent = the fake model invents numbers; ?ttb = time-to-beat estimates; ?news = Steam news posts.

async function open(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  return { errors, external };
}

const nav = (page: Page, name: RegExp | string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

async function openAiSettings(page: Page) {
  await nav(page, 'Settings');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: /AI providers/ })).toBeVisible();
}

test.describe('cloud AI providers', () => {
  test('off by default; a key is checked, saved masked, opted into after reading what’s sent, tested and disconnected', async ({ page }) => {
    const { errors, external } = await open(page);
    await openAiSettings(page);
    const choice = page.getByRole('radiogroup', { name: 'Which AI powers AI features' });
    await expect(choice.getByRole('radio', { name: /Local AI/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('AI features are using VYSTRAL’s own answers.')).toBeVisible();

    const card = page.getByRole('article', { name: 'ChatGPT' });
    await expect(card.getByText('Not set up')).toBeVisible();
    // A key for another provider is caught; a rejected key isn't saved.
    await card.getByLabel('API key').fill('sk-ant-api03-WRONGPROVIDER0000');
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText(/That looks like a Claude key/)).toBeVisible();
    await card.getByLabel('API key').fill('bad-key-0123456789abcdef');
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText('Key not accepted.')).toBeVisible();

    await card.getByLabel('API key').fill('sk-proj-TESTKEYabcdefghij0123456789wxyz');
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText(/Saved · ends in/)).toBeVisible();
    await expect(card.getByText('…wxyz')).toBeVisible();
    expect(await page.content()).not.toContain('TESTKEYabcdefghij'); // only the last four characters ever reach the page
    await expect(card.getByText('Key saved')).toBeVisible();          // saved, but nothing is sent yet

    // Opting in shows exactly what each feature sends, then makes ChatGPT the active AI.
    await card.getByRole('switch', { name: 'Send data to ChatGPT' }).click();
    const consent = page.getByRole('dialog', { name: 'Send data to ChatGPT?' });
    await expect(consent.getByText(/^Assistant:/)).toBeVisible(); // Track D3: the one Assistant says what it sends
    await expect(consent.getByText(/Play history questions \(Assistant\):/)).toBeVisible();
    await expect(consent.getByText(/File paths, notes, store accounts, other API keys/)).toBeVisible();
    await noSeriousViolations(page, '.dialog');
    await consent.getByRole('button', { name: 'Turn on and use ChatGPT' }).click();
    await expect(choice.getByRole('radio', { name: /ChatGPT/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/AI features use ChatGPT · gpt-5-mini/)).toBeVisible();

    // Models come from the provider's list; Test makes one tiny request.
    await card.getByLabel('Model').selectOption('gpt-5');
    await expect(page.getByText(/AI features use ChatGPT · gpt-5\b/)).toBeVisible();
    await card.getByRole('button', { name: 'Test' }).click();
    await expect(card.getByText(/Working\. gpt-5 answered/)).toBeVisible();
    await noSeriousViolations(page, '#ai-providers');

    // Disconnect needs a hold and removes the key.
    await card.getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect ChatGPT?' });
    const hold = dialog.getByRole('button', { name: 'Disconnect' });
    await page.waitForTimeout(400);
    await hold.focus();
    await page.keyboard.down('Enter');
    await page.waitForTimeout(1150);
    await page.keyboard.up('Enter');
    await expect(dialog).toBeHidden();
    await expect(card.getByText('Not set up')).toBeVisible();
    await expect(choice.getByRole('radio', { name: /Local AI/ })).toHaveAttribute('aria-checked', 'true');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('the OpenAI-compatible endpoint must be https; Offline mode pauses cloud AI; features can be switched off', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await openAiSettings(page);
    const card = page.getByRole('article', { name: 'OpenAI-compatible' });
    await card.getByLabel('Address').fill('http://example.com/v1');
    await expect(card.getByText(/Use an https:\/\/ address/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Save key' })).toBeDisabled();
    await card.getByLabel('Address').fill('https://openrouter.ai/api/v1');
    await card.getByLabel('API key').fill('sk-or-v1-PREVIEWKEY1234567890');
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText('https://openrouter.ai/api/v1/')).toBeVisible();

    await page.getByRole('switch', { name: 'Session recap captions' }).click();
    await expect(page.getByRole('switch', { name: 'Session recap captions' })).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Privacy' }).click();
    await page.getByRole('switch', { name: 'Offline mode' }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI', exact: true }).click();
    await expect(page.getByText('Offline mode is on', { exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Claude/ })).toContainText('Paused offline');
    await expect(page.getByText(/Claude is paused while Offline mode is on/)).toBeVisible();
  });
});

// Track D3: “Ask the Journal” and the Tonight tab are now part of the one Assistant (see assistant.spec.ts).

test.describe('AI features', () => {
  test('smart collection from a sentence: a checked filter with a live preview, saved and kept up to date', async ({ page }) => {
    const { errors } = await open(page, '?aiCloud&ttb&reduced');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New collection' }).click();
    await page.getByRole('button', { name: 'Smart collection…' }).click();
    const dialog = page.getByRole('dialog', { name: 'New smart collection' });
    await dialog.getByLabel('Describe the collection').fill('cosy games under 20 hours I haven’t finished');
    await dialog.getByRole('button', { name: 'Build' }).click();
    await expect(dialog.locator('.ai-smart__chips')).toContainText('Under 20 h to beat');
    await expect(dialog.locator('.ai-smart__chips')).toContainText('Not Beaten or Completed');
    await expect(dialog.getByText('Worded by Claude · Claude Sonnet 5.5')).toBeVisible();
    await noSeriousViolations(page, '.dialog');
    await dialog.getByLabel('Name').fill('Cosy and short');
    await dialog.getByRole('button', { name: 'Save collection' }).click();
    await expect(page.getByRole('heading', { name: 'Cosy and short', level: 1 })).toBeVisible();
    await expect(page.getByText(/Smart collection · /)).toBeVisible();
    const sidebarItem = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Cosy and short/ });
    await expect(sidebarItem).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('smart collection without AI uses VYSTRAL’s own filter words', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New collection' }).click();
    await page.getByRole('button', { name: 'Smart collection…' }).click();
    const dialog = page.getByRole('dialog', { name: 'New smart collection' });
    await dialog.getByLabel('Describe the collection').fill('installed racing games');
    await dialog.getByRole('button', { name: 'Build' }).click();
    await expect(dialog.locator('.ai-smart__chips')).toContainText('Installed');
    await expect(dialog.getByText('Calculated by VYSTRAL on this PC')).toBeVisible();
    await expect(dialog.getByText(/\d+ games? right now/)).toBeVisible();
  });

  test('duplicate suggestions explain themselves: facts always, a sentence with AI', async ({ page }) => {
    await open(page);
    await nav(page, /Library/);
    await page.getByRole('button', { name: /Review 1 possible duplicate/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Possible duplicates' });
    await dialog.getByRole('button', { name: 'Why?' }).click();
    await expect(dialog.locator('.ai-dup__facts li').first()).toBeVisible();
    await expect(dialog.getByText('Calculated by VYSTRAL on this PC')).toBeVisible();
    await noSeriousViolations(page, '.dialog');

    await page.goto('/?aiCloud&reduced');
    await nav(page, /Library/);
    await page.getByRole('button', { name: /Review 1 possible duplicate/ }).click();
    await dialog.getByRole('button', { name: 'Why?' }).click();
    await expect(dialog.locator('.ai-dup__sentence')).toContainText('Kingsfall');
    await expect(dialog.getByText('Worded by Claude · Claude Sonnet 5.5')).toBeVisible();
  });

  test('patch notes condense into three bullets on request, cached per post; without AI the key lines show', async ({ page }) => {
    const { errors, external } = await open(page, '?aiCloud&news&reduced');
    await nav(page, /Library/);
    await page.getByLabel('Filter library').fill('Nebula Drift');
    await page.getByRole('button', { name: /^Nebula Drift/ }).first().click();
    await page.getByRole('tab', { name: 'News' }).click();
    const first = page.locator('.news-item').first();
    await first.getByRole('button', { name: /Summarize in three bullets \(Claude\)/ }).click();
    const summary = first.getByRole('complementary', { name: 'Summary' });
    await expect(summary.locator('li')).toHaveCount(3);
    await expect(summary.getByText('Worded by Claude · Claude Sonnet 5.5')).toBeVisible();
    await noSeriousViolations(page, '.news');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);

    await page.goto('/?news&reduced');
    await nav(page, /Library/);
    await page.getByLabel('Filter library').fill('Nebula Drift');
    await page.getByRole('button', { name: /^Nebula Drift/ }).first().click();
    await page.getByRole('tab', { name: 'News' }).click();
    await page.locator('.news-item').first().getByRole('button', { name: 'Show the key lines' }).click();
    await expect(page.getByRole('complementary', { name: 'Key lines' }).locator('li').first()).toBeVisible();
  });

  test('replay cards get a one-line caption on request (cached per session)', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await nav(page, 'Journal');
    await page.getByRole('button', { name: /^Replay .* session$/ }).first().click();
    const dialog = page.getByRole('dialog', { name: /^Replay · / });
    await dialog.getByRole('button', { name: 'Write a caption' }).click();
    await expect(dialog.locator('.ai-caption__text')).toContainText(/run of .* in /);
    await expect(dialog.getByText('Caption by Claude · Claude Sonnet 5.5')).toBeVisible();
    await noSeriousViolations(page, '.dialog');
  });
});
