import { MAX_AGE_MS, STORAGE_BUDGET_BYTES, categoryOf } from './config.js';
import { deleteArticles, getAllArticles, getSettings, storyDate } from './db.js';

export function articleSize(a) {
  if (a.sizeBytes) return a.sizeBytes;
  let size = (a.articleHTML?.length || 0) + (a.title?.length || 0);
  size += a.heroImageBlob?.size || 0;
  size += a.thumbnailBlob?.size || 0;
  for (const img of a.inlineImages || []) size += img?.size || 0;
  return size;
}

/**
 * Decide which stories to delete.
 *  1. Anything older than maxAgeMs goes, read or not.
 *  2. Each category is trimmed to its quota (0 = keep none): read stories
 *     oldest-first, and only then unread stories oldest-first.
 *  3. If still over byteBudget, the same order applies across everything.
 * @param {object} opts
 * @param {Record<string, number>} opts.quotas  stories to keep per category
 * @param {(a: object) => string} [opts.categoryOf]
 */
export function selectForPrune(
  articles,
  { quotas, categoryOf = (a) => a.category, byteBudget = Infinity, maxAgeMs = MAX_AGE_MS, now = Date.now() },
) {
  const doomed = [];
  const keep = [];
  for (const a of articles) {
    if (now - storyDate(a) > maxAgeMs) doomed.push(a.id);
    else keep.push(a);
  }

  const oldestFirst = (x, y) => storyDate(x) - storyDate(y);
  const deletionOrder = (list) => [
    ...list.filter((a) => a.readStatus === 'read').sort(oldestFirst),
    ...list.filter((a) => a.readStatus !== 'read').sort(oldestFirst),
  ];

  const byCategory = new Map();
  for (const a of keep) {
    const cat = categoryOf(a);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(a);
  }
  const survivors = [];
  for (const [cat, list] of byCategory) {
    const order = deletionOrder(list);
    const excess = Math.max(0, list.length - (Number(quotas[cat]) || 0));
    order.slice(0, excess).forEach((a) => doomed.push(a.id));
    survivors.push(...order.slice(excess));
  }

  let bytes = survivors.reduce((sum, a) => sum + articleSize(a), 0);
  for (const a of deletionOrder(survivors)) {
    if (bytes <= byteBudget) break;
    doomed.push(a.id);
    bytes -= articleSize(a);
  }
  return doomed;
}

/** Byte budget for our stories: the app ceiling, tightened under browser storage pressure. */
export async function currentByteBudget(articles) {
  let budget = STORAGE_BUDGET_BYTES;
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    if (quota) {
      const ours = articles.reduce((sum, a) => sum + articleSize(a), 0);
      const other = Math.max(0, usage - ours);
      // Stay under 80% of the quota the browser granted us.
      budget = Math.min(budget, Math.max(0, quota * 0.8 - other));
    }
  } catch {
    // estimate() unavailable — fall back to the fixed ceiling
  }
  return budget;
}

export async function pruneStories({ now = Date.now() } = {}) {
  const [articles, settings] = await Promise.all([getAllArticles(), getSettings()]);
  const byteBudget = await currentByteBudget(articles);
  const feedsById = Object.fromEntries(settings.feeds.map((f) => [f.id, f]));
  const ids = selectForPrune(articles, {
    quotas: settings.categoryQuotas,
    categoryOf: (a) => categoryOf(a, feedsById),
    byteBudget,
    now,
  });
  await deleteArticles(ids);
  return ids.length;
}
