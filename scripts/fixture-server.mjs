// A tiny stand-in "news site" for offline testing: serves an RSS feed, article
// pages (a normal one, a lazy-image one, a bot wall, a 403) and PNG images.
// Usage: node scripts/fixture-server.mjs [port]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

function png(width, height, seed) {
  const hue = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const [r0, g0, b0] = hsl(hue, 0.55, 0.45);
  const [r1, g1, b1] = hsl((hue + 40) % 360, 0.6, 0.75);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r0 + (r1 - r0) * t;
      raw[o + 1] = g0 + (g1 - g0) * t;
      raw[o + 2] = b0 + (b1 - b0) * t;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255].map(Math.round);
}

export function startFixtureServer(port = 4599) {
  const origin = `http://127.0.0.1:${port}`;
  const now = Date.now();
  const fixture = (name) =>
    readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), 'utf8')
      .replaceAll('{{ORIGIN}}', origin)
      .replace(/\{\{DATE(\d)\}\}/g, (_, n) => new Date(now - Number(n) * 3600e3).toUTCString());

  const pages = {
    '/news/articles/tides': 'article-full.html',
    '/news/articles/night-trains': 'article-lazy.html',
    '/news/articles/botwall': 'article-botwall.html',
    '/wire/defences': 'article-full.html',
    '/wire/timetable': 'article-lazy.html',
  };
  const hits = [];

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, origin);
    hits.push(pathname);
    if (pathname === '/feed.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      return res.end(fixture('feed.xml'));
    }
    if (pathname === '/atom.xml') {
      res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
      return res.end(fixture('feed.atom'));
    }
    if (pages[pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fixture(pages[pathname]));
    }
    if (pathname.startsWith('/blocked/')) {
      res.writeHead(403, { 'content-type': 'text/html' });
      return res.end('<h1>Forbidden</h1>');
    }
    if (pathname.startsWith('/img/')) {
      const small = /thumb|small/.test(pathname);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(png(small ? 240 : 1600, small ? 135 : 900, pathname));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ origin, hits, close: () => new Promise((r) => server.close(r)) })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await startFixtureServer(Number(process.argv[2]) || 4599);
  console.log(`Fixture news site on ${origin}/feed.xml`);
}
