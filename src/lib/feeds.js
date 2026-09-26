// RSS 2.0 / RSS 1.0 (RDF) / Atom parser built on DOMParser, so it runs in the
// browser and under linkedom in Node.

const name = (el) => (el.nodeName || '').toLowerCase();

function children(el, ...names) {
  const wanted = names.map((n) => n.toLowerCase());
  return Array.from(el.children || []).filter((c) => wanted.includes(name(c)));
}

function childText(el, ...names) {
  for (const n of names) {
    const c = children(el, n)[0];
    const text = c?.textContent?.trim();
    if (text) return text;
  }
  return '';
}

function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHTML(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function atomLink(entry, base) {
  const links = children(entry, 'link', 'atom:link');
  const alt =
    links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate' && /html|^$/.test(l.getAttribute('type') || '')) ||
    links.find((l) => !l.getAttribute('rel')) ||
    links[0];
  const href = alt?.getAttribute('href') || alt?.textContent?.trim();
  return href ? absolute(href, base) : null;
}

/** Candidate image URLs from feed metadata, best first. */
function imageCandidates(item, base) {
  const found = [];
  const add = (url, width = 0) => {
    const abs = url && absolute(url, base);
    if (abs && /^https?:/.test(abs)) found.push({ url: abs, width: Number(width) || 0 });
  };
  const mediaNodes = [
    ...children(item, 'media:content'),
    ...children(item, 'media:group').flatMap((g) => children(g, 'media:content')),
  ];
  for (const m of mediaNodes) {
    const medium = m.getAttribute('medium');
    const type = m.getAttribute('type') || '';
    if (medium === 'image' || type.startsWith('image/') || (!medium && !type)) {
      add(m.getAttribute('url'), m.getAttribute('width'));
    }
  }
  for (const t of children(item, 'media:thumbnail')) add(t.getAttribute('url'), t.getAttribute('width'));
  for (const e of children(item, 'enclosure')) {
    if ((e.getAttribute('type') || '').startsWith('image/')) add(e.getAttribute('url'));
  }
  // Widest first; entries without a width keep document order after sized ones.
  found.sort((a, b) => b.width - a.width);
  const html = childText(item, 'content:encoded', 'content', 'description', 'summary');
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) add(img[1]);
  return [...new Set(found.map((f) => f.url))];
}

// Stable story id: the article URL without tracking parameters or fragment,
// so the same story listed in two feeds is only stored once.
export function canonicalId(link) {
  const u = new URL(link);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|at_|cmp|ns_|ito$|CMP$)/i.test(key)) u.searchParams.delete(key);
  }
  return u.href;
}

// Named HTML entities are illegal in XML; some feeds use them anyway.
const XML_ENTITIES = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi;

function parseXML(text) {
  const parser = new DOMParser();
  let doc = parser.parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    doc = parser.parseFromString(text.replace(XML_ENTITIES, '&amp;'), 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Feed is not valid XML');
  }
  return doc;
}

/**
 * @returns {{ title: string, items: Array<{ id, title, link, author, publishDate, summaryHTML, summaryText, imageCandidates }> }}
 */
export function parseFeed(xmlText, feedUrl) {
  const doc = parseXML(xmlText.trim());
  const root = doc.documentElement;
  const rootName = name(root);
  const isAtom = rootName === 'feed';
  if (!isAtom && rootName !== 'rss' && rootName !== 'rdf:rdf') {
    throw new Error('Not an RSS or Atom feed');
  }

  const channel = isAtom ? root : children(root, 'channel')[0] || root;
  const title = childText(channel, 'title');
  const entries = isAtom
    ? children(root, 'entry')
    : [...children(channel, 'item'), ...(channel === root ? [] : children(root, 'item'))];

  const items = [];
  for (const entry of entries) {
    const link = isAtom ? atomLink(entry, feedUrl) : absolute(childText(entry, 'link') || childText(entry, 'guid'), feedUrl);
    if (!link || !/^https?:/.test(link)) continue;

    const itemTitle = stripTags(childText(entry, 'title')) || 'Untitled';
    const authorEl = children(entry, 'author')[0];
    const author =
      childText(entry, 'dc:creator') ||
      (authorEl && (childText(authorEl, 'name') || authorEl.textContent.trim())) ||
      '';

    const rawSummary = childText(entry, 'content:encoded', 'description', 'summary', 'content', 'media:description');
    const looksLikeHTML = /<\/?[a-z][\s\S]*>/i.test(rawSummary);
    const summaryHTML = looksLikeHTML ? rawSummary : rawSummary ? `<p>${escapeHTML(rawSummary)}</p>` : '';

    items.push({
      id: canonicalId(link),
      title: itemTitle,
      link,
      author: stripTags(author).replace(/^by\s+/i, ''),
      publishDate: parseDate(childText(entry, 'pubDate', 'dc:date', 'published', 'updated', 'dcterms:created')),
      summaryHTML,
      summaryText: stripTags(rawSummary),
      imageCandidates: imageCandidates(entry, link),
    });
  }
  return { title, items };
}
