import { describe, expect, it } from 'vitest';
import { canonicalId, parseFeed } from '../src/lib/feeds.js';
import { ORIGIN, fixture } from './helpers.js';

describe('parseFeed', () => {
  it('parses an RSS 2.0 feed with media extensions', () => {
    const { title, items } = parseFeed(fixture('feed.xml'), `${ORIGIN}/feed.xml`);
    expect(title).toBe('Fixture News - Home');
    expect(items).toHaveLength(5);
    const [tides, trains] = items;
    expect(tides.id).toBe(`${ORIGIN}/news/articles/tides`); // tracking params stripped
    expect(tides.link).toContain('at_medium=RSS');
    expect(tides.author).toBe('Jane Marlow');
    expect(tides.publishDate).toBeGreaterThan(Date.now() - 60_000);
    expect(tides.imageCandidates).toEqual([`${ORIGIN}/img/thumb-tides.png`]);
    // Widest media:content first
    expect(trains.imageCandidates[0]).toBe(`${ORIGIN}/img/hero-train.png`);
    expect(trains.summaryHTML).toContain('<b>sleeper services</b>');
    expect(trains.summaryText).toContain('sleeper services');
    expect(items[4].publishDate).toBe(Date.UTC(2001, 0, 1, 10));
  });

  it('parses Atom feeds', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom News</title>
        <entry>
          <title type="html">Hello &amp;amp; welcome</title>
          <link rel="self" href="https://a.example/self"/>
          <link rel="alternate" type="text/html" href="/posts/1"/>
          <id>tag:a.example,2026:1</id>
          <published>2026-09-20T10:00:00Z</published>
          <author><name>Sam Writer</name></author>
          <summary>Plain text summary</summary>
        </entry>
      </feed>`;
    const { title, items } = parseFeed(xml, 'https://a.example/feed');
    expect(title).toBe('Atom News');
    expect(items[0]).toMatchObject({
      link: 'https://a.example/posts/1',
      author: 'Sam Writer',
      publishDate: Date.parse('2026-09-20T10:00:00Z'),
      summaryHTML: '<p>Plain text summary</p>',
    });
  });

  it('parses RSS 1.0 (RDF) feeds', () => {
    const xml = `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>RDF News</title></channel>
        <item><title>One</title><link>https://r.example/1</link><dc:date>2026-09-21T00:00:00Z</dc:date><dc:creator>Ann</dc:creator></item>
      </rdf:RDF>`;
    const { items } = parseFeed(xml, 'https://r.example/rss');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ link: 'https://r.example/1', author: 'Ann' });
  });

  it('recovers from HTML entities that are invalid in XML', () => {
    const xml = `<rss version="2.0"><channel><title>T</title>
      <item><title>Caf&eacute; news&nbsp;today</title><link>https://e.example/a</link></item>
      </channel></rss>`;
    const { items } = parseFeed(xml, 'https://e.example/rss');
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://e.example/a');
  });

  it('rejects non-feed documents', () => {
    expect(() => parseFeed('<html><body>hi</body></html>', 'https://x.example')).toThrow();
  });

  it('canonicalises ids', () => {
    expect(canonicalId('https://x.example/a?utm_source=rss&id=3#frag')).toBe('https://x.example/a?id=3');
  });
});
