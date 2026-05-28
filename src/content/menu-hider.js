/**
 * content/menu-hider.js
 *
 * CSS-based menu invisibility layer that prevents the user from seeing the
 * quality menu while the extension is programmatically opening and closing it.
 *
 * Problem: without hiding, the user sees brief flashes of the Twitch settings
 * overlay every time the extension enforces quality. The original approach used
 * filter:opacity(0), but that broke Firefox's getBoundingClientRect — elements
 * inside a filter:opacity ancestor return a 0×0 rect even when laid out,
 * causing all visibility checks to fail.
 *
 * Solution: clip-path:inset(100%) clips the painted area to zero (fully
 * invisible and non-clickable) while leaving the CSS layout box intact.
 * offsetWidth/offsetHeight still return the real dimensions, so every JS-side
 * geometry and usability check works correctly in both Chrome and Firefox.
 * pointer-events:none is added as belt-and-suspenders so elementFromPoint()
 * sees through the hidden menu to the player beneath.
 *
 * Ref-counted to handle nested / overlapping automation calls:
 *   deployMenuShield() — increments the ref-count, injects the <style> tag
 *   liftMenuShield()   — decrements the ref-count, waits for menus to close,
 *                        then removes the <style> tag when the count hits zero
 */

import { debug, wait } from './utils.js';
import { scanMenuRoots } from './menu-find.js';
import { sweepMenus } from './menu-close.js';

// Ref-count for the menu hider. deployMenuShield increments, liftMenuShield decrements.
// The style is only removed when the count reaches zero AND menus are confirmed closed,
// so back-to-back automation calls (detect → set) share one continuous hider lifetime.
let hiderRefCount = 0;

/**
 * Injects a CSS rule that makes Twitch player menus visually invisible while the
 * extension interacts with them.
 *  - clip-path:inset(100%) — clips the painted area to zero while leaving the CSS layout box
 *                            intact, so offsetWidth/Height and getBoundingClientRect still
 *                            return real values and all JS visibility checks keep working.
 *                            Replaces the old filter:opacity(0) approach, which caused Firefox
 *                            to return 0×0 BCRs for elements inside a filtered ancestor
 *                            (see isElementVisible() in utils.js for the full explanation).
 *  - pointer-events:none  — lets document.elementFromPoint() see through to the player below,
 *                            which sweepMenus's outside-click fallback needs.
 */
export function deployMenuShield() {
  hiderRefCount++;
  debug('menuHider: show', { count: hiderRefCount, t: Date.now() });

  // Only create the <style> tag once — subsequent calls just bump the ref count.
  if (document.getElementById('streamsaver-menu-hider')) return;

  const style = document.createElement('style');
  style.id = 'streamsaver-menu-hider';
  // Target all known menu container patterns in one rule block.
  style.textContent =
    '[role="menu"],[role="listbox"],' +
    '[data-a-target*="settings-menu" i],' +
    '[data-a-target*="dropdown-menu" i],[data-test-selector*="menu" i],' +
    '[class*="settings-menu" i]{clip-path:inset(100%)!important;pointer-events:none!important;}';
  document.head.appendChild(style);
}

/**
 * Decrements the hider ref-count and, once it reaches zero, polls until menus are
 * confirmed gone before removing the style. This ensures a lingering or stuck menu is
 * never revealed to the user when the hider lifts. Hard timeout: 800 ms.
 */
export async function liftMenuShield() {
  hiderRefCount = Math.max(0, hiderRefCount - 1);

  // Other callers still hold the shield — don't remove the style yet.
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
  // We don't want to reveal a partially-closed menu to the user.
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    if (hiderRefCount > 0) return; // a new automation call re-acquired the shield
    if (scanMenuRoots().length === 0) break; // menus are gone — safe to lift
    await wait(60);
  }

  // Re-check after the poll loop — a concurrent call may have bumped the count.
  if (hiderRefCount > 0) return;

  // Edge case: window lost focus while we were waiting. Keep the hider CSS active
  // so the user never sees a stuck quality menu when they tab back in.
  // Schedule a safe cleanup pass (no body click) for when focus returns.
  if (scanMenuRoots().length > 0 && (!document.hasFocus() || document.visibilityState !== 'visible')) {
    debug('menuHider: deferring hider removal — unfocused with menus still open', { t: Date.now() });
    const onFocus = async () => {
      if (hiderRefCount > 0) return; // a new automation took ownership — let it manage the hider
      await wait(150); // brief settle before sweeping
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
    // { once: true } ensures the handler removes itself after firing.
    window.addEventListener('focus', () => { onFocus().catch(() => {}); }, { once: true });
    return;
  }

  debug('menuHider: hide (lock lifted)', { t: Date.now() });
  document.getElementById('streamsaver-menu-hider')?.remove();
}
