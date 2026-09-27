import { describe, expect, it } from 'vitest';
import { DEFAULT_FEEDS, DEFAULT_QUOTAS, FEEDS_VERSION, categoryOf } from '../src/lib/config.js';
import { getSettings, migrateSettings, saveSettings } from '../src/lib/db.js';

const v1Feeds = [
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', enabled: true },
  { id: 'nyt', name: 'NY Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', enabled: true },
  { id: 'ap', name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', enabled: true },
  { id: 'feed-x', name: 'My feed', url: 'https://example.com/rss', enabled: true },
];

describe('settings migration', () => {
  it('v1: adds the new defaults, disables NYT/AP, categorises and keeps custom feeds', () => {
    const out = migrateSettings({ feeds: v1Feeds, maxStories: 30 });
    const byId = Object.fromEntries(out.feeds.map((f) => [f.id, f]));
    expect(out.feedsVersion).toBe(FEEDS_VERSION);
    expect(out.maxStories).toBe(30);
    expect(byId.nyt.enabled).toBe(false);
    expect(byId.ap.enabled).toBe(false);
    expect(byId.bbc).toMatchObject({ enabled: true, category: 'top' });
    expect(byId['feed-x']).toMatchObject({ enabled: true, category: 'top' });
    expect(['npr', 'aljazeera', 'dw', 'bbc-tech', 'npr-health'].every((id) => byId[id]?.enabled)).toBe(true);
    expect(byId.reuters).toBeUndefined(); // user had removed it: stays removed
  });

  it('v2: keeps choices, adds categories and the per-section feeds only', () => {
    const v2 = [
      { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', enabled: false },
      { id: 'feed-cbc', name: 'CBC News', url: 'https://www.cbc.ca/webfeed/rss/rss-topstories', enabled: true },
    ];
    const out = migrateSettings({ feeds: v2, feedsVersion: 2 });
    const byId = Object.fromEntries(out.feeds.map((f) => [f.id, f]));
    expect(byId.guardian).toMatchObject({ enabled: false, category: 'world' });
    expect(byId['feed-cbc'].category).toBe('top');
    expect(byId.npr).toBeUndefined(); // a v2 default the user removed isn't re-added
    expect(byId['guardian-tech']).toBeTruthy();
  });

  it('does nothing for fresh or already-migrated settings', () => {
    expect(migrateSettings({})).toBeNull();
    expect(migrateSettings({ feeds: DEFAULT_FEEDS, feedsVersion: FEEDS_VERSION })).toBeNull();
  });

  it('persists the migration and fills in category quotas', async () => {
    await saveSettings({ feeds: v1Feeds, feedsVersion: 1, categoryQuotas: { top: 3 } });
    const settings = await getSettings();
    expect(settings.feeds.find((f) => f.id === 'npr')).toBeTruthy();
    expect(settings.fullArticlesOnly).toBe(true);
    expect(settings.categoryQuotas).toEqual({ ...DEFAULT_QUOTAS, top: 3 });
    expect((await getSettings()).feeds).toHaveLength(settings.feeds.length); // idempotent
  });

  it('works out the category of stories saved before categories existed', () => {
    const feeds = { 'bbc-tech': { category: 'tech' } };
    expect(categoryOf({ category: 'health' }, feeds)).toBe('health');
    expect(categoryOf({ feedId: 'bbc-tech' }, feeds)).toBe('tech');
    expect(categoryOf({ feedId: 'gone' }, feeds)).toBe('top');
  });
});
