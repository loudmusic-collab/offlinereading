import { describe, expect, it } from 'vitest';
import { selectForPrune } from '../src/lib/prune.js';
import { selectStories } from '../src/lib/sync.js';

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 8, 26);
const story = (id, ageDays, readStatus = 'unread', sizeBytes = 1000) => ({
  id,
  publishDate: now - ageDays * DAY,
  syncedAt: now,
  readStatus,
  sizeBytes,
});

describe('selectForPrune', () => {
  it('deletes stories older than 7 days regardless of status', () => {
    const ids = selectForPrune([story('a', 8), story('b', 8, 'read'), story('c', 1)], { maxStories: 50, now });
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('trims read stories before unread ones, oldest first', () => {
    const articles = [story('u-old', 6), story('u-new', 1), story('r-old', 5, 'read'), story('r-new', 0.5, 'read')];
    expect(selectForPrune(articles, { maxStories: 3, now })).toEqual(['r-old']);
    expect(selectForPrune(articles, { maxStories: 2, now })).toEqual(['r-old', 'r-new']);
    expect(selectForPrune(articles, { maxStories: 1, now })).toEqual(['r-old', 'r-new', 'u-old']);
  });

  it('trims to a byte budget under storage pressure', () => {
    const articles = [story('a', 3, 'unread', 5000), story('b', 2, 'read', 5000), story('c', 1, 'unread', 5000)];
    expect(selectForPrune(articles, { maxStories: 50, byteBudget: 9000, now })).toEqual(['b', 'a']);
  });

  it('falls back to syncedAt when there is no publish date', () => {
    const a = { id: 'x', publishDate: null, syncedAt: now - 10 * DAY, readStatus: 'read' };
    expect(selectForPrune([a], { maxStories: 50, now })).toEqual(['x']);
  });
});

describe('selectStories', () => {
  const item = (id, ageHours) => ({ id, publishDate: now - ageHours * 3600 * 1000 });
  const feedA = { feed: { name: 'A' }, items: [item('a1', 1), item('a2', 2), item('a3', 3), item('a-old', 24 * 9)] };
  const feedB = { feed: { name: 'B' }, items: [item('b1', 5), item('a1', 1)] };

  it('round-robins across feeds, skips stale, duplicate and stored stories', () => {
    const picked = selectStories([feedA, feedB], new Set(['a2']), 4, now).map((p) => p.item.id);
    // slots: a1, b1, a2 (stored, so not downloaded), a3
    expect(picked).toEqual(['a1', 'b1', 'a3']);
  });
});

describe('selectStories with skipped ids', () => {
  const item = (id, ageHours) => ({ id, publishDate: now - ageHours * 3600 * 1000 });
  it('excluded (skipped) stories do not take up slots', () => {
    const feed = { feed: { name: 'A' }, items: [item('a1', 1), item('a2', 2), item('a3', 3)] };
    const picked = selectStories([feed], new Set(), 2, now, new Set(['a1'])).map((p) => p.item.id);
    expect(picked).toEqual(['a2', 'a3']);
  });
});
