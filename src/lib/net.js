// The only module in the app that touches the network. Everything goes
// through the same-origin proxy, and nothing is attempted while offline.
import { PROXY_ENDPOINT } from './config.js';

export class OfflineError extends Error {
  constructor() {
    super('You are offline');
    this.name = 'OfflineError';
  }
}

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** The request never reached our proxy function (hosting auth page, outage, captive portal…). */
export class ProxyUnreachableError extends Error {
  constructor(status) {
    super(
      status === 401 || status === 403
        ? `The sync service refused the request (HTTP ${status}). If this is a protected Netlify branch or preview deploy, open the site in your browser and sign in, or deploy it as the production site.`
        : status === 200
          ? 'The sync service returned an unexpected page. If you’re on Wi-Fi that needs a sign-in page, open a browser to sign in first.'
          : `The sync service is unavailable (HTTP ${status}). Try again in a minute.`,
    );
    this.name = 'ProxyUnreachableError';
    this.status = status;
  }
}

export function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function proxyUrl(url) {
  return `${PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`;
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

/** Fetch a remote URL through the proxy. Throws OfflineError without touching the network when offline. */
export async function fetchViaProxy(url, { signal, timeout = 20000 } = {}) {
  if (!isOnline()) throw new OfflineError();
  signal?.throwIfAborted();
  const res = await fetch(proxyUrl(url), { signal: withTimeout(signal, timeout), cache: 'no-store' });
  if (!res.headers.has('x-offline-news-proxy')) throw new ProxyUnreachableError(res.status);
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}
