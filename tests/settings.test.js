import { describe, expect, it } from 'vitest';
import { DEFAULT_FEEDS, FEEDS_VERSION } from '../src/lib/config.js';
import { getSettings, migrateFeeds, saveSettings } from '../src/lib/db.js';

const v1Feeds = [
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', enabled: true },
  { id: 'nyt', name: 'NY Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', enabled: true },
  { id: 'ap', name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', enabled: true },
  { id: 'feed-x', name: 'My feed', url: 'https://example.com/rss', enabled: true },
];

describe('feed defaults migration', () => {
  it('adds the new defaults, disables NYT/Reuters/AP and keeps custom feeds', () => {
    const out = migrateFeeds({ feeds: v1Feeds, maxStories: 30 });
    const byId = Object.fromEntries(out.feeds.map((f) => [f.id, f]));
    expect(out.feedsVersion).toBe(FEEDS_VERSION);
    expect(out.maxStories).toBe(30);
    expect(byId.nyt.enabled).toBe(false);
    expect(byId.ap.enabled).toBe(false);
    expect(byId.bbc.enabled).toBe(true);
    expect(byId['feed-x'].enabled).toBe(true);
    expect(['npr', 'aljazeera', 'dw'].every((id) => byId[id]?.enabled)).toBe(true);
    expect(byId.reuters).toBeUndefined(); // user had removed it: stays removed
  });

  it('does nothing for fresh or already-migrated settings', () => {
    expect(migrateFeeds({})).toBeNull();
    expect(migrateFeeds({ feeds: DEFAULT_FEEDS, feedsVersion: FEEDS_VERSION })).toBeNull();
  });

  it('persists the migration through getSettings', async () => {
    await saveSettings({ feeds: v1Feeds, feedsVersion: 1 });
    const settings = await getSettings();
    expect(settings.feeds.find((f) => f.id === 'npr')).toBeTruthy();
    expect(settings.fullArticlesOnly).toBe(true);
    expect((await getSettings()).feeds).toHaveLength(settings.feeds.length); // idempotent
  });
});
