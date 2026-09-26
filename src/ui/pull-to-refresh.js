// Minimal pull-to-refresh for the story list. The browser's own overscroll
// refresh is disabled in CSS (overscroll-behavior-y: contain) so it can't
// reload the page instead.

const THRESHOLD = 70;
const MAX_PULL = 110;

export function attachPullToRefresh(indicator, { onRefresh, canRefresh = () => true }) {
  let startY = null;
  let pull = 0;

  const label = indicator.querySelector('.ptr-label');
  const set = (distance) => {
    pull = distance;
    indicator.style.height = `${distance}px`;
    indicator.classList.toggle('ready', distance >= THRESHOLD);
    if (label) {
      label.textContent = !canRefresh()
        ? "You're offline"
        : distance >= THRESHOLD
          ? 'Release to sync'
          : 'Pull to sync';
    }
  };

  const onStart = (e) => {
    startY = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  };
  const onMove = (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) {
      if (pull) set(0);
      return;
    }
    e.preventDefault();
    indicator.classList.add('pulling');
    set(Math.min(MAX_PULL, dy * 0.5));
  };
  const onEnd = () => {
    if (startY === null) return;
    startY = null;
    indicator.classList.remove('pulling');
    const trigger = pull >= THRESHOLD && canRefresh();
    set(0);
    if (trigger) onRefresh();
  };

  window.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onEnd);
  window.addEventListener('touchcancel', onEnd);
  return () => {
    window.removeEventListener('touchstart', onStart);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onEnd);
    window.removeEventListener('touchcancel', onEnd);
  };
}
