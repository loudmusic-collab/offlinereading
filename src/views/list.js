import { APP_NAME, CATEGORIES, CATEGORY_BY_ID, categoryOf } from '../lib/config.js';
import { getAllArticles, getMeta, getSettings } from '../lib/db.js';
import { startSync, state, subscribe } from '../state.js';
import { BlobUrls, esc, timeAgo } from '../ui/dom.js';
import { icons } from '../ui/icons.js';
import { attachPullToRefresh } from '../ui/pull-to-refresh.js';

// The "All" tab: a slate that reads well with white text in light and dark mode.
const ALL_COLOR = '#475569';

// Survives navigation to an article and back.
const view = { category: 'all', filter: 'all', source: null, scrollY: 0 };

function sourceHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function dayLabel(ms, now = new Date()) {
  const d = new Date(ms);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

function syncReport(result) {
  if (!result) return '';
  const bits = [`${result.added} new`];
  if (result.fallback) bits.push(`${result.fallback} summary-only`);
  if (result.skipped) bits.push(`${result.skipped} skipped (no full text)`);
  if (result.pruned) bits.push(`${result.pruned} cleaned up`);
  const failed = result.failedFeeds.map((f) => `<li><strong>${esc(f.name)}</strong> — ${esc(f.error)}</li>`).join('');
  return `<p>Last sync: ${bits.join(' · ')}</p>${failed ? `<p>Couldn’t reach:</p><ul>${failed}</ul>` : ''}`;
}

function storyItem(a, blobs, showCategory) {
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
          <p class="story-source">${unread ? '<span class="dot" aria-hidden="true"></span>' : ''}${
            showCategory
              ? `<span class="story-cat" style="--cat:${CATEGORY_BY_ID[a.category].color}">${esc(CATEGORY_BY_ID[a.category].label)}</span><span aria-hidden="true">·</span>`
              : ''
          }${esc(a.feedSource)}</p>
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
      <h1 class="brand">${icons.news}<span>${esc(APP_NAME)}</span></h1>
      <div class="topbar-actions">
        <button class="icon-btn sync-btn" type="button" aria-label="Sync now" title="Sync now">${icons.sync}</button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${icons.settings}</a>
      </div>
    </header>
    <nav class="cat-tabs" aria-label="Categories"></nav>
    <div class="offline-banner" role="status">${icons.offline}<span>Offline — reading saved stories only</span></div>
    <div class="sync-status" hidden>
      <div class="progress"><span></span></div>
      <p class="sync-label" aria-live="polite"></p>
    </div>
    <div class="ptr" aria-hidden="true"><span class="ptr-icon">${icons.arrowDown}</span><span class="ptr-label">Pull to sync</span></div>
    <main class="list-main">
      <div class="filters" role="toolbar" aria-label="Filter stories"></div>
      <p class="list-updated"></p>
      <div class="sync-report" hidden></div>
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
  const updated = root.querySelector('.list-updated');
  const report = root.querySelector('.sync-report');
  const tabs = root.querySelector('.cat-tabs');

  syncBtn.addEventListener('click', startSync);

  let articles = [];
  let lastSync = null;
  let tabIds = ['all'];

  function paintTabs() {
    const active = CATEGORY_BY_ID[view.category];
    tabs.style.setProperty('--active', active ? active.color : ALL_COLOR);
    tabs.innerHTML = tabIds
      .map((id) => {
        const cat = CATEGORY_BY_ID[id];
        const label = cat ? cat.label : 'All';
        const color = cat ? cat.color : ALL_COLOR;
        const count = articles.filter((a) => (id === 'all' || a.category === id) && a.readStatus !== 'read').length;
        return `<button type="button" class="cat-tab" data-cat="${id}" style="--cat:${color}" aria-pressed="${view.category === id}">${esc(label)}${
          count ? `<span class="cat-count">${count}</span>` : ''
        }</button>`;
      })
      .join('');
    const current = tabs.querySelector('[aria-pressed="true"]');
    if (current) tabs.scrollLeft = current.offsetLeft - (tabs.clientWidth - current.offsetWidth) / 2;
  }

  function setCategory(id) {
    if (id === view.category || !tabIds.includes(id)) return;
    view.category = id;
    view.source = null;
    paintList();
    window.scrollTo(0, 0);
  }

  function paintList() {
    blobs.revokeAll();
    if (!tabIds.includes(view.category)) view.category = 'all';
    paintTabs();
    const inCategory = articles.filter((a) => view.category === 'all' || a.category === view.category);
    const sources = [...new Set(inCategory.map((a) => a.feedSource))].sort();
    if (view.source && !sources.includes(view.source)) view.source = null;
    const unreadCount = inCategory.filter((a) => a.readStatus !== 'read').length;

    filters.innerHTML = `
      <button type="button" class="chip" data-filter="all" aria-pressed="${view.filter === 'all'}">All <span>${inCategory.length}</span></button>
      <button type="button" class="chip" data-filter="unread" aria-pressed="${view.filter === 'unread'}">Unread <span>${unreadCount}</span></button>
      ${sources.length > 1 ? '<span class="chip-sep" aria-hidden="true"></span>' : ''}
      ${
        sources.length > 1
          ? sources
              .map((s) => `<button type="button" class="chip" data-source="${esc(s)}" aria-pressed="${view.source === s}">${esc(s)}</button>`)
              .join('')
          : ''
      }`;

    const shown = inCategory.filter(
      (a) => (view.filter === 'all' || a.readStatus !== 'read') && (!view.source || a.feedSource === view.source),
    );
    let lastGroup = null;
    list.innerHTML = shown
      .map((a) => {
        const group = dayLabel(a.publishDate);
        const heading = group !== lastGroup ? `<li class="day-heading" role="presentation">${esc(group)}</li>` : '';
        lastGroup = group;
        return heading + storyItem(a, blobs, view.category === 'all');
      })
      .join('');

    updated.textContent = lastSync ? `Updated ${timeAgo(lastSync)}` : '';
    const failures = state.lastResult?.failedFeeds.length;
    report.hidden = !failures;
    report.innerHTML = failures ? syncReport(state.lastResult) : '';

    empty.hidden = shown.length > 0;
    if (!articles.length) {
      empty.innerHTML = `
        <h2>No stories saved yet</h2>
        <p>${state.online ? 'Tap <strong>Sync now</strong> (or pull down) to download today’s news for offline reading.' : 'Connect to the internet and sync to download stories.'}</p>
        ${lastSync ? '' : '<p class="hint">Tip: install this app to your home screen so it opens even in airplane mode.</p>'}`;
    } else if (!inCategory.length) {
      const label = CATEGORY_BY_ID[view.category]?.label || '';
      empty.innerHTML = `<h2>No ${esc(label)} stories yet</h2><p>They’ll appear here after the next sync.</p>`;
    } else if (!shown.length) {
      empty.innerHTML = `<h2>All caught up</h2><p>No unread stories${view.source ? ` from ${esc(view.source)}` : ''}.</p>`;
    }
  }

  function paintStatus() {
    syncBtn.disabled = state.syncing || !state.online;
    syncBtn.classList.toggle('spinning', state.syncing);
    syncBtn.setAttribute('aria-label', state.syncing ? 'Syncing…' : 'Sync now');
    status.hidden = !state.syncing;
    if (state.progress) {
      const { done, total, label: text, phase } = state.progress;
      label.textContent = text;
      const pct = phase === 'feeds' ? 5 + (done / Math.max(total, 1)) * 10 : phase === 'articles' ? 15 + (done / Math.max(total, 1)) * 80 : phase === 'cleanup' ? 98 : 3;
      bar.style.width = `${pct}%`;
    }
  }

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.filter) view.filter = chip.dataset.filter;
    if (chip.dataset.source !== undefined) view.source = view.source === chip.dataset.source ? null : chip.dataset.source;
    paintList();
  });

  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.cat-tab');
    if (tab) setCategory(tab.dataset.cat);
  });

  // Swipe left/right on the story list to move between category tabs.
  let swipe = null;
  const onSwipeStart = (e) => {
    const t = e.touches[0];
    swipe = e.touches.length === 1 && !e.target.closest('.cat-tabs, .filters') ? { x: t.clientX, y: t.clientY } : null;
  };
  const onSwipeEnd = (e) => {
    if (!swipe) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const i = tabIds.indexOf(view.category);
    const next = tabIds[i + (dx < 0 ? 1 : -1)];
    if (next) setCategory(next);
  };
  const main = root.querySelector('.list-main');
  main.addEventListener('touchstart', onSwipeStart, { passive: true });
  main.addEventListener('touchend', onSwipeEnd, { passive: true });

  async function load() {
    const [all, sync, settings] = await Promise.all([getAllArticles(), getMeta('lastSync'), getSettings()]);
    const feedsById = Object.fromEntries(settings.feeds.map((f) => [f.id, f]));
    articles = all.map((a) => ({ ...a, category: categoryOf(a, feedsById) }));
    lastSync = sync;
    // Tabs: categories with a quota, plus any that still hold stories.
    const withStories = new Set(articles.map((a) => a.category));
    tabIds = ['all', ...CATEGORIES.filter((c) => settings.categoryQuotas[c.id] > 0 || withStories.has(c.id)).map((c) => c.id)];
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
