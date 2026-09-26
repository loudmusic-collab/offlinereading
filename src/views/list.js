import { getAllArticles, getMeta } from '../lib/db.js';
import { startSync, state, subscribe } from '../state.js';
import { BlobUrls, esc, timeAgo } from '../ui/dom.js';
import { icons } from '../ui/icons.js';
import { attachPullToRefresh } from '../ui/pull-to-refresh.js';

// Survives navigation to an article and back.
const view = { filter: 'all', source: null, scrollY: 0 };

function sourceHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function storyItem(a, blobs) {
  const thumb = blobs.get(a.thumbnailBlob || a.heroImageBlob);
  const initials = a.feedSource
    .split(/\s+/)
    .filter((w) => !/^the$/i.test(w))
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
  const unread = a.readStatus !== 'read';
  return `
    <li class="story ${unread ? 'unread' : 'read'}">
      <a href="#/article/${encodeURIComponent(a.id)}">
        <div class="story-text">
          <p class="story-source">${unread ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(a.feedSource)}</p>
          <h2 class="story-title">${esc(a.title)}</h2>
          <p class="story-meta">
            <time datetime="${new Date(a.publishDate).toISOString()}">${esc(timeAgo(a.publishDate))}</time>
            ${a.extracted ? '' : '<span class="badge">Summary</span>'}
            <span class="sr-only">${unread ? 'Unread' : 'Read'}</span>
          </p>
        </div>
        ${
          thumb
            ? `<img class="thumb" src="${thumb}" alt="" loading="lazy" decoding="async">`
            : `<div class="thumb thumb-placeholder" style="--hue:${sourceHue(a.feedSource)}" aria-hidden="true">${esc(initials)}</div>`
        }
      </a>
    </li>`;
}

export function renderList(root) {
  const blobs = new BlobUrls();
  root.innerHTML = `
    <header class="topbar">
      <h1 class="brand">${icons.news}<span>Offline News</span></h1>
      <div class="topbar-actions">
        <button class="btn btn-primary sync-btn" type="button">${icons.sync}<span>Sync now</span></button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${icons.settings}</a>
      </div>
    </header>
    <div class="offline-banner" role="status">${icons.offline}<span>Offline — reading saved stories only</span></div>
    <div class="sync-status" hidden>
      <div class="progress"><span></span></div>
      <p class="sync-label" aria-live="polite"></p>
    </div>
    <div class="ptr" aria-hidden="true"><span class="ptr-icon">${icons.arrowDown}</span><span class="ptr-label">Pull to sync</span></div>
    <main class="list-main">
      <div class="filters" role="toolbar" aria-label="Filter stories"></div>
      <ul class="story-list"></ul>
      <div class="empty" hidden></div>
    </main>`;

  const syncBtn = root.querySelector('.sync-btn');
  const status = root.querySelector('.sync-status');
  const bar = root.querySelector('.progress span');
  const label = root.querySelector('.sync-label');
  const filters = root.querySelector('.filters');
  const list = root.querySelector('.story-list');
  const empty = root.querySelector('.empty');

  syncBtn.addEventListener('click', startSync);

  let articles = [];
  let lastSync = null;

  function paintList() {
    blobs.revokeAll();
    const sources = [...new Set(articles.map((a) => a.feedSource))].sort();
    if (view.source && !sources.includes(view.source)) view.source = null;
    const unreadCount = articles.filter((a) => a.readStatus !== 'read').length;

    filters.innerHTML = `
      <button type="button" class="chip" data-filter="all" aria-pressed="${view.filter === 'all'}">All <span>${articles.length}</span></button>
      <button type="button" class="chip" data-filter="unread" aria-pressed="${view.filter === 'unread'}">Unread <span>${unreadCount}</span></button>
      ${sources.length > 1 ? '<span class="chip-sep" aria-hidden="true"></span>' : ''}
      ${
        sources.length > 1
          ? sources
              .map((s) => `<button type="button" class="chip" data-source="${esc(s)}" aria-pressed="${view.source === s}">${esc(s)}</button>`)
              .join('')
          : ''
      }`;

    const shown = articles.filter(
      (a) => (view.filter === 'all' || a.readStatus !== 'read') && (!view.source || a.feedSource === view.source),
    );
    list.innerHTML = shown.map((a) => storyItem(a, blobs)).join('');

    empty.hidden = shown.length > 0;
    if (!articles.length) {
      empty.innerHTML = `
        <h2>No stories saved yet</h2>
        <p>${state.online ? 'Tap <strong>Sync now</strong> (or pull down) to download today’s news for offline reading.' : 'Connect to the internet and sync to download stories.'}</p>
        ${lastSync ? '' : '<p class="hint">Tip: install this app to your home screen so it opens even in airplane mode.</p>'}`;
    } else if (!shown.length) {
      empty.innerHTML = `<h2>All caught up</h2><p>No unread stories${view.source ? ` from ${esc(view.source)}` : ''}.</p>`;
    }
  }

  function paintStatus() {
    syncBtn.disabled = state.syncing || !state.online;
    syncBtn.classList.toggle('spinning', state.syncing);
    syncBtn.querySelector('span').textContent = state.syncing ? 'Syncing…' : 'Sync now';
    status.hidden = !state.syncing;
    if (state.progress) {
      const { done, total, label: text, phase } = state.progress;
      label.textContent = text;
      const pct = phase === 'feeds' ? 5 + (done / Math.max(total, 1)) * 10 : phase === 'articles' ? 15 + (done / Math.max(total, 1)) * 80 : phase === 'cleanup' ? 98 : 3;
      bar.style.width = `${pct}%`;
    }
    if (!state.syncing && lastSync) label.textContent = '';
  }

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.filter) view.filter = chip.dataset.filter;
    if (chip.dataset.source !== undefined) view.source = view.source === chip.dataset.source ? null : chip.dataset.source;
    paintList();
  });

  async function load() {
    [articles, lastSync] = await Promise.all([getAllArticles(), getMeta('lastSync')]);
    paintList();
  }

  let seenVersion = state.storiesVersion;
  const unsubscribe = subscribe(() => {
    paintStatus();
    if (state.storiesVersion !== seenVersion) {
      seenVersion = state.storiesVersion;
      load();
    }
  });

  const detachPtr = attachPullToRefresh(root.querySelector('.ptr'), {
    onRefresh: startSync,
    canRefresh: () => state.online && !state.syncing,
  });

  paintStatus();
  load().then(() => window.scrollTo(0, view.scrollY));

  return () => {
    view.scrollY = window.scrollY;
    unsubscribe();
    detachPtr();
    blobs.revokeAll();
  };
}
