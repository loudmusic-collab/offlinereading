import { openDB } from 'idb';
import { DEFAULT_FEEDS, DEFAULT_SETTINGS, FEEDS_VERSION } from './config.js';

const DB_NAME = 'offline-news-reader';
const DB_VERSION = 1;

/*
 * articles store — one record per story:
 *   id, title, author, publishDate, feedSource, articleHTML, heroImageBlob,
 *   syncedAt, readStatus ('unread' | 'read')
 * plus: link, feedId, extracted, extractionNote, thumbnailBlob,
 *   inlineImages (Array<Blob|null>, indexed by data-offline-img), sizeBytes
 */
let dbPromise;

export function getDB() {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const articles = db.createObjectStore('articles', { keyPath: 'id' });
      articles.createIndex('publishDate', 'publishDate');
      articles.createIndex('syncedAt', 'syncedAt');
      db.createObjectStore('kv');
    },
    blocking() {
      // A newer version of the app wants to upgrade the schema.
      dbPromise?.then((db) => db.close());
      dbPromise = undefined;
    },
  });
  return dbPromise;
}

export const storyDate = (a) => a.publishDate || a.syncedAt;

export async function getAllArticles() {
  const all = await (await getDB()).getAll('articles');
  return all.sort((a, b) => storyDate(b) - storyDate(a));
}

export async function getArticle(id) {
  return (await getDB()).get('articles', id);
}

export async function getArticleIds() {
  return new Set(await (await getDB()).getAllKeys('articles'));
}

export async function putArticle(article) {
  return (await getDB()).put('articles', article);
}

export async function deleteArticles(ids) {
  if (!ids.length) return;
  const tx = (await getDB()).transaction('articles', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export async function clearArticles() {
  return (await getDB()).clear('articles');
}

export async function setReadStatus(id, readStatus) {
  const tx = (await getDB()).transaction('articles', 'readwrite');
  const article = await tx.store.get(id);
  if (article && article.readStatus !== readStatus) {
    article.readStatus = readStatus;
    await tx.store.put(article);
  }
  await tx.done;
  return article;
}

/**
 * v1 → v2: add the new free-to-read defaults and switch off NYT, Reuters and
 * AP. Feeds the user added, removed or renamed are otherwise left alone.
 */
export function migrateFeeds(stored) {
  if (!stored.feeds || (stored.feedsVersion || 1) >= FEEDS_VERSION) return null;
  const turnedOff = new Set(['nyt', 'reuters', 'ap']);
  const feeds = stored.feeds.map((f) => (turnedOff.has(f.id) ? { ...f, enabled: false } : f));
  for (const id of ['npr', 'aljazeera', 'dw']) {
    const feed = DEFAULT_FEEDS.find((d) => d.id === id);
    if (!feeds.some((f) => f.id === id || f.url === feed.url)) feeds.push(feed);
  }
  return { ...stored, feeds, feedsVersion: FEEDS_VERSION };
}

export async function getSettings() {
  const db = await getDB();
  let stored = (await db.get('kv', 'settings')) || {};
  const migrated = migrateFeeds(stored);
  if (migrated) {
    stored = migrated;
    await db.put('kv', stored, 'settings');
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await (await getDB()).put('kv', next, 'settings');
  return next;
}

export async function getMeta(key) {
  return (await getDB()).get('kv', key);
}

export async function setMeta(key, value) {
  return (await getDB()).put('kv', value, key);
}
