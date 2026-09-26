import { describe, expect, it } from 'vitest';
import { extractArticle } from '../src/lib/extract.js';
import { sanitizeHTML } from '../src/lib/sanitize.js';
import { ORIGIN, fixture } from './helpers.js';

const url = `${ORIGIN}/news/articles/tides`;

describe('extractArticle', () => {
  it('extracts the article body with Readability', () => {
    const result = extractArticle(fixture('article-full.html'), url);
    expect(result.ok).toBe(true);
    expect(result.byline).toBe('Jane Marlow');
    expect(result.image).toBe(`${ORIGIN}/img/hero-tides.png`);
    expect(result.contentHTML).toContain('highest tide is forecast');
    expect(result.contentHTML).not.toContain('We use cookies');
    expect(result.contentHTML).not.toContain('Copyright 2026');
  });

  it('resolves relative links and images against the article URL, not the app', () => {
    const result = extractArticle(fixture('article-full.html'), url);
    expect(result.contentHTML).toContain(`href="${ORIGIN}/news/flood-advice"`);
    expect(result.contentHTML).toContain(`${ORIGIN}/img/inline-wall.png`);
    expect(result.contentHTML).not.toMatch(/(src|href)="\//);
  });

  it('handles lazy-loaded images', () => {
    const result = extractArticle(fixture('article-lazy.html'), `${ORIGIN}/news/articles/night-trains`);
    expect(result.ok).toBe(true);
    const clean = sanitizeHTML(result.contentHTML, { baseUrl: `${ORIGIN}/news/articles/night-trains`, images: 'collect' });
    expect(clean.images).toEqual([`${ORIGIN}/img/lazy-train.png`]);
  });

  it('flags bot walls so the RSS summary is used instead', () => {
    const result = extractArticle(fixture('article-botwall.html'), url);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/characters|bot check/);
  });

  it('flags pages with no article', () => {
    expect(extractArticle('<html><body></body></html>', url).ok).toBe(false);
  });
});

describe('sanitizeHTML', () => {
  const content = () => extractArticle(fixture('article-full.html'), url).contentHTML;

  it('collects images as offline placeholders and removes remote references', () => {
    const { html, images } = sanitizeHTML(content(), { baseUrl: url, images: 'collect' });
    // srcset entry >= 900w is preferred; tracking pixel skipped
    expect(images).toEqual([`${ORIGIN}/img/inline-wall.png`]);
    expect(html).toContain('data-offline-img="0"');
    expect(html).not.toMatch(/\ssrc=|srcset|iframe|tracker\.example/);
  });

  it('strips scripts, handlers and dangerous links', () => {
    const { html } = sanitizeHTML(
      content() + '<p onclick="x()">t<script>alert(1)</script><a href="javascript:alert(1)">j</a><img src=x onerror=alert(1)></p><style>p{}</style><!-- c -->',
      { baseUrl: url, images: 'collect' },
    );
    expect(html).not.toMatch(/onclick|onerror|<script|javascript:|<style|<!--/i);
    expect(html).toContain(`href="${ORIGIN}/news/flood-advice"`);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('drops all images in strip mode', () => {
    const { html, images } = sanitizeHTML(content(), { baseUrl: url, images: 'strip' });
    expect(images).toEqual([]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<figure'); // captions without images go too
  });

  it('keeps only numeric placeholders in refs mode', () => {
    const { html } = sanitizeHTML('<p>a</p><img data-offline-img="2" alt="k"><img src="https://x/y.png"><img data-offline-img="x">', {
      images: 'refs',
    });
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('data-offline-img="2"');
    expect(html).toContain('alt="k"');
  });
});
