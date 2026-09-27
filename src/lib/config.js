export const PROXY_ENDPOINT = '/api/fetch';

export const APP_NAME = 'News from the Void';

// Tabs across the top of the story list, in display order. `quota` is the
// default number of stories kept per category (0 hides the tab and skips its
// feeds when syncing).
export const CATEGORIES = [
  { id: 'top', label: 'Top', color: '#d9383d', quota: 10 },
  { id: 'world', label: 'World', color: '#2f6fd0', quota: 8 },
  { id: 'us', label: 'U.S.', color: '#0f8f80', quota: 8 },
  { id: 'business', label: 'Business', color: '#b35c00', quota: 5 },
  { id: 'tech', label: 'Tech', color: '#8445bc', quota: 5 },
  { id: 'science', label: 'Science', color: '#0b7a92', quota: 5 },
  { id: 'health', label: 'Health', color: '#2b8a3e', quota: 4 },
  { id: 'sports', label: 'Sports', color: '#d9480f', quota: 3 },
  { id: 'entertainment', label: 'Entertainment', color: '#c2257f', quota: 2 },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const DEFAULT_CATEGORY = 'top';

const feed = (id, name, category, url, enabled = true) => ({ id, name, category, url, enabled });

// Free-to-read publishers with official per-section feeds. NYT (paywalled),
// Reuters and AP (no official public RSS; stand-in URLs) are off by default.
export const DEFAULT_FEEDS = [
  feed('bbc', 'BBC News', 'top', 'https://feeds.bbci.co.uk/news/rss.xml'),
  feed('npr', 'NPR', 'top', 'https://feeds.npr.org/1001/rss.xml'),
  feed('dw', 'DW News', 'top', 'https://rss.dw.com/rdf/rss-en-all'),
  feed('guardian', 'The Guardian', 'world', 'https://www.theguardian.com/world/rss'),
  feed('bbc-world', 'BBC News', 'world', 'https://feeds.bbci.co.uk/news/world/rss.xml'),
  feed('aljazeera', 'Al Jazeera', 'world', 'https://www.aljazeera.com/xml/rss/all.xml'),
  feed('npr-world', 'NPR', 'world', 'https://feeds.npr.org/1004/rss.xml'),
  feed('npr-us', 'NPR', 'us', 'https://feeds.npr.org/1003/rss.xml'),
  feed('guardian-us', 'The Guardian', 'us', 'https://www.theguardian.com/us-news/rss'),
  feed('bbc-us', 'BBC News', 'us', 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml'),
  feed('bbc-business', 'BBC News', 'business', 'https://feeds.bbci.co.uk/news/business/rss.xml'),
  feed('guardian-business', 'The Guardian', 'business', 'https://www.theguardian.com/business/rss'),
  feed('npr-business', 'NPR', 'business', 'https://feeds.npr.org/1006/rss.xml'),
  feed('bbc-tech', 'BBC News', 'tech', 'https://feeds.bbci.co.uk/news/technology/rss.xml'),
  feed('guardian-tech', 'The Guardian', 'tech', 'https://www.theguardian.com/technology/rss'),
  feed('npr-tech', 'NPR', 'tech', 'https://feeds.npr.org/1019/rss.xml'),
  feed('bbc-science', 'BBC News', 'science', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml'),
  feed('guardian-science', 'The Guardian', 'science', 'https://www.theguardian.com/science/rss'),
  feed('npr-science', 'NPR', 'science', 'https://feeds.npr.org/1007/rss.xml'),
  feed('bbc-health', 'BBC News', 'health', 'https://feeds.bbci.co.uk/news/health/rss.xml'),
  feed('npr-health', 'NPR', 'health', 'https://feeds.npr.org/1128/rss.xml'),
  feed('bbc-sport', 'BBC Sport', 'sports', 'https://feeds.bbci.co.uk/sport/rss.xml'),
  feed('guardian-sport', 'The Guardian', 'sports', 'https://www.theguardian.com/sport/rss'),
  feed('bbc-ent', 'BBC News', 'entertainment', 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml'),
  feed('guardian-culture', 'The Guardian', 'entertainment', 'https://www.theguardian.com/culture/rss'),
  feed('npr-arts', 'NPR', 'entertainment', 'https://feeds.npr.org/1008/rss.xml'),
  feed('nyt', 'NY Times', 'top', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', false),
  feed('reuters', 'Reuters', 'top', 'https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best', false),
  feed('ap', 'AP News', 'top', 'https://rsshub.app/apnews/topics/apf-topnews', false),
];

// Bump when DEFAULT_FEEDS changes in a way existing installs should pick up
// (see migrateSettings in db.js).
export const FEEDS_VERSION = 3;

export const DEFAULT_QUOTAS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.quota]));

export const DEFAULT_SETTINGS = {
  feeds: DEFAULT_FEEDS,
  feedsVersion: FEEDS_VERSION,
  categoryQuotas: DEFAULT_QUOTAS,
  downloadImages: true,
  // Skip stories whose full text can't be downloaded instead of saving the summary.
  fullArticlesOnly: true,
};

/** Category of a stored story; stories saved before categories existed fall back to their feed's. */
export function categoryOf(article, feedsById = {}) {
  const id = article.category || feedsById[article.feedId]?.category;
  return CATEGORY_BY_ID[id] ? id : DEFAULT_CATEGORY;
}

export const totalQuota = (quotas) => Object.values(quotas).reduce((a, b) => a + (Number(b) || 0), 0);

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PER_CATEGORY = 100;
// Hard ceiling on what this app stores, whatever the browser's quota says.
export const STORAGE_BUDGET_BYTES = 250 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 6;
export const HERO_MAX_DIM = 1200;
export const INLINE_MAX_DIM = 1000;
export const THUMB_MAX_DIM = 240;
