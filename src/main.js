import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { state, subscribe } from './state.js';
import { toast } from './ui/toast.js';
import { renderArticle } from './views/article.js';
import { renderList } from './views/list.js';
import { renderSettings } from './views/settings.js';

const app = document.getElementById('app');
let cleanup = null;

function route() {
  cleanup?.();
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, section, param] = hash.match(/^\/([^/]*)\/?(.*)$/) || [];
  if (section === 'article' && param) cleanup = renderArticle(app, decodeURIComponent(param));
  else if (section === 'settings') cleanup = renderSettings(app);
  else cleanup = renderList(app);
}

window.addEventListener('hashchange', route);
route();

const paintConnectivity = () => document.body.classList.toggle('is-offline', !state.online);
subscribe(paintConnectivity);
paintConnectivity();

// While offline, stop links to the original site from even trying the network.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="http"]');
  if (link && !state.online) {
    e.preventDefault();
    toast("You're offline — the original page will open once you reconnect.");
  }
});

if ('serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onOfflineReady() {
      toast('Ready to work offline');
    },
  });
}
