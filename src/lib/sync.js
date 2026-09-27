import {
  CATEGORIES,
  DEFAULT_CATEGORY,
  HERO_MAX_DIM,
  INLINE_MAX_DIM,
  MAX_AGE_MS,
  MAX_INLINE_IMAGES,
  THUMB_MAX_DIM,
  categoryOf,
} from './config.js';
import { getAllArticles, getMeta, getSettings, putArticle, setMeta } from './db.js';
import { extractArticle } from './extract.js';
import { parseFeed } from './feeds.js';
import { downloadImage, resizeImage } from './images.js';
import { HttpError, OfflineError, ProxyUnreachableError, fetchViaProxy, isOnline } from './net.js';
import { pruneStories } from './prune.js';
import { sanitizeHTML } from './sanitize.js';

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Pick which stories to keep. Per category (in tab order), round-robin across
 * that category's feeds, newest first, up to the category's quota, so one
 * prolific feed can't crowd the others out. A story listed in several feeds
 * is counted once, in the first category that picks it. Stories already
 * stored fill their category's slots but aren't returned.
 * @param {Array<{ feed, items }>} feedResults
 * @param {Map<string, string>} existing  stored story id → its category
 * @param {Record<string, number>} quotas
 */
export function selectStories(feedResults, existing, quotas, now = Date.now(), excludedIds = new Set()) {
  const seen = new Set();
  const picked = [];
  for (const { id: category } of CATEGORIES) {
    const quota = Number(quotas[category]) || 0;
    const queues = feedResults
      .filter(({ feed }) => (feed.category || DEFAULT_CATEGORY) === category)
      .map(({ feed, items }) =>
        items
          .filter((it) => !excludedIds.has(it.id) && (!it.publishDate || now - it.publishDate < MAX_AGE_MS))
          .sort((a, b) => (b.publishDate || 0) - (a.publishDate || 0))
          .map((item) => ({ item, feed, category })),
      );
    let count = 0;
    while (count < quota && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (count >= quota) break;
        let entry;
        while (
          (entry = q.shift()) &&
          (seen.has(entry.item.id) || (existing.has(entry.item.id) && existing.get(entry.item.id) !== category))
        );
        if (!entry) continue;
        seen.add(entry.item.id);
        count++;
        if (!existing.has(entry.item.id)) picked.push(entry);
      }
    }
  }
  return picked;
}

function describeError(err) {
  if (err instanceof HttpError) {
    return [401, 403, 429, 451].includes(err.status) ? `the site blocked the download (HTTP ${err.status})` : `the site returned HTTP ${err.status}`;
  }
  if (err?.name === 'TimeoutError') return 'timed out';
  return err?.message || 'failed';
}

async function downloadStory({ item, feed, category }, settings, signal) {
  let extraction = null;
  let pageUrl = item.link;
  let note = '';
  try {
    const res = await fetchViaProxy(item.link, { signal });
    pageUrl = res.headers.get('x-final-url') || item.link;
    extraction = extractArticle(await res.text(), pageUrl);
    if (!extraction.ok) note = extraction.reason;
  } catch (err) {
    if (err.name === 'AbortError' || err instanceof OfflineError || err instanceof ProxyUnreachableError) throw err;
    note = describeError(err);
  }

  const useFull = extraction?.ok === true;
  if (!useFull && settings.fullArticlesOnly) return { skipped: true, reason: note };

  const images = settings.downloadImages ? 'collect' : 'strip';
  const clean = sanitizeHTML(useFull ? extraction.contentHTML : item.summaryHTML, {
    baseUrl: useFull ? pageUrl : item.link,
    images,
    maxImages: MAX_INLINE_IMAGES,
  });

  let heroImageBlob = null;
  let thumbnailBlob = null;
  let heroUrl = null;
  let inlineImages = [];
  if (settings.downloadImages) {
    const heroCandidates = [...new Set([extraction?.image, ...item.imageCandidates, clean.images[0]].filter(Boolean))];
    for (const url of heroCandidates.slice(0, 3)) {
      heroImageBlob = await downloadImage(url, { maxDim: HERO_MAX_DIM, signal });
      if (heroImageBlob) {
        heroUrl = url;
        break;
      }
    }
    if (heroImageBlob) thumbnailBlob = await resizeImage(heroImageBlob, THUMB_MAX_DIM, 0.75);

    // Inline images; skip the one already used as the hero.
    inlineImages = await mapLimit(clean.images, 2, (url) =>
      url === heroUrl ? null : downloadImage(url, { maxDim: INLINE_MAX_DIM, signal }),
    );
  }

  const record = {
    id: item.id,
    title: item.title || extraction?.title || 'Untitled',
    author: item.author || extraction?.byline || '',
    publishDate: item.publishDate || extraction?.publishedTime || Date.now(),
    feedSource: feed.name,
    feedId: feed.id,
    category,
    link: item.link,
    articleHTML: clean.html,
    extracted: useFull,
    extractionNote: note,
    heroImageBlob,
    thumbnailBlob,
    inlineImages,
    syncedAt: Date.now(),
    readStatus: 'unread',
  };
  record.sizeBytes =
    new Blob([record.articleHTML, record.title]).size +
    (heroImageBlob?.size || 0) +
    (thumbnailBlob?.size || 0) +
    inlineImages.reduce((s, b) => s + (b?.size || 0), 0);

  signal?.throwIfAborted();
  await putArticle(record);
  return record;
}

