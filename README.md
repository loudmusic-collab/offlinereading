# Offline News Reader

A mobile-first PWA that downloads full article text and images while you're online, stores them in IndexedDB, and lets you read them with **zero network access** — airplane mode included.

- **Stack:** Vite + vanilla JS, [`idb`](https://github.com/jakearchibald/idb), [`@mozilla/readability`](https://github.com/mozilla/readability), `vite-plugin-pwa` (Workbox) for the service worker, and a Netlify Function as the fetch proxy.
- **Deploy target:** Netlify (static `dist/` + one function at `/api/fetch`).

## Features

| | |
|---|---|
| **Feeds** | BBC News, The Guardian, Reuters, NY Times, AP by default. You can add, remove or toggle feeds in Settings. RSS 2.0, RSS 1.0/RDF and Atom are supported. |
| **Sync now** | Button or pull-to-refresh. Fetches each feed, downloads each article through the proxy, runs Readability and falls back to the RSS summary if extraction fails. It also downloads the hero image and up to 6 inline images, resized to JPEG, plus a thumbnail. Progress shows as "Downloading 12 of 40…". |
| **Story list** | Thumbnail, title, source, relative date, unread dot, day headings, All/Unread and per-source filters. A "Summary" badge marks stories where only the feed summary was saved. |
| **Reader** | Serif typography, adjustable text size, images rendered from stored blobs, marked as read when opened (you can mark it unread again), and a notice explaining why a story is summary-only. |
| **Settings** | Manage feeds, set the maximum stored stories (default 50) and toggle image downloads. It also shows storage in use (text vs images, plus the browser's quota estimate), with "Clean up now" and "Delete all" buttons. |
| **Offline shell** | The service worker precaches the whole app shell, so the app opens with no connectivity. |
| **Auto-prune** | Runs after every sync and on app start. See [Storage limits](#storage-limits). |

## Getting started

```bash
npm install
npm run dev          # http://localhost:5173 — /api/fetch served by a Vite middleware
npm test             # unit tests (vitest + linkedom + fake-indexeddb)
npm run e2e          # build + end-to-end offline test in Chromium (Playwright)
npm run verify:feed -- https://feeds.bbci.co.uk/news/rss.xml 5   # try the pipeline on a real feed from Node
```

The service worker only runs on production builds (`npm run build && npm run preview`), not in `vite dev`.

### Deploying to Netlify

Connect the repo in Netlify, or run `netlify deploy --build`. `netlify.toml` already sets:

- build command `npm run build`, publish dir `dist`
- functions dir `netlify/functions`. `fetch.mjs` uses the Functions v2 API and declares `path: "/api/fetch"`, so no redirect rule is needed.
- `no-cache` headers for `sw.js` / the manifest, and immutable caching for hashed assets

Any static host works for the front end, as long as something answers `GET /api/fetch?url=…` the same way `server/proxy.js` does. The handler is a plain `Request → Response` function and ports to Vercel or Cloudflare with a few lines.

## How it works

```
Sync (online only)
  feed URL ──► /api/fetch ──► parseFeed()            src/lib/feeds.js
  article  ──► /api/fetch ──► extractArticle()        src/lib/extract.js  (Readability)
                   │               └─ fails / too short / bot wall ──► RSS summary
                   └──► sanitizeHTML()                src/lib/sanitize.js (allow-list; images → placeholders)
  images   ──► /api/fetch ──► resizeImage()           src/lib/images.js   (≤1200px JPEG, 240px thumbnail)
  record   ──► IndexedDB `articles` store             src/lib/db.js
  then     ──► pruneStories()                         src/lib/prune.js

Read (always offline-capable)
  service worker precache ──► app shell
  IndexedDB ──► story list / reader; <img data-offline-img="n"> ──► blob: URLs
```

### Stored record

`articles` store, keyed by `id` (the article URL without tracking parameters, so a story that appears in two feeds is stored once):

`id, title, author, publishDate, feedSource, articleHTML, heroImageBlob, syncedAt, readStatus`, plus `link`, `feedId`, `extracted`, `extractionNote`, `thumbnailBlob`, `inlineImages[]` and `sizeBytes`.

### Zero network in airplane mode

Several independent layers enforce this:

1. `src/lib/net.js` is the only module that calls `fetch`, and it refuses to do so when `navigator.onLine` is false. A sync in progress is aborted as soon as the `offline` event fires.
2. Stored HTML contains no remote URLs. The sanitizer drops `src`/`srcset`, iframes, video, styles and scripts, and replaces images with `data-offline-img` indexes that resolve to blobs. It runs again at render time.
3. The production build ships a Content-Security-Policy with `img-src 'self' blob: data:` and `connect-src 'self'`. Even a URL that slipped through could not be loaded.
4. No web fonts or CDNs; all icons are inline SVG.
5. While offline, taps on "Read on …" links are intercepted rather than attempted.

`npm run e2e` checks this directly. It syncs fixture feeds, **kills both the app server and the news-site server**, puts Chromium offline and reloads. It then asserts that the app, 5 stories and their images render, that no request went past the service worker, and that nothing failed.

### Extraction failures

Publishers often block scrapers with 401/403/429, bot walls, paywalls or consent pages. A story falls back to the feed summary when any of these happen:

- the proxy returns a non-2xx status
- Readability finds nothing
- the extracted text is under 600 characters
- the text looks like a bot check

The reader shows a yellow **Summary only** note with the reason, and the list shows a "Summary" badge. You never get an empty or broken article.

### Storage limits

- Stories older than **7 days** are deleted, read or not. Stories already older than that are never downloaded.
- Over the **max story count**, deletion order is **read stories oldest-first, then unread oldest-first**, so unread stories survive longer.
- The same order applies under **storage pressure**: a hard 250 MB app budget, tightened to stay under 80% of the quota from `navigator.storage.estimate()`.
- Images are downscaled before storage (hero ≤1200px, inline ≤1000px, thumbnail 240px, JPEG q≈0.8). A typical story costs roughly 100–300 KB with images, or 5–30 KB without.
- After a sync the app calls `navigator.storage.persist()` so the browser doesn't evict stories.

### The proxy (`server/proxy.js`)

`GET /api/fetch?url=<encoded>` fetches server-side and returns the raw bytes. It sets `x-final-url` after redirects, which the client uses to resolve relative links. Because it's a public endpoint, it has guard rails:

- http(s) only, and no credentials in the URL
- hostnames must resolve to public IPs, re-checked on every redirect; this blocks SSRF into `localhost`, RFC1918 and cloud metadata addresses
- only HTML, XML/RSS/Atom and `image/*` responses are relayed
- a 5 MB cap and a 9 s timeout
- no CORS headers, so other websites can't use it from a browser

It is still a fetcher anyone can call directly. If that matters for your deployment, add a host allow-list or rate limiting in front of it.

`PROXY_ALLOW_PRIVATE=1` disables the private-IP check for local testing against the fixture server. Never set it in production.

## Default feeds — caveats

| Source | URL | Notes |
|---|---|---|
| BBC News | `https://feeds.bbci.co.uk/news/rss.xml` | Official. Articles usually extract well. |
| The Guardian | `https://www.theguardian.com/world/rss` | Official. Articles usually extract well. |
| NY Times | `https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` | Official. Paywalled pages often fall back to the summary. |
| Reuters | `https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best` | **Reuters discontinued its public RSS feeds in 2020.** This is the Reuters Agency WordPress feed and may change or disappear. Reuters article pages are heavily bot-protected, so expect summaries. |
| AP News | `https://rsshub.app/apnews/topics/apf-topnews` | **AP has no official public RSS feed.** This goes through the public RSSHub instance, which is rate-limited. For reliability, self-host RSSHub or swap in another feed. AP pages are often bot-protected. |

A feed that fails doesn't stop the sync. The list shows which feeds couldn't be reached and why.

## Project layout

```
index.html                 app shell
src/main.js                router (#/, #/article/:id, #/settings), SW registration
src/state.js               sync/online state + startSync()
src/lib/                   config, net, feeds, extract, sanitize, images, db, prune, sync
src/views/                 list, article, settings
src/ui/                    icons, toast, pull-to-refresh, DOM helpers
server/proxy.js            fetch proxy (shared by Netlify + Vite middleware)
netlify/functions/fetch.mjs
scripts/e2e-offline.mjs    Playwright offline end-to-end test
scripts/fixture-server.mjs local fake news site (RSS, Atom, articles, 403, bot wall, images)
scripts/verify-feed.mjs    run the pipeline on a real feed from Node
scripts/make-icons.mjs     rasterise public/icons/icon.svg into PNG icons
tests/                     unit tests + fixtures
```
