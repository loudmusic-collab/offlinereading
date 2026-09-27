import { describe, expect, it } from 'vitest';
import { handleProxy, isPrivateAddress } from '../server/proxy.js';

const call = (target, fetchImpl, opts = {}) =>
  handleProxy(new Request(`http://app.local/api/fetch?url=${encodeURIComponent(target)}`), { fetchImpl, ...opts });

describe('proxy', () => {
  it('blocks private and loopback targets', async () => {
    for (const target of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://[::1]/', 'http://10.1.2.3/', 'http://169.254.169.254/latest']) {
      const res = await call(target, () => {
        throw new Error('should not fetch');
      });
      expect(res.status).toBe(403);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true);
  });

  it('rejects non-http schemes and missing urls', async () => {
    expect((await call('file:///etc/passwd')).status).toBe(400);
    expect((await handleProxy(new Request('http://app.local/api/fetch'))).status).toBe(400);
  });

  it('relays html with the final url after redirects', async () => {
    const fetchImpl = async (url) =>
      url === 'http://1.1.1.1/a'
        ? new Response(null, { status: 301, headers: { location: '/b' } })
        : new Response('<html>ok</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const res = await call('http://1.1.1.1/a', fetchImpl);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-final-url')).toBe('http://1.1.1.1/b');
    expect(res.headers.get('x-offline-news-proxy')).toBe('1');
    expect(await res.text()).toBe('<html>ok</html>');
  });

  it('refuses redirects into private networks', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://192.168.0.1/' } });
    expect((await call('http://1.1.1.1/', fetchImpl)).status).toBe(403);
  });

  it('refuses unsupported content types and oversized bodies', async () => {
    const pdf = async () => new Response('x', { headers: { 'content-type': 'application/pdf' } });
    expect((await call('http://1.1.1.1/', pdf)).status).toBe(415);
    const huge = async () =>
      new Response(new Uint8Array(6 * 1024 * 1024), { headers: { 'content-type': 'image/png' } });
    expect((await call('http://1.1.1.1/', huge)).status).toBe(413);
  });

  it('passes upstream error statuses through', async () => {
    const blocked = async () => new Response('no', { status: 403, headers: { 'content-type': 'text/html' } });
    const res = await call('http://1.1.1.1/', blocked);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-offline-news-proxy')).toBe('1'); // publisher refusal, not ours
  });
});
