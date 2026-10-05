// Dev helper: evaluates an expression in the running real app (CDP port 9333) and prints the JSON result.
import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
console.log(JSON.stringify(await page.evaluate(process.argv[2]), null, 1));
await browser.close();
