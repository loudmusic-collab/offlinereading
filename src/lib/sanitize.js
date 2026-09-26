// Allow-list HTML sanitizer. Article HTML comes from arbitrary websites, so it
// is reduced to a small set of text-formatting tags with almost no attributes.
// It also removes every reference to a remote resource: images are either
// collected for download (and replaced by data-offline-img="n" placeholders),
// or dropped. The stored HTML therefore can't trigger a network request.

const KEEP = new Set([
  'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'q', 'cite', 'abbr', 'time',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'img', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'div', 'section', 'article',
]);

// Removed together with their contents.
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'label', 'fieldset',
  'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area',
  'link', 'meta', 'base', 'head', 'title', 'nav', 'header', 'footer', 'aside', 'dialog',
]);

const ALLOWED_ATTRS = {
  a: ['href', 'title'],
  img: ['alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'reversed'],
  abbr: ['title'],
  time: ['datetime'],
};

function resolve(url, base) {
  try {
    return base ? new URL(url, base).href : new URL(url).href;
  } catch {
    return null;
  }
}

function parseSrcset(srcset) {
  return srcset
    .split(/,\s+(?=\S)/)
    .map((part) => {
      const [url, descriptor = ''] = part.trim().split(/\s+/);
      const w = descriptor.endsWith('w') ? parseInt(descriptor, 10) : descriptor.endsWith('x') ? parseFloat(descriptor) * 600 : 0;
      return { url, w: w || 0 };
    })
    .filter((c) => c.url);
}

/** Best download URL for an <img>, preferring a srcset entry around 1000px wide. */
export function pickImageSource(img, base) {
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    const cands = parseSrcset(srcset).sort((a, b) => a.w - b.w);
    const pick = cands.find((c) => c.w >= 900) || cands[cands.length - 1];
    const url = pick && resolve(pick.url, base);
    if (url && /^https?:/.test(url)) return url;
  }
  for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'src']) {
    const value = img.getAttribute(attr);
    if (!value || value.startsWith('data:')) continue;
    const url = resolve(value, base);
    if (url && /^https?:/.test(url)) return url;
  }
  return null;
}

function isTrackingPixel(img) {
  const w = img.getAttribute('width');
  const h = img.getAttribute('height');
  return (w && Number(w) <= 2) || (h && Number(h) <= 2);
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function removeComments(node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8) node.removeChild(child);
    else if (child.nodeType === 1) removeComments(child);
  }
}

/**
 * @param {string} html
 * @param {object} opts
 * @param {string} [opts.baseUrl]  URL used to resolve relative links and images
 * @param {'collect'|'strip'|'refs'} [opts.images]
 *   collect: replace <img> with numbered placeholders and return their URLs
 *   strip:   remove all images
 *   refs:    keep only existing data-offline-img placeholders (render time)
 * @param {number} [opts.maxImages]
 * @returns {{ html: string, images: string[], text: string }}
 */
export function sanitizeHTML(html, { baseUrl, images = 'strip', maxImages = 6 } = {}) {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html || ''}</body></html>`, 'text/html');
  const body = doc.body;
  removeComments(body);
  const collected = [];

  for (const el of Array.from(body.querySelectorAll('*'))) {
    if (!el.parentNode) continue; // inside an already-dropped subtree
    const tag = el.tagName.toLowerCase();

    if (DROP.has(tag)) {
      el.parentNode.removeChild(el);
      continue;
    }
    if (tag === 'h1') {
      // The article title is rendered separately; demote in-body h1s.
      const h2 = doc.createElement('h2');
      while (el.firstChild) h2.appendChild(el.firstChild);
      el.parentNode.replaceChild(h2, el);
      continue;
    }
    if (!KEEP.has(tag)) {
      unwrap(el);
      continue;
    }

    let offlineRef = null;
    let imageUrl = null;
    if (tag === 'img') {
      offlineRef = el.getAttribute('data-offline-img');
      if (images === 'collect' && !isTrackingPixel(el)) imageUrl = pickImageSource(el, baseUrl);
    }

    for (const attr of Array.from(el.attributes)) {
      if (!(ALLOWED_ATTRS[tag] || []).includes(attr.name)) el.removeAttribute(attr.name);
    }

    if (tag === 'a') {
      const href = el.getAttribute('href');
      const abs = href && resolve(href, baseUrl);
      if (abs && /^(https?|mailto):/i.test(abs)) {
        el.setAttribute('href', abs);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      } else {
        el.removeAttribute('href');
      }
    }

    if (tag === 'img') {
      if (images === 'collect' && imageUrl && collected.length < maxImages) {
        let index = collected.indexOf(imageUrl);
        if (index === -1) index = collected.push(imageUrl) - 1;
        el.setAttribute('data-offline-img', String(index));
      } else if (images === 'refs' && offlineRef && /^\d+$/.test(offlineRef)) {
        el.setAttribute('data-offline-img', offlineRef);
      } else {
        el.parentNode.removeChild(el);
      }
    }
  }

  // Drop figures left with nothing but a caption, and empty paragraphs.
  for (const fig of Array.from(body.querySelectorAll('figure'))) {
    if (!fig.querySelector('img')) fig.parentNode?.removeChild(fig);
  }
  for (const p of Array.from(body.querySelectorAll('p, div, section'))) {
    if (!p.textContent.trim() && !p.querySelector('img')) p.parentNode?.removeChild(p);
  }

  return { html: body.innerHTML.trim(), images: collected, text: body.textContent.replace(/\s+/g, ' ').trim() };
}
