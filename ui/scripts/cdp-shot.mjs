// Dev helper: screenshots the running VYSTRAL app's WebView2 over CDP.
// Start VYSTRAL with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 first.
import { chromium } from '@playwright/test';
const [, , out = 'shot.png', evalJs] = process.argv;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral')) ?? browser.contexts()[0].pages()[0];
if (evalJs) console.log(JSON.stringify(await page.evaluate(evalJs)));
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log('url', page.url());
await browser.close();
