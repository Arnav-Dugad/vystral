import { chromium } from '@playwright/test';
const out = process.argv[2];
const base = 'http://localhost:5311/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1536, height: 960 } });
const shot = async (name, url, fn) => {
  await p.goto(base + url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  if (fn) await fn();
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${out}/${name}.png` });
};
await shot('home-friends', '?friends&diskTight');
await shot('library-cloud', '?cloud#/library');
await shot('health', '?health#/health');
await shot('settings-cloud', '?cloud#/settings/cloud');
await b.close();
