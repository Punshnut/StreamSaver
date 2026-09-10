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

/** True when the tab is both visible and actually focused — the only state in
 *  which a body click is safe, and the only state in which a stuck menu is
 *  actually visible to the user (so it's the only state where giving up early
 *  on removing the hider is dangerous). */
function isTabFocused() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Repeatedly sweeps for open menus, polling between rounds, until either the
 * menus are confirmed gone (returns true) or `rounds` attempts are exhausted
 * (returns false). Re-checks `hiderRefCount` between rounds so a concurrent
 * automation call that re-acquires the shield takes over cleanly.
 */
async function attemptMenuClose({ allowBodyClick, rounds, pollMs = 400 }) {
  for (let round = 0; round < rounds; round += 1) {
    if (hiderRefCount > 0) return false; // a new call re-acquired the shield — not ours to decide anymore

    if (scanMenuRoots().length > 0) {
      await sweepMenus({ allowBodyClick, aggressiveBodyClicks: true, maxAttempts: 2 });
    }

    const deadline = Date.now() + pollMs;
    while (Date.now() < deadline) {
      if (hiderRefCount > 0) return false;
      if (scanMenuRoots().length === 0) return true;
      await wait(60);
    }
  }

  return hiderRefCount > 0 ? false : scanMenuRoots().length === 0;
}

/**
 * Once the ref-count has hit zero, this is the single decision point for
 * whether the hider style can safely be removed. It never removes it while a
 * menu is confirmed open — instead it keeps retrying (focused case: bounded,
 * short-interval retries; unfocused case: wait for the `focus` event, since
 * the user can't see anything until then) until either the menu closes or a
 * newer automation call takes ownership of the shield.
 *  `attemptsSoFar` bounds the focused retry loop so a genuinely broken close
 *  path (e.g. Twitch DOM changed) can't spin forever — after enough focused
 *  attempts it logs and removes the hider as an absolute last resort, since
 *  otherwise it would also end up permanently hiding menus the user opens
 *  manually later.
 */
async function resolveHiderRemoval(attemptsSoFar = 0) {
  if (hiderRefCount > 0) return; // a newer automation call owns the shield now

  if (scanMenuRoots().length === 0) {
    debug('menuHider: hide (menus confirmed closed)', { t: Date.now(), attemptsSoFar });
    document.getElementById('streamsaver-menu-hider')?.remove();
    return;
  }

  if (!isTabFocused()) {
    // Tab isn't visible/focused — the user can't see a stuck menu right now,
    // so there's nothing urgent to retry. Wait for focus to actually return
    // (e.g. the popup closing, or switching back to the tab) before checking again.
    debug('menuHider: deferring hider removal — unfocused with menus still open', { t: Date.now() });
    window.addEventListener('focus', () => {
      (async () => {
        if (hiderRefCount > 0) return;
        await wait(150); // brief settle before sweeping
        // Focus is confirmed now, so a body click is safe (sweepMenus double-checks
        // focus itself right before dispatching one, as extra insurance).
        await attemptMenuClose({ allowBodyClick: true, rounds: 3 });
        await resolveHiderRemoval(0);
      })().catch(() => {});
    }, { once: true });
    return;
  }

  // Focused: the user could see a stuck menu right now, so retry for real
  // (body clicks allowed) instead of giving up after a single pass.
  const closed = await attemptMenuClose({ allowBodyClick: true, rounds: 3 });
  if (hiderRefCount > 0) return;
  if (closed) {
    debug('menuHider: hide (closed via focused retry)', { t: Date.now() });
    document.getElementById('streamsaver-menu-hider')?.remove();
    return;
  }

  const nextAttempts = attemptsSoFar + 1;
  const MAX_FOCUSED_ATTEMPTS = 8; // ~8 rounds of retries (several seconds of backoff) before giving up

  if (nextAttempts >= MAX_FOCUSED_ATTEMPTS) {
    debug('menuHider: menu still open after exhausting focused retries — revealing as last resort', {
      t: Date.now(),
      nextAttempts
    });
    document.getElementById('streamsaver-menu-hider')?.remove();
    return;
  }

  debug('menuHider: menu still open after focused retry round; scheduling another attempt', {
    t: Date.now(),
    nextAttempts
  });
  setTimeout(() => { resolveHiderRemoval(nextAttempts).catch(() => {}); }, 1000);
}

/**
 * Decrements the hider ref-count and, once it reaches zero, verifies menus are
 * actually gone before removing the style — retrying with escalating rounds
 * rather than giving up after a single pass. This ensures a lingering or stuck
 * menu is never revealed to the user when the hider lifts, whether the tab is
 * focused right now or regains focus later (e.g. the popup closing).
 */
export async function liftMenuShield() {
  hiderRefCount = Math.max(0, hiderRefCount - 1);

  // Other callers still hold the shield — don't remove the style yet.
  if (hiderRefCount > 0) return;

  await resolveHiderRemoval(0);
}
