import { Readability } from '@mozilla/readability';

// Pages that come back 200 but are really a bot wall or consent screen.
const BLOCK_PATTERNS = [
  /access denied/i,
  /are you a robot/i,
  /verify you are (a )?human/i,
  /enable javascript/i,
  /just a moment/i,
  /unusual traffic/i,
  /subscribe to (continue|read)/i,
  /captcha/i,
];

const MIN_ARTICLE_CHARS = 600;

function meta(doc, ...keys) {
  for (const key of keys) {
    const el = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return '';
}

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

const URL_ATTRS = ['href', 'src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'poster'];

/**
 * DOMParser documents take the *app's* URL as their base (Chromium ignores an
 * injected <base>), so Readability would resolve "/img/a.jpg" against our own
 * origin. Make every URL absolute against the article URL up front instead.
 */
function absolutizeUrls(doc, pageUrl) {
  const baseEl = doc.querySelector('base[href]');
  const base = (baseEl && absolute(baseEl.getAttribute('href'), pageUrl)) || pageUrl;
  for (const attr of URL_ATTRS) {
    for (const el of doc.querySelectorAll(`[${attr}]`)) {
      const value = el.getAttribute(attr).trim();
      if (!value || /^(data|mailto|javascript|tel):/i.test(value) || value.startsWith('#')) continue;
      const abs = absolute(value, base);
      if (abs) el.setAttribute(attr, abs);
    }
  }
  for (const attr of ['srcset', 'data-srcset']) {
    for (const el of doc.querySelectorAll(`[${attr}]`)) {
      const fixed = el
        .getAttribute(attr)
        .split(/,\s+(?=\S)/)
        .map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          return [absolute(url, base) || url, ...rest].join(' ');
        })
        .join(', ');
      el.setAttribute(attr, fixed);
    }
  }
}

/**
 * Run Readability over raw page HTML.
 * @returns {{ ok: boolean, reason?: string, contentHTML?: string, textLength: number, byline: string, title: string, image: string|null, publishedTime: number|null }}
 */
export function extractArticle(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  absolutizeUrls(doc, pageUrl);

  const ogImage = meta(doc, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  const published = meta(doc, 'article:published_time', 'datePublished', 'pubdate', 'date');
  const metaAuthor = meta(doc, 'author', 'article:author', 'byl', 'sailthru.author');
  const info = {
    image: ogImage ? absolute(ogImage, pageUrl) : null,
    publishedTime: published && !Number.isNaN(Date.parse(published)) ? Date.parse(published) : null,
  };

  let result = null;
  try {
    result = new Readability(doc, { charThreshold: 400, keepClasses: false }).parse();
  } catch (err) {
    return { ok: false, reason: `Readability failed: ${err.message}`, textLength: 0, byline: metaAuthor, title: '', ...info };
  }
  if (!result || !result.content) {
    return { ok: false, reason: 'No article content found', textLength: 0, byline: metaAuthor, title: '', ...info };
  }

  const text = (result.textContent || '').replace(/\s+/g, ' ').trim();
  const byline = (result.byline || metaAuthor || '').replace(/^by\s+/i, '').trim();
  const base = { contentHTML: result.content, textLength: text.length, byline, title: result.title || '', ...info };

  if (text.length < MIN_ARTICLE_CHARS) {
    return { ok: false, reason: `Extracted text too short (${text.length} chars)`, ...base };
  }
  if (text.length < 2000 && BLOCK_PATTERNS.some((re) => re.test(text) || re.test(result.title || ''))) {
    return { ok: false, reason: 'Page looks like a bot check or paywall', ...base };
  }
  return { ok: true, ...base };
}
