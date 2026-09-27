export const PROXY_ENDPOINT = '/api/fetch';

// Enabled by default: free-to-read publishers whose full articles extract.
// Off by default: NYT (paywalled) and Reuters/AP, which have no official
// public RSS feeds (the URLs below are stand-ins) and block scrapers.
export const DEFAULT_FEEDS = [
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', enabled: true },
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', enabled: true },
  { id: 'npr', name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', enabled: true },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', enabled: true },
  { id: 'dw', name: 'DW News', url: 'https://rss.dw.com/rdf/rss-en-all', enabled: true },
  { id: 'nyt', name: 'NY Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', enabled: false },
  { id: 'reuters', name: 'Reuters', url: 'https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best', enabled: false },
  { id: 'ap', name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', enabled: false },
];

// Bump when DEFAULT_FEEDS changes in a way existing installs should pick up.
export const FEEDS_VERSION = 2;

export const DEFAULT_SETTINGS = {
  feeds: DEFAULT_FEEDS,
  feedsVersion: FEEDS_VERSION,
  maxStories: 50,
  downloadImages: true,
  // Skip stories whose full text can't be downloaded instead of saving the summary.
  fullArticlesOnly: true,
};

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_STORIES = 5;
export const MAX_STORIES = 500;
// Hard ceiling on what this app stores, whatever the browser's quota says.
export const STORAGE_BUDGET_BYTES = 250 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 6;
export const HERO_MAX_DIM = 1200;
export const INLINE_MAX_DIM = 1000;
export const THUMB_MAX_DIM = 240;
