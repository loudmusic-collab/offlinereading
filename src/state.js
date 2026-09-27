// Tiny app-wide store for sync progress and connectivity.
import { OfflineError, isOnline } from './lib/net.js';
import { syncNow } from './lib/sync.js';
import { toast } from './ui/toast.js';

export const state = {
  online: isOnline(),
  syncing: false,
  progress: null,
  storiesVersion: 0, // bumped whenever stories are added or removed
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

export function storiesChanged() {
  state.storiesVersion++;
  emit();
}

window.addEventListener('online', () => {
  state.online = true;
  emit();
});
window.addEventListener('offline', () => {
  state.online = false;
  emit();
});

function summarise(r) {
  const parts = [r.added ? `${r.added} new ${r.added === 1 ? 'story' : 'stories'}` : 'No new stories'];
  if (r.fallback) parts.push(`${r.fallback} summary-only`);
  if (r.skipped) parts.push(`${r.skipped} skipped (no full text)`);
  if (r.failedFeeds.length) parts.push(`${r.failedFeeds.map((f) => f.name).join(', ')} unavailable`);
  return parts.join(' · ');
}

export async function startSync() {
  if (state.syncing) return;
  if (!isOnline()) {
    toast("You're offline — connect to download new stories.");
    return;
  }
  state.syncing = true;
  state.progress = { phase: 'start', done: 0, total: 0, label: 'Starting sync…' };
  emit();
  try {
    const result = await syncNow({
      onProgress(p) {
        state.progress = p;
        emit();
      },
    });
    state.lastResult = result;
    toast(summarise(result), { duration: 5000 });
    // Ask the browser not to evict our stories under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
  } catch (err) {
    console.error(err);
    toast(
      err instanceof OfflineError
        ? 'Connection lost — sync stopped. Everything already downloaded is saved.'
        : `Sync failed: ${err.message}`,
      { duration: 5000 },
    );
  } finally {
    state.syncing = false;
    state.progress = null;
    storiesChanged();
  }
}
