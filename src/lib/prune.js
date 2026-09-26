import { MAX_AGE_MS, STORAGE_BUDGET_BYTES } from './config.js';
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
 *  2. If still over maxStories or byteBudget, trim read stories oldest-first,
 *     and only then unread stories oldest-first — unread survive longer.
 */
export function selectForPrune(articles, { maxStories, byteBudget = Infinity, maxAgeMs = MAX_AGE_MS, now = Date.now() }) {
  const doomed = [];
  const keep = [];
  for (const a of articles) {
    if (now - storyDate(a) > maxAgeMs) doomed.push(a.id);
    else keep.push(a);
  }

  const oldestFirst = (x, y) => storyDate(x) - storyDate(y);
  const order = [
    ...keep.filter((a) => a.readStatus === 'read').sort(oldestFirst),
    ...keep.filter((a) => a.readStatus !== 'read').sort(oldestFirst),
  ];

  let count = keep.length;
  let bytes = keep.reduce((sum, a) => sum + articleSize(a), 0);
  for (const a of order) {
    if (count <= maxStories && bytes <= byteBudget) break;
    doomed.push(a.id);
    count -= 1;
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
  const ids = selectForPrune(articles, { maxStories: settings.maxStories, byteBudget, now });
  await deleteArticles(ids);
  return ids.length;
}
