// End-to-end check in real Chromium:
//   1. build the app, serve it with `vite preview` (+ the /api/fetch proxy)
//   2. point it at a local fixture feed, sync, check extraction + fallbacks
//   3. shut down EVERY server and put the browser offline
//   4. reload: the app shell must come from the service worker, stories and
//      images from IndexedDB, with zero failed network requests
//
// Usage: npm run build && npm run e2e   (SCREENSHOTS=dir to save screenshots)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';

const APP_PORT = 4173;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? '✓' : '✗'} ${message}`);
  if (!cond) failures++;
}

async function startPreview() {
  const proc = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'], {
    env: { ...process.env, PROXY_ALLOW_PRIVATE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => /127\.0\.0\.1:\d+/.test(String(d)) && resolve());
    proc.on('exit', (code) => reject(new Error(`vite preview exited (${code})`)));
  });
  return () => process.kill(-proc.pid);
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

const fixture = await startFixtureServer(4599);
const stopPreview = await startPreview();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (err) => {
  console.log('  page error:', err.message);
  failures++;
});

try {
  // ---------- Online: install, configure one feed, sync ----------
  await page.goto(APP);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 });
  check(true, 'service worker installed and controlling the page');

  await page.click('a[href="#/settings"]');
  await page.waitForSelector('.feed', { state: 'attached' });
  check((await page.locator('.quota').count()) === 9, 'settings: stories-per-category controls for 9 categories');
  // Default feeds sit in collapsed category groups, so click via the DOM.
  while (await page.locator('.remove-feed').count()) {
    const before = await page.locator('.remove-feed').count();
    await page.evaluate(() => document.querySelector('.remove-feed').click());
    await page.waitForFunction((n) => document.querySelectorAll('.remove-feed').length < n, before);
  }
  await page.fill('input[name=name]', 'Fixture News');
  await page.fill('input[name=url]', `${fixture.origin}/feed.xml`);
  await page.click('.add-feed button[type=submit]');
  await page.waitForSelector('.feed', { state: 'attached' });
  check((await page.locator('.feed').count()) === 1, 'settings: one feed configured');

  await page.click('a[aria-label="Back to stories"]');
  await page.waitForSelector('.sync-btn');

  const labels = new Set();
  const poll = setInterval(async () => {
    const t = await page.locator('.sync-label').textContent().catch(() => '');
    if (t) labels.add(t);
  }, 30);
  await page.click('.sync-btn');
  await page.waitForFunction(() => document.querySelectorAll('.story').length > 0 && !document.querySelector('.sync-btn').disabled, null, {
    timeout: 60000,
  });
  clearInterval(poll);
  console.log('  progress labels seen:', [...labels].join(' | '));
  check([...labels].some((l) => /Downloading \d+ of 4/.test(l)), 'progress shows "Downloading N of 4…"');

  // "Full articles only" is on by default: the 403 and bot-wall stories are skipped.
  check((await page.locator('.story').count()) === 2, 'full articles only (default): 2 stories kept');
  check((await page.locator('.story .badge').count()) === 0, 'full articles only: no summary-only stories');
  check(/2 skipped \(no full text\)/.test(await page.locator('#toast').textContent()), 'sync summary reports 2 skipped');

  // Turn it off and sync again: the skipped stories now come in as summaries.
  await page.click('a[href="#/settings"]');
  await page.waitForFunction(() => document.querySelector('.full-only')?.checked === true);
  await page.click('.full-only');
  await page.waitForFunction(() => document.querySelector('.full-only').checked === false);
  await page.click('a[aria-label="Back to stories"]');
  await page.waitForSelector('.story');
  await page.click('.sync-btn');
  await page.waitForFunction(() => document.querySelectorAll('.story').length === 4 && !document.querySelector('.sync-btn').disabled, null, {
    timeout: 60000,
  });

  const titles = await page.locator('.story-title').allTextContents();
  check(titles.length === 4, `4 stories stored (7-day-old item skipped) — got ${titles.length}`);
  check((await page.locator('.story .badge').count()) === 2, 'blocked (403) and bot-wall stories marked "Summary"');
  check((await page.locator('.story.unread').count()) === 4, 'all stories start unread');
  check((await page.locator('img.thumb').count()) >= 2, 'thumbnails render from stored blobs');
  await shot(page, '1-list-online');

  await page.locator('.story a', { hasText: 'spring tides' }).click();
  await page.waitForSelector('.reader .content p');
  const paragraphs = await page.locator('.content p').count();
  check(paragraphs >= 8, `Readability extracted the full article (${paragraphs} paragraphs)`);
  check((await page.locator('.notice').count()) === 0, 'no summary notice on a fully extracted story');
  check(!(await page.locator('.content').innerHTML()).includes('We use cookies'), 'page chrome stripped');
  await page.waitForFunction(() => [...document.querySelectorAll('.reader img')].every((i) => i.complete && i.naturalWidth > 0));
  const imgSrcs = await page.$$eval('.reader img', (imgs) => imgs.map((i) => i.src));
  check(imgSrcs.length === 2 && imgSrcs.every((s) => s.startsWith('blob:')), `hero + inline image render from IndexedDB blobs (${imgSrcs.length} images)`);
  if (imgSrcs.length !== 2) {
    console.log(
      '  stored:',
      await page.evaluate(async () => {
        const db = await new Promise((r) => (indexedDB.open('offline-news-reader').onsuccess = (e) => r(e.target.result)));
        const all = await new Promise((r) => (db.transaction('articles').objectStore('articles').getAll().onsuccess = (e) => r(e.target.result)));
        const a = all.find((x) => x.title.includes('tides'));
        return JSON.stringify({ html: a.articleHTML.slice(0, 2000), inline: a.inlineImages.map((b) => b && b.size), hero: a.heroImageBlob?.size });
      }),
    );
  }
  await shot(page, '2-article-online');

  await page.goBack();
  await page.locator('.story a', { hasText: 'rate decision' }).click();
  await page.waitForSelector('.reader .notice');
  check(/the site blocked the download \(HTTP 403\)/.test(await page.locator('.notice').textContent()), 'blocked site: notice explains why');
  check((await page.locator('.content').textContent()).includes('Shares rose sharply'), 'blocked site: RSS summary shown instead');
  await shot(page, '3-article-fallback');

  await page.goto(`${APP}#/settings`);
  await page.waitForFunction(() => /\d/.test(document.querySelector('.stats')?.textContent || ''));
  const stats = await page.locator('.stats').textContent();
  check(/Stories\s*4/.test(stats), `settings shows storage in use (${stats.replace(/\s+/g, ' ').trim()})`);
  await shot(page, '4-settings');

  // ---------- Second feed (Atom), synced with pull-to-refresh ----------
  await page.fill('input[name=name]', 'Atom Wire');
  await page.fill('input[name=url]', `${fixture.origin}/atom.xml`);
  await page.selectOption('select[name=category]', 'tech');
  await page.click('.add-feed button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.feed').length === 2);
  await page.click('a[aria-label="Back to stories"]');
  await page.waitForSelector('.story');
  await page.evaluate(() => window.scrollTo(0, 0));

  const cdp = await context.newCDPSession(page);
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 200, y }] });
  await touch('touchStart', 160);
  for (let y = 160; y <= 420; y += 20) await touch('touchMove', y);
  check((await page.locator('.ptr-label').textContent()) === 'Release to sync', 'pull-to-refresh: indicator says "Release to sync"');
  await touch('touchEnd');
  await page.waitForFunction(() => document.querySelector('.sync-btn').disabled, null, { timeout: 5000 });
  check(true, 'pull-to-refresh started a sync');
  await page.waitForFunction(() => document.querySelectorAll('.story').length === 6 && !document.querySelector('.sync-btn').disabled, null, {
    timeout: 60000,
  });
  check(true, 'second feed (Atom) synced: 6 stories');
  const chips = await page.locator('.chip[data-source]').allTextContents();
  check(chips.length === 2, `source filter chips: ${chips.join(', ')}`);
  await page.click('.chip[data-source="Atom Wire"]');
  check((await page.locator('.story').count()) === 2, 'filtering by source works');
  await page.click('.chip[data-source="Atom Wire"]');

  // Category tabs
  const tabs = await page.locator('.cat-tab').allTextContents();
  check(tabs[0].startsWith('All') && tabs.some((t) => t.startsWith('Tech')), `category tabs: ${tabs.map((t) => t.replace(/\d+$/, '')).join(', ')}`);
  await page.click('.cat-tab[data-cat="tech"]');
  check((await page.locator('.story').count()) === 2, 'Tech tab shows only the Tech feed’s 2 stories');
  await page.click('.cat-tab[data-cat="top"]');
  check((await page.locator('.story').count()) === 4, 'Top tab shows the 4 Top stories');
  await page.click('.cat-tab[data-cat="all"]');
  check((await page.locator('.story-cat').count()) === 6, 'All tab labels each story with its category');
  await shot(page, '4b-list-two-feeds');

  // ---------- Lower the cap: read stories are pruned first ----------
  await page.goto(`${APP}#/settings`);
  await page.waitForFunction(() => document.querySelector('.quota[data-cat="top"]')?.value === '10');
  await shot(page, '4c-settings-categories');
  await page.fill('.quota[data-cat="top"]', '3');
  await page.locator('.quota[data-cat="top"]').dispatchEvent('change');
  await page.waitForFunction(() => /Stories\s*5/.test(document.querySelector('.stats').textContent));
  await page.goto(APP);
  await page.waitForFunction(() => document.querySelectorAll('.story').length === 5);
  const remaining = await page.locator('.story-title').allTextContents();
  check(
    !remaining.some((t) => t.includes('rate decision')) && remaining.some((t) => t.includes('spring tides')),
    'Top limited to 3: the oldest read Top story was pruned first',
  );

  // ---------- Airplane mode ----------
  await page.goto(APP);
  await page.waitForSelector('.story');
  const hitsBefore = fixture.hits.length;
  stopPreview();
  await fixture.close();
  await context.setOffline(true);
  console.log('  servers stopped, browser offline');

  const requests = [];
  const failed = [];
  page.on('requestfinished', async (req) => {
    const res = await req.response();
    requests.push({ url: req.url(), sw: res?.fromServiceWorker() });
  });
  page.on('requestfailed', (req) => failed.push(`${req.url()} (${req.failure()?.errorText})`));

  await page.reload();
  await page.waitForSelector('.story', { timeout: 10000 });
  check((await page.locator('.story').count()) === 5, 'offline reload: app shell + 5 stories load');
  check(await page.locator('.offline-banner').isVisible(), 'offline banner visible');
  check(await page.locator('.sync-btn').isDisabled(), 'sync disabled while offline');
  check((await page.locator('.story.read').count()) === 1, 'read status persisted (opened story still marked read)');
  await shot(page, '5-list-offline');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '5b-list-offline-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.locator('.story a', { hasText: 'Night trains' }).click();
  await page.waitForSelector('.reader .content p');
  await page.waitForFunction(() => [...document.querySelectorAll('.reader img')].every((i) => i.complete && i.naturalWidth > 0));
  check((await page.locator('.reader img').count()) === 2, 'offline article: lazy-loaded inline image + hero render');
  await shot(page, '6-article-offline');

  // A brand-new tab, opened while offline, must also boot from the SW.
  const fresh = await context.newPage();
  await fresh.goto(`${APP}#/settings`);
  await fresh.waitForSelector('.feed', { state: 'attached' });
  check(true, 'new tab opened offline boots from the service worker');
  await fresh.close();

  await page.goBack();
  await page.waitForSelector('.story');

  const network = requests.filter((r) => /^https?:/.test(r.url) && !r.sw);
  check(network.length === 0, `no request went past the service worker (${network.map((r) => r.url).join(', ') || 'none'})`);
  check(failed.length === 0, `no failed requests while offline (${failed.join(', ') || 'none'})`);
  check(fixture.hits.length === hitsBefore, 'fixture site never contacted after going offline');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
  try {
    stopPreview();
  } catch {}
  await fixture.close().catch(() => {});
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll offline checks passed');
process.exit(failures ? 1 : 0);
