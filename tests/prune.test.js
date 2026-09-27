import { describe, expect, it } from 'vitest';
import { selectForPrune } from '../src/lib/prune.js';
import { selectStories } from '../src/lib/sync.js';

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 8, 26);
const story = (id, ageDays, readStatus = 'unread', category = 'top', sizeBytes = 1000) => ({
  id,
  publishDate: now - ageDays * DAY,
  syncedAt: now,
  readStatus,
  category,
  sizeBytes,
});
const quotas = (top, tech = 0) => ({ top, tech });

describe('selectForPrune', () => {
  it('deletes stories older than 7 days regardless of status', () => {
    const ids = selectForPrune([story('a', 8), story('b', 8, 'read'), story('c', 1)], { quotas: quotas(50), now });
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('trims each category to its quota: read before unread, oldest first', () => {
    const articles = [story('u-old', 6), story('u-new', 1), story('r-old', 5, 'read'), story('r-new', 0.5, 'read')];
    expect(selectForPrune(articles, { quotas: quotas(3), now })).toEqual(['r-old']);
    expect(selectForPrune(articles, { quotas: quotas(2), now })).toEqual(['r-old', 'r-new']);
    expect(selectForPrune(articles, { quotas: quotas(1), now })).toEqual(['r-old', 'r-new', 'u-old']);
  });

  it('applies quotas per category independently; 0 keeps none', () => {
    const articles = [story('t1', 1), story('t2', 2), story('x1', 1, 'unread', 'tech'), story('x2', 2, 'unread', 'tech')];
    expect(selectForPrune(articles, { quotas: quotas(2, 1), now })).toEqual(['x2']);
    expect(selectForPrune(articles, { quotas: quotas(2, 0), now }).sort()).toEqual(['x1', 'x2']);
  });

  it('trims to a byte budget under storage pressure', () => {
    const articles = [story('a', 3, 'unread', 'top', 5000), story('b', 2, 'read', 'top', 5000), story('c', 1, 'unread', 'top', 5000)];
    expect(selectForPrune(articles, { quotas: quotas(50), byteBudget: 9000, now })).toEqual(['b', 'a']);
  });

  it('falls back to syncedAt when there is no publish date', () => {
    const a = { id: 'x', publishDate: null, syncedAt: now - 10 * DAY, readStatus: 'read', category: 'top' };
    expect(selectForPrune([a], { quotas: quotas(50), now })).toEqual(['x']);
  });
});

describe('selectStories', () => {
  const item = (id, ageHours) => ({ id, publishDate: now - ageHours * 3600 * 1000 });
  const feedA = { feed: { name: 'A', category: 'top' }, items: [item('a1', 1), item('a2', 2), item('a3', 3), item('a-old', 24 * 9)] };
  const feedB = { feed: { name: 'B', category: 'top' }, items: [item('b1', 5), item('a1', 1)] };

  it('round-robins across a category’s feeds, skips stale, duplicate and stored stories', () => {
    const existing = new Map([['a2', 'top']]);
    const picked = selectStories([feedA, feedB], existing, quotas(4), now).map((p) => p.item.id);
    // slots: a1, b1, a2 (stored, so not downloaded), a3
    expect(picked).toEqual(['a1', 'b1', 'a3']);
  });

  it('fills each category up to its own quota and tags picks with the category', () => {
    const tech = { feed: { name: 'T', category: 'tech' }, items: [item('t1', 1), item('t2', 2), item('a1', 1)] };
    const picked = selectStories([feedA, tech], new Map(), quotas(2, 5), now);
    expect(picked.map((p) => `${p.category}:${p.item.id}`)).toEqual(['top:a1', 'top:a2', 'tech:t1', 'tech:t2']);
  });

  it('skips categories with a quota of 0', () => {
    const tech = { feed: { name: 'T', category: 'tech' }, items: [item('t1', 1)] };
    expect(selectStories([tech], new Map(), quotas(5, 0), now)).toEqual([]);
  });

  it('excluded (skipped) stories do not take up slots', () => {
    const feed = { feed: { name: 'A', category: 'top' }, items: [item('a1', 1), item('a2', 2), item('a3', 3)] };
    const picked = selectStories([feed], new Map(), quotas(2), now, new Set(['a1'])).map((p) => p.item.id);
    expect(picked).toEqual(['a2', 'a3']);
  });
});
