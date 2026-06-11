// Screenshot tool for visual verification against the dev server.
// Usage: node screenshot.mjs <url> [label]
//   node screenshot.mjs http://localhost:4321/data
//   node screenshot.mjs http://localhost:4321/data after-pie-redesign
// Saves to ./temporary screenshots/screenshot-N[-label].png (auto-incremented).

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url   = process.argv[2];
const label = process.argv[3];

if (!url) {
  console.error('Usage: node screenshot.mjs <url> [label]');
  process.exit(1);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const dir  = path.join(root, 'temporary screenshots');
fs.mkdirSync(dir, { recursive: true });

// Next free index — existing screenshots are never overwritten
const taken = fs.readdirSync(dir)
  .map(f => f.match(/^screenshot-(\d+)/))
  .filter(Boolean)
  .map(m => Number(m[1]));
const n = (taken.length ? Math.max(...taken) : 0) + 1;
const file = path.join(dir, `screenshot-${n}${label ? `-${label}` : ''}.png`);

const browser = await puppeteer.launch();
try {
  const page = await browser.newPage();
  // 2x scale so typography and hairlines are inspectable
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  // Let D3 entrance animations (~650ms) settle before capturing
  await new Promise(r => setTimeout(r, 1200));
  // The Astro dev toolbar would bake into the capture — remove it
  await page.evaluate(() => document.querySelector('astro-dev-toolbar')?.remove());
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
} finally {
  await browser.close();
}
