import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { handleProxy } from './server/proxy.js';

// Serves /api/fetch from `vite` and `vite preview` with the same handler the
// Netlify function uses, so local development behaves like production.
function proxyMiddleware() {
  const allowPrivate = process.env.PROXY_ALLOW_PRIVATE === '1';
  const middleware = async (req, res, next) => {
    if (!req.url.startsWith('/api/fetch')) return next();
    try {
      const request = new Request(new URL(req.url, 'http://localhost'), { method: req.method });
      const response = await handleProxy(request, { allowPrivate });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  };
  return {
    name: 'offline-news-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// Production CSP: only same-origin requests (the app shell and /api/fetch) and
// blob:/data: images. Even if a remote URL slipped past the sanitizer, the
// browser would refuse to load it — reading never touches the network.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function cspPlugin() {
  return {
    name: 'offline-news-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  plugins: [
    proxyMiddleware(),
    cspPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: 'Offline News Reader',
        short_name: 'Offline News',
        description: 'Download the news while online, read it anywhere — even in airplane mode.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f5f0',
        theme_color: '#1f3a5f',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the whole app shell. Nothing else is cached by the service
        // worker: article data lives in IndexedDB, and /api/fetch must never be
        // served stale or intercepted.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [],
      },
    }),
  ],
});
