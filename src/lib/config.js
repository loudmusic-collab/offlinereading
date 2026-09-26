export const PROXY_ENDPOINT = '/api/fetch';

// Reuters and AP don't publish official public RSS feeds any more; the two
// URLs below are the best-known stand-ins and can be edited in Settings.
export const DEFAULT_FEEDS = [
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', enabled: true },
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', enabled: true },
  { id: 'reuters', name: 'Reuters', url: 'https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best', enabled: true },
  { id: 'nyt', name: 'NY Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', enabled: true },
  { id: 'ap', name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', enabled: true },
];

export const DEFAULT_SETTINGS = {
  feeds: DEFAULT_FEEDS,
  maxStories: 50,
  downloadImages: true,
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