/**
 * Fetch every enabled feed, download new stories into IndexedDB, then prune.
 * @param {{ onProgress?: (p: { phase: string, done: number, total: number, label: string }) => void, signal?: AbortSignal }} opts
 */
export async function syncNow({ onProgress = () => {}, signal } = {}) {
  if (!isOnline()) throw new OfflineError();

  // Losing connectivity mid-sync aborts everything still in flight.
  const controller = new AbortController();
  const onOffline = () => controller.abort(new OfflineError());
  globalThis.addEventListener?.('offline', onOffline);
  signal?.addEventListener('abort', () => controller.abort(signal.reason));
  const sig = controller.signal;

  try {
    const settings = await getSettings();
    const quotas = settings.categoryQuotas;
    // Feeds of categories set to 0 aren't fetched at all.
    const feeds = settings.feeds.filter((f) => f.enabled && Number(quotas[f.category || DEFAULT_CATEGORY]) > 0);
    if (!feeds.length) throw new Error('No feeds enabled — check Settings');
    const feedsById = Object.fromEntries(settings.feeds.map((f) => [f.id, f]));
    const storedCategories = async () =>
      new Map((await getAllArticles()).map((a) => [a.id, categoryOf(a, feedsById)]));

    let feedsDone = 0;
    onProgress({ phase: 'feeds', done: 0, total: feeds.length, label: `Checking feeds (0 of ${feeds.length})…` });
    const failedFeeds = [];
    const feedResults = (
      await mapLimit(feeds, 6, async (feed) => {
        try {
          const res = await fetchViaProxy(feed.url, { signal: sig });
          const parsed = parseFeed(await res.text(), feed.url);
          return { feed, items: parsed.items };
        } catch (err) {
          if (sig.aborted) throw sig.reason;
          // Not the publisher's fault: stop instead of blaming every feed.
          if (err instanceof ProxyUnreachableError) {
            controller.abort(err);
            throw err;
          }
          failedFeeds.push({ name: feed.name, error: describeError(err) });
          return null;
        } finally {
          feedsDone++;
          onProgress({ phase: 'feeds', done: feedsDone, total: feeds.length, label: `Checking feeds (${feedsDone} of ${feeds.length})…` });
        }
      })
    ).filter(Boolean);

    // Stories with no full text (paywalls, blocked sites) are remembered for a
    // week so "full articles only" doesn't re-download them on every sync.
    const now = Date.now();
    const skippedIds = new Map(Object.entries((await getMeta('skipped')) || {}).filter(([, t]) => now - t < MAX_AGE_MS));
    const excluded = () => (settings.fullArticlesOnly ? new Set(skippedIds.keys()) : new Set());

    let done = 0;
    let total = 0;
    let fallback = 0;
    let failed = 0;
    let skipped = 0;
    const attempted = new Set();
    const report = () =>
      onProgress({ phase: 'articles', done, total, label: `Downloading ${Math.min(done + 1, total)} of ${total}…` });

    // Skipped stories free up their slots, so backfill with the next-newest
    // ones (a couple of extra rounds at most).
    for (let round = 0; round < 3; round++) {
      const todo = selectStories(feedResults, await storedCategories(), quotas, now, excluded()).filter(
        ({ item }) => !attempted.has(item.id),
      );
      if (!todo.length) break;
      todo.forEach(({ item }) => attempted.add(item.id));
      total += todo.length;
      report();

      let skippedThisRound = 0;
      await mapLimit(todo, 3, async (entry) => {
        try {
          const record = await downloadStory(entry, settings, sig);
          if (record.skipped) {
            skippedIds.set(entry.item.id, Date.now());
            skippedThisRound++;
          } else if (!record.extracted) fallback++;
        } catch (err) {
          if (sig.aborted) throw sig.reason;
          if (err instanceof ProxyUnreachableError) {
            controller.abort(err);
            throw err;
          }
          failed++;
          console.warn('Story failed', entry.item.link, err);
        }
        done++;
        if (done < total) report();
      });
      skipped += skippedThisRound;
      if (!skippedThisRound) break;
    }
    await setMeta('skipped', Object.fromEntries(skippedIds));

    onProgress({ phase: 'cleanup', done: total, total, label: 'Cleaning up…' });
    const pruned = await pruneStories();
    await setMeta('lastSync', Date.now());
    return { added: total - failed - skipped, fallback, skipped, failed, pruned, failedFeeds, feedCount: feeds.length };
  } catch (err) {
    if (sig.aborted && (sig.reason instanceof OfflineError || sig.reason instanceof ProxyUnreachableError)) throw sig.reason;
    throw err;
  } finally {
    globalThis.removeEventListener?.('offline', onOffline);
  }
}
