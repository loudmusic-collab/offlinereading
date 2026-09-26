import { HERO_MAX_DIM, INLINE_MAX_DIM, MAX_AGE_MS, MAX_INLINE_IMAGES, THUMB_MAX_DIM } from './config.js';
import { getArticleIds, getSettings, putArticle, setMeta } from './db.js';
import { extractArticle } from './extract.js';
import { parseFeed } from './feeds.js';
import { downloadImage, resizeImage } from './images.js';
import { HttpError, OfflineError, fetchViaProxy, isOnline } from './net.js';
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
 * Pick which stories to keep: round-robin across feeds, newest first, so one
 * prolific feed can't crowd the others out. Returns the ones not yet stored.
 */
export function selectStories(feedResults, existingIds, maxStories, now = Date.now()) {
  const queues = feedResults.map(({ feed, items }) =>
    items
      .filter((it) => !it.publishDate || now - it.publishDate < MAX_AGE_MS)
      .sort((a, b) => (b.publishDate || 0) - (a.publishDate || 0))
      .map((item) => ({ item, feed })),
  );
  const seen = new Set();
  const picked = [];
  while (picked.length < maxStories && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (picked.length >= maxStories) break;
      let entry;
      while ((entry = q.shift()) && seen.has(entry.item.id));
      if (!entry) continue;
      seen.add(entry.item.id);
      picked.push(entry);
    }
  }
  return picked.filter(({ item }) => !existingIds.has(item.id));
}

function describeError(err) {
  if (err instanceof HttpError) {
    return [401, 403, 429, 451].includes(err.status) ? `site blocked the download (HTTP ${err.status})` : `HTTP ${err.status}`;
  }
  if (err?.name === 'TimeoutError') return 'timed out';
  return err?.message || 'failed';
}

async function downloadStory({ item, feed }, settings, signal) {
  let extraction = null;
  let pageUrl = item.link;
  let note = '';
  try {
    const res = await fetchViaProxy(item.link, { signal });
    pageUrl = res.headers.get('x-final-url') || item.link;
    extraction = extractArticle(await res.text(), pageUrl);
    if (!extraction.ok) note = extraction.reason;
  } catch (err) {
    if (err.name === 'AbortError' || err instanceof OfflineError) throw err;
    note = describeError(err);
  }

  const useFull = extraction?.ok === true;
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
    const feeds = settings.feeds.filter((f) => f.enabled);
    if (!feeds.length) throw new Error('No feeds enabled — add one in Settings');

    let feedsDone = 0;
    onProgress({ phase: 'feeds', done: 0, total: feeds.length, label: `Checking feeds (0 of ${feeds.length})…` });
    const failedFeeds = [];
    const feedResults = (
      await mapLimit(feeds, 3, async (feed) => {
        try {
          const res = await fetchViaProxy(feed.url, { signal: sig });
          const parsed = parseFeed(await res.text(), feed.url);
          return { feed, items: parsed.items };
        } catch (err) {
          if (sig.aborted) throw sig.reason;
          failedFeeds.push({ name: feed.name, error: describeError(err) });
          return null;
        } finally {
          feedsDone++;
          onProgress({ phase: 'feeds', done: feedsDone, total: feeds.length, label: `Checking feeds (${feedsDone} of ${feeds.length})…` });
        }
      })
    ).filter(Boolean);

    const todo = selectStories(feedResults, await getArticleIds(), settings.maxStories);
    let done = 0;
    let fallback = 0;
    let failed = 0;
    const total = todo.length;
    const report = () =>
      onProgress({ phase: 'articles', done, total, label: `Downloading ${Math.min(done + 1, total)} of ${total}…` });
    if (total) report();

    await mapLimit(todo, 3, async (entry) => {
      try {
        const record = await downloadStory(entry, settings, sig);
        if (!record.extracted) fallback++;
      } catch (err) {
        if (sig.aborted) throw sig.reason;
        failed++;
        console.warn('Story failed', entry.item.link, err);
      }
      done++;
      if (done < total) report();
    });

    onProgress({ phase: 'cleanup', done: total, total, label: 'Cleaning up…' });
    const pruned = await pruneStories();
    await setMeta('lastSync', Date.now());
    return { added: total - failed, fallback, failed, pruned, failedFeeds, feedCount: feeds.length };
  } catch (err) {
    if (sig.aborted && sig.reason instanceof OfflineError) throw sig.reason;
    throw err;
  } finally {
    globalThis.removeEventListener?.('offline', onOffline);
  }
}
