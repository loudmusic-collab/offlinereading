import { getArticle, setReadStatus } from '../lib/db.js';
import { sanitizeHTML } from '../lib/sanitize.js';
import { storiesChanged } from '../state.js';
import { BlobUrls, esc, formatDate, hostname } from '../ui/dom.js';
import { icons } from '../ui/icons.js';

/** Swap data-offline-img placeholders for blob: URLs from IndexedDB; drop any without a stored image. */
function hydrateImages(container, images, blobs) {
  for (const img of container.querySelectorAll('img[data-offline-img]')) {
    const blob = images?.[Number(img.dataset.offlineImg)];
    if (blob) {
      img.src = blobs.get(blob);
      img.loading = 'lazy';
      img.decoding = 'async';
    } else {
      const fig = img.closest('figure');
      (fig && fig.querySelectorAll('img').length === 1 ? fig : img).remove();
    }
  }
}

export function renderArticle(root, id) {
  const blobs = new BlobUrls();
  let disposed = false;

  root.innerHTML = `
    <header class="topbar reader-bar">
      <a class="icon-btn" href="#/" aria-label="Back to stories">${icons.back}</a>
      <span class="reader-bar-title"></span>
      <button class="btn btn-ghost read-toggle" type="button" hidden>Mark unread</button>
    </header>
    <div class="offline-banner" role="status">${icons.offline}<span>Offline — this story is saved on your device</span></div>
    <main class="reader-main"><p class="loading">Loading…</p></main>`;

  const main = root.querySelector('main');
  const toggle = root.querySelector('.read-toggle');

  (async () => {
    let article = await getArticle(id);
    if (disposed) return;
    if (!article) {
      main.innerHTML = `<div class="empty"><h2>Story not found</h2><p>It may have been cleaned up to save space.</p><p><a class="btn" href="#/">Back to stories</a></p></div>`;
      return;
    }

    // Mark as read on open.
    if (article.readStatus !== 'read') {
      article = await setReadStatus(id, 'read');
      storiesChanged();
    }

    root.querySelector('.reader-bar-title').textContent = article.feedSource;
    document.title = `${article.title} · Offline News`;

    const hero = blobs.get(article.heroImageBlob);
    // Stored HTML was sanitised at sync time; sanitise again on the way out in
    // case the database was tampered with. Only offline image refs survive.
    const body = sanitizeHTML(article.articleHTML, { images: 'refs' }).html;
    const site = hostname(article.link);

    main.innerHTML = `
      <article class="reader">
        ${hero ? `<figure class="hero"><img src="${hero}" alt=""></figure>` : ''}
        <div class="reader-inner">
          <p class="kicker">${esc(article.feedSource)}</p>
          <h1 class="reader-title">${esc(article.title)}</h1>
          <p class="byline">
            ${article.author ? `<span>By ${esc(article.author)}</span>` : ''}
            <time datetime="${new Date(article.publishDate).toISOString()}">${esc(formatDate(article.publishDate))}</time>
          </p>
          ${
            article.extracted
              ? ''
              : `<div class="notice" role="note"><strong>Summary only.</strong> The full article couldn’t be saved${
                  article.extractionNote ? ` (${esc(article.extractionNote)})` : ''
                }, so this is the summary from the feed.</div>`
          }
          <div class="content">${body || '<p class="muted">No text was available for this story.</p>'}</div>
          <p class="original">
            <a href="${esc(article.link)}" target="_blank" rel="noopener noreferrer">Read on ${esc(site)} ${icons.external}</a>
          </p>
          <p class="saved-note">Saved ${esc(formatDate(article.syncedAt))}</p>
        </div>
      </article>`;
    hydrateImages(main.querySelector('.content'), article.inlineImages, blobs);

    toggle.hidden = false;
    const paintToggle = () => (toggle.textContent = article.readStatus === 'read' ? 'Mark unread' : 'Mark read');
    paintToggle();
    toggle.addEventListener('click', async () => {
      article = await setReadStatus(id, article.readStatus === 'read' ? 'unread' : 'read');
      paintToggle();
      storiesChanged();
    });
  })();

  window.scrollTo(0, 0);
  return () => {
    disposed = true;
    blobs.revokeAll();
    document.title = 'Offline News Reader';
  };
}
