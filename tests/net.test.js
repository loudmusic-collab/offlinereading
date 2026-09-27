import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, ProxyUnreachableError, fetchViaProxy } from '../src/lib/net.js';
import { PROXY_MARKER } from '../server/proxy.js';

const respond = (status, headers = {}) => vi.fn(async () => new Response('x', { status, headers }));

describe('fetchViaProxy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports publisher refusals as HttpError', async () => {
    vi.stubGlobal('fetch', respond(401, { [PROXY_MARKER]: '1' }));
    await expect(fetchViaProxy('https://news.example/a')).rejects.toBeInstanceOf(HttpError);
  });

  it('reports responses that never reached the proxy (e.g. hosting auth) as ProxyUnreachableError', async () => {
    vi.stubGlobal('fetch', respond(401));
    const err = await fetchViaProxy('https://news.example/a').catch((e) => e);
    expect(err).toBeInstanceOf(ProxyUnreachableError);
    expect(err.message).toMatch(/sign in|production/);
  });

  it('treats an unmarked 200 (captive portal) as unreachable too', async () => {
    vi.stubGlobal('fetch', respond(200));
    await expect(fetchViaProxy('https://news.example/a')).rejects.toBeInstanceOf(ProxyUnreachableError);
  });

  it('returns marked successful responses', async () => {
    vi.stubGlobal('fetch', respond(200, { [PROXY_MARKER]: '1' }));
    expect((await fetchViaProxy('https://news.example/a')).status).toBe(200);
  });
});
