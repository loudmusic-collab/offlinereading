// Rasterise public/icons/icon.svg into the PNG sizes the manifest needs.
// Usage: node scripts/make-icons.mjs  (uses Playwright's Chromium)
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const targets = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0, square: true },
  // Maskable icons need the artwork inside the central 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, pad: 0.12, square: true },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage();
for (const t of targets) {
  const inner = Math.round(t.size * (1 - t.pad * 2));
  const art = t.square ? svg.replace('rx="112"', 'rx="0"') : svg;
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<body style="margin:0;display:grid;place-items:center;width:${t.size}px;height:${t.size}px;background:${t.square ? '#1f3a5f' : 'transparent'}">
       <div style="width:${inner}px;height:${inner}px">${art.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`,
  );
  await page.screenshot({ path: `public/icons/${t.file}`, omitBackground: !t.square });
}
await browser.close();
console.log('icons written');
