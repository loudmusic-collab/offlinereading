// Run the sync pipeline for one feed in Node — proxy handler → feed parser →
// Readability (via linkedom) → sanitizer — and print what would be stored.
// Handy for checking whether a publisher's pages extract cleanly.
//
// Usage: npm run verify:feed -- [feedUrl] [count]
//   default feed: BBC News, default count: 3
import { DOMParser } from 'linkedom';
import { handleProxy } from '../server/proxy.js';
import { extractArticle } from '../src/lib/extract.js';
import { parseFeed } from '../src/lib/feeds.js';
import { sanitizeHTML } from '../src/lib/sanitize.js';

globalThis.DOMParser = DOMParser;

const feedUrl = process.argv[2] || 'https://feeds.bbci.co.uk/news/rss.xml';
const count = Number(process.argv[3]) || 3;
const allowPrivate = process.env.PROXY_ALLOW_PRIVATE === '1';

async function viaProxy(url) {
  const res = await handleProxy(new Request(`http://local/api/fetch?url=${encodeURIComponent(url)}`), { allowPrivate });
  return { res, finalUrl: res.headers.get('x-final-url') || url };
}

const { res: feedRes } = await viaProxy(feedUrl);
if (!feedRes.ok) {
  console.error(`Feed request failed: HTTP ${feedRes.status} ${await feedRes.text()}`);
  process.exit(1);
}
const feed = parseFeed(await feedRes.text(), feedUrl);
console.log(`Feed: ${feed.title} — ${feed.items.length} items\n`);

let extracted = 0;
for (const item of feed.items.slice(0, count)) {
  console.log(`• ${item.title}`);
  console.log(`  ${item.link}`);
  console.log(`  published ${item.publishDate ? new Date(item.publishDate).toISOString() : 'unknown'} · author: ${item.author || '—'}`);
  const { res, finalUrl } = await viaProxy(item.link);
  let result = { ok: false, reason: `HTTP ${res.status}` };
  if (res.ok) result = extractArticle(await res.text(), finalUrl);
  if (result.ok) {
    extracted++;
    const clean = sanitizeHTML(result.contentHTML, { baseUrl: finalUrl, images: 'collect' });
    console.log(`  ✓ extracted ${clean.text.length} chars, ${clean.images.length} inline image(s); byline: ${result.byline || '—'}`);
    console.log(`    hero: ${result.image || item.imageCandidates[0] || '—'}`);
    console.log(`    "${clean.text.slice(0, 160)}…"`);
  } else {
    console.log(`  ✗ extraction failed (${result.reason}) → RSS summary fallback: "${item.summaryText.slice(0, 120)}"`);
  }
  console.log();
}
console.log(`${extracted}/${Math.min(count, feed.items.length)} articles extracted in full.`);
