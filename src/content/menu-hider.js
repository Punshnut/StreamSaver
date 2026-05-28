import { debug, wait } from './utils.js';
import { scanMenuRoots } from './menu-find.js';
import { sweepMenus } from './menu-close.js';

// Ref-count for the menu hider. deployMenuShield increments, liftMenuShield decrements.
// The style is only removed when the count reaches zero AND menus are confirmed closed,
// so back-to-back automation calls (detect → set) share one continuous hider lifetime.
let hiderRefCount = 0;

/** Injects a CSS rule that makes Twitch player menus visually invisible while the
 *  extension interacts with them.
 *  - clip-path:inset(100%) — clips painted area to zero (invisible, non-hittable) while
 *                            preserving the full CSS layout box. getBoundingClientRect()
 *                            and offsetWidth/offsetHeight return real values, so all
 *                            JS-driven visibility and geometry checks still work correctly
 *                            in every browser including Firefox.
 *  - pointer-events:none  — belt-and-suspenders: lets document.elementFromPoint() see
 *                            through to the player below, required for sweepMenus's
 *                            player-area click fallback to find a valid click target. */
export function deployMenuShield() {
  hiderRefCount++;
  debug('menuHider: show', { count: hiderRefCount, t: Date.now() });
  if (document.getElementById('streamsaver-menu-hider')) return;
  const style = document.createElement('style');
  style.id = 'streamsaver-menu-hider';
  style.textContent =
    '[role="menu"],[role="listbox"],' +
    '[data-a-target*="settings-menu" i],' +
    '[data-a-target*="dropdown-menu" i],[data-test-selector*="menu" i],' +
    '[class*="settings-menu" i]{clip-path:inset(100%)!important;pointer-events:none!important;}';
  document.head.appendChild(style);
}

/** Decrements the hider ref-count and, once it reaches zero, polls until menus are
 *  confirmed gone before removing the style. This ensures a lingering or stuck menu is
 *  never revealed to the user when the hider lifts. Hard timeout: 800 ms. */
export async function liftMenuShield() {
  hiderRefCount = Math.max(0, hiderRefCount - 1);
  if (hiderRefCount > 0) return;
  // If menus are still open, make one extra close attempt. pointer-events:none is still
  // active here, so document.elementFromPoint() sees through the invisible menu to the
  // player — this is the path that was failing at channel-join time.
  // Only allow a player-area body click when the window is actually focused;
  // an unfocused body click lands on Twitch's play/pause overlay and toggles
  // VOD/stream playback state.
  if (scanMenuRoots().length > 0) {
    const canBodyClick = document.visibilityState === 'visible' && document.hasFocus();
    await sweepMenus({ allowBodyClick: canBodyClick, aggressiveBodyClicks: true, maxAttempts: 2 });
  }
  // Poll briefly to confirm menus are gone before lifting the hider.
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    if (hiderRefCount > 0) return;
    if (scanMenuRoots().length === 0) break;
    await wait(60);
  }
  if (hiderRefCount > 0) return;

  // If the window is not focused and menus are still open, keep the hider CSS
  // active so the user never sees a stuck quality menu when they tab back in.
  // Schedule a safe cleanup pass (no body click) for when focus returns.
  if (scanMenuRoots().length > 0 && (!document.hasFocus() || document.visibilityState !== 'visible')) {
    debug('menuHider: deferring hider removal — unfocused with menus still open', { t: Date.now() });
    const onFocus = async () => {
      if (hiderRefCount > 0) return; // a new automation took ownership
      await wait(150);
      await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 3 });
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        if (hiderRefCount > 0) return;
        if (scanMenuRoots().length === 0) break;
        await wait(60);
      }
      if (hiderRefCount > 0) return;
      debug('menuHider: hide (deferred, on focus)', { t: Date.now() });
      document.getElementById('streamsaver-menu-hider')?.remove();
    };
    window.addEventListener('focus', () => { onFocus().catch(() => {}); }, { once: true });
    return;
  }

  debug('menuHider: hide (lock lifted)', { t: Date.now() });
  document.getElementById('streamsaver-menu-hider')?.remove();
}
