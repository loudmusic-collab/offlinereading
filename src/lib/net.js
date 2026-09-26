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
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}
