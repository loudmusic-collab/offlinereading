import { DEFAULT_FEEDS, MAX_STORIES, MIN_STORIES } from '../lib/config.js';
import { clearArticles, getAllArticles, getMeta, getSettings, saveSettings } from '../lib/db.js';
import { articleSize, pruneStories } from '../lib/prune.js';
import { storiesChanged, subscribe } from '../state.js';
import { esc, formatBytes, formatDate, hostname, timeAgo } from '../ui/dom.js';
import { icons } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

async function storageStats() {
  const articles = await getAllArticles();
  let text = 0;
  let images = 0;
  for (const a of articles) {
    const imgs = (a.heroImageBlob?.size || 0) + (a.thumbnailBlob?.size || 0) + (a.inlineImages || []).reduce((s, b) => s + (b?.size || 0), 0);
    images += imgs;
    text += Math.max(0, articleSize(a) - imgs);
  }
  let estimate = null;
  let persisted = null;
  try {
    estimate = await navigator.storage?.estimate?.();
    persisted = await navigator.storage?.persisted?.();
  } catch {
    // not supported
  }
  return {
    count: articles.length,
    unread: articles.filter((a) => a.readStatus !== 'read').length,
    text,
    images,
    estimate,
    persisted,
  };
}

export function renderSettings(root) {
  let disposed = false;
  root.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to stories">${icons.back}</a>
      <h1 class="topbar-title">Settings</h1>
      <span class="topbar-spacer"></span>
    </header>
    <div class="offline-banner" role="status">${icons.offline}<span>Offline — changes apply at the next sync</span></div>
    <main class="settings-main">
      <section class="card">
        <h2>Feeds</h2>
        <ul class="feed-list"></ul>
        <form class="add-feed" novalidate>
          <h3>Add a feed</h3>
          <label>Name <input name="name" type="text" placeholder="e.g. Al Jazeera" autocomplete="off"></label>
          <label>RSS or Atom URL <input name="url" type="url" inputmode="url" placeholder="https://example.com/rss.xml" required autocomplete="off"></label>
          <p class="form-error" role="alert"></p>
          <div class="row">
            <button class="btn btn-primary" type="submit">Add feed</button>
            <button class="btn btn-ghost restore-feeds" type="button">Restore defaults</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Downloads</h2>
        <label class="field">
          <span class="field-text"><strong>Maximum stored stories</strong><small>Read stories are removed first, then the oldest unread. Stories older than 7 days are always removed.</small></span>
          <input class="max-stories" type="number" inputmode="numeric" min="${MIN_STORIES}" max="${MAX_STORIES}" step="1">
        </label>
        <label class="field switch-field">
          <span class="field-text"><strong>Download images</strong><small>Turn off to save space and data. Applies to stories downloaded from now on.</small></span>
          <input class="download-images switch" type="checkbox" role="switch">
        </label>
      </section>

      <section class="card">
        <h2>Storage</h2>
        <dl class="stats"></dl>
        <div class="meter" aria-hidden="true"><span></span></div>
        <p class="stats-note muted"></p>
        <div class="row">
          <button class="btn prune-now" type="button">Clean up now</button>
          <button class="btn btn-danger delete-all" type="button">${icons.trash}<span>Delete all stories</span></button>
        </div>
      </section>

      <section class="card about">
        <h2>About</h2>
        <p class="sw-status muted"></p>
        <p class="last-sync muted"></p>
      </section>
    </main>`;

  const $ = (sel) => root.querySelector(sel);
  const feedList = $('.feed-list');
  const form = $('.add-feed');
  const formError = $('.form-error');
  let settings;

  function paintFeeds() {
    feedList.innerHTML = settings.feeds.length
      ? settings.feeds
          .map(
            (f) => `
        <li class="feed" data-id="${esc(f.id)}">
          <label class="feed-toggle">
            <input type="checkbox" class="switch" ${f.enabled ? 'checked' : ''} aria-label="Enable ${esc(f.name)}">
          </label>
          <div class="feed-text">
            <strong>${esc(f.name)}</strong>
            <small title="${esc(f.url)}">${esc(f.url)}</small>
          </div>
          <button class="icon-btn remove-feed" type="button" aria-label="Remove ${esc(f.name)}">${icons.trash}</button>
        </li>`,
          )
          .join('')
      : '<li class="muted">No feeds. Add one below or restore the defaults.</li>';
  }

  async function paintStats() {
    const s = await storageStats();
    if (disposed) return;
    const total = s.text + s.images;
    $('.stats').innerHTML = `
      <div><dt>Stories</dt><dd>${s.count} <small>(${s.unread} unread)</small></dd></div>
      <div><dt>Article text</dt><dd>${formatBytes(s.text)}</dd></div>
      <div><dt>Images</dt><dd>${formatBytes(s.images)}</dd></div>
      <div class="total"><dt>Total used</dt><dd>${formatBytes(total)}</dd></div>`;
    const est = s.estimate;
    const meter = $('.meter span');
    if (est?.quota) {
      meter.style.width = `${Math.min(100, Math.max(1, (est.usage / est.quota) * 100))}%`;
      $('.stats-note').textContent = `Browser reports ${formatBytes(est.usage)} used of ${formatBytes(est.quota)} available to this app${
        s.persisted ? ' · protected from automatic cleanup' : ''
      }.`;
    } else {
      $('.meter').hidden = true;
      $('.stats-note').textContent = '';
    }
  }

  async function paintAbout() {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const lastSync = await getMeta('lastSync');
    if (disposed) return;
    $('.sw-status').textContent = reg?.active
      ? '✓ App is installed for offline use — it opens without a connection.'
      : 'Offline app shell not installed yet (it installs automatically on first load over HTTPS).';
    $('.last-sync').textContent = lastSync ? `Last synced ${timeAgo(lastSync)} (${formatDate(lastSync)}).` : 'Not synced yet.';
  }

  async function save(patch, message = 'Saved') {
    settings = await saveSettings(patch);
    toast(message, { duration: 1500 });
  }

  feedList.addEventListener('change', async (e) => {
    const li = e.target.closest('.feed');
    if (!li) return;
    const feeds = settings.feeds.map((f) => (f.id === li.dataset.id ? { ...f, enabled: e.target.checked } : f));
    await save({ feeds });
  });

  feedList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.remove-feed');
    if (!btn) return;
    const id = btn.closest('.feed').dataset.id;
    const feed = settings.feeds.find((f) => f.id === id);
    await save({ feeds: settings.feeds.filter((f) => f.id !== id) }, `Removed ${feed.name}`);
    paintFeeds();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';
    const data = new FormData(form);
    const raw = String(data.get('url') || '').trim();
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) throw new Error();
    } catch {
      formError.textContent = 'Enter a valid http(s) feed URL.';
      return;
    }
    if (settings.feeds.some((f) => f.url === url.href)) {
      formError.textContent = 'That feed is already in the list.';
      return;
    }
    const name = String(data.get('name') || '').trim() || hostname(url.href);
    const feed = { id: `feed-${Date.now().toString(36)}`, name, url: url.href, enabled: true };
    await save({ feeds: [...settings.feeds, feed] }, `Added ${name}`);
    form.reset();
    paintFeeds();
  });

  $('.restore-feeds').addEventListener('click', async () => {
    const custom = settings.feeds.filter((f) => !DEFAULT_FEEDS.some((d) => d.id === f.id));
    await save({ feeds: [...DEFAULT_FEEDS, ...custom] }, 'Default feeds restored');
    paintFeeds();
  });

  const maxInput = $('.max-stories');
  maxInput.addEventListener('change', async () => {
    const value = Math.round(Number(maxInput.value));
    if (!Number.isFinite(value) || value < MIN_STORIES || value > MAX_STORIES) {
      toast(`Choose between ${MIN_STORIES} and ${MAX_STORIES} stories`);
      maxInput.value = settings.maxStories;
      return;
    }
    await save({ maxStories: value });
    const removed = await pruneStories();
    if (removed) {
      toast(`Saved · removed ${removed} ${removed === 1 ? 'story' : 'stories'} over the new limit`);
      storiesChanged();
    }
  });

  $('.download-images').addEventListener('change', (e) => save({ downloadImages: e.target.checked }));

  $('.prune-now').addEventListener('click', async () => {
    const removed = await pruneStories();
    toast(removed ? `Removed ${removed} ${removed === 1 ? 'story' : 'stories'}` : 'Nothing to clean up');
    storiesChanged();
  });

  $('.delete-all').addEventListener('click', async () => {
    if (!confirm('Delete all saved stories from this device?')) return;
    await clearArticles();
    toast('All stories deleted');
    storiesChanged();
  });

  const unsubscribe = subscribe(() => paintStats());

  (async () => {
    settings = await getSettings();
    if (disposed) return;
    paintFeeds();
    maxInput.value = settings.maxStories;
    $('.download-images').checked = settings.downloadImages;
    // Enable switch animations only after the initial state is painted.
    requestAnimationFrame(() => requestAnimationFrame(() => root.querySelector('.settings-main')?.classList.add('ready')));
    paintStats();
    paintAbout();
  })();

  window.scrollTo(0, 0);
  return () => {
    disposed = true;
    unsubscribe();
  };
}

