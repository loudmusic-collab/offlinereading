// Fetch proxy shared by the Netlify function (production) and the Vite
// dev/preview middleware (local). It takes ?url=, fetches it server-side and
// streams back the raw bytes so the browser never has to deal with CORS.
//
// Guard rails (this is a public endpoint, so it must not become an open relay
// into private networks or a way to pull arbitrary large files):
//   - http/https only, no credentials in the URL
//   - hostnames must resolve to public IPs (checked again on every redirect)
//   - only HTML / XML (RSS, Atom) / image responses are relayed
//   - responses are capped at MAX_BYTES and upstream calls time out
//   - no CORS headers are added, so other sites can't use it from a browser

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MAX_BYTES = 5 * 1024 * 1024; // Netlify's buffered response limit is 6 MB
const TIMEOUT_MS = 9000;
const MAX_REDIRECTS = 5;

const ALLOWED_TYPES = [
  /^text\/html/i,
  /^application\/xhtml\+xml/i,
  /^(application|text)\/(rss\+|atom\+|rdf\+)?xml/i,
  /^image\//i,
];

// Marks every response that really came from this handler, so the client can
// tell "the publisher refused" apart from "something in front of the proxy
// (e.g. hosting-level password protection) refused before we ran".
export const PROXY_MARKER = 'x-offline-news-proxy';

const UPSTREAM_HEADERS = {
  // A mainstream UA: several publishers serve an empty shell to unknown bots.
  'user-agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36 OfflineNewsReader/1.0',
  accept:
    'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,image/avif,image/webp,image/*;q=0.8,*/*;q=0.5',
  'accept-language': 'en-GB,en;q=0.9',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [PROXY_MARKER]: '1' },
  });
}

export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) || // fc00::/7 unique local
      /^fe[89ab]/.test(lower) || // fe80::/10 link local
      /^ff/.test(lower) // multicast
    );
  }
  return true;
}

async function assertPublicUrl(url, allowPrivate) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('Only http and https URLs are allowed'), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error('Credentials in URLs are not allowed'), { status: 400 });
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw Object.assign(new Error('Host not allowed'), { status: 403 });
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error('Host not allowed'), { status: 403 });
  }
}

async function readCapped(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('Response too large'), { status: 413 });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * @param {Request} request
 * @param {{ allowPrivate?: boolean, fetchImpl?: typeof fetch }} [options]
 *   allowPrivate is for local development/tests against fixture servers only.
 */
export async function handleProxy(request, { allowPrivate = false, fetchImpl = fetch } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: 'Method not allowed' });
  }
  const target = new URL(request.url).searchParams.get('url');
  if (!target || target.length > 2048) return json(400, { error: 'Missing or oversized ?url=' });

  let url;
  try {
    url = new URL(target);
  } catch {
    return json(400, { error: 'Invalid URL' });
  }

  try {
    let upstream;
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(url, allowPrivate);
      upstream = await fetchImpl(url.href, {
        headers: UPSTREAM_HEADERS,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return json(508, { error: 'Too many redirects' });
        await upstream.body?.cancel().catch(() => {});
        url = new URL(location, url);
        continue;
      }
      break;
    }

    const type = upstream.headers.get('content-type') || '';
    if (upstream.ok && !ALLOWED_TYPES.some((re) => re.test(type))) {
      await upstream.body?.cancel().catch(() => {});
      return json(415, { error: `Unsupported content type: ${type || 'unknown'}` });
    }
    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      return json(413, { error: 'Response too large' });
    }

    const body = upstream.body ? await readCapped(upstream.body, MAX_BYTES) : new Uint8Array();
    return new Response(request.method === 'HEAD' ? null : body, {
      // Pass the upstream status through so the client can tell "blocked"
      // (401/403/429) apart from a proxy failure.
      status: upstream.status,
      headers: {
        'content-type': type || 'application/octet-stream',
        'x-final-url': url.href,
        [PROXY_MARKER]: '1',
        'cache-control': upstream.ok ? 'public, max-age=300' : 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 502);
    return json(status, { error: err.message || 'Upstream fetch failed' });
  }
}
