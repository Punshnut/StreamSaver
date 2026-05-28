/**
 * content/fullscreen.js
 *
 * Fullscreen state detection and restoration helpers.
 *
 * isBrowserInFullscreen()
 *   Returns true when the Fullscreen API reports an active element. Used by
 *   enforcement.js and setup.js to prevent quality automation from running while
 *   the player is in fullscreen (menu interactions cause Twitch to exit fullscreen).
 *
 * findTwitchFullscreenButton()
 *   Locates the fullscreen toggle button inside the player by scanning for
 *   "fullscreen" or "vollbild" in aria-label, title, and data-a-target.
 *
 * attemptRestoreTwitchFullscreen()
 *   Called by setup.js when the fullscreen lost event was triggered by the
 *   extension's own DOM interactions (detected via arenaState.userIntended +
 *   missionState timing). Deliberately uses Twitch's own button rather than
 *   the Fullscreen API directly, because a direct requestFullscreen() call
 *   causes a partial layout glitch (bottom ~20 % dark, player shifted up).
 *   Falls back to requestFullscreen() only when the button cannot be found.
 */

import { debug, wait, isElementVisible, stealthClick } from './utils.js';
import { getPlayerRoot, wakePlayerControls } from './player.js';

/** Returns true when the browser's fullscreen API has an active element. */
export function isBrowserInFullscreen() {
  // webkit prefix for Safari and older Chrome.
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Finds the Twitch fullscreen toggle button inside the player.
 * Returns the element or null if not found.
 */
export function findTwitchFullscreenButton() {
  const result = getPlayerRoot();
  if (!result.ok || !result.details?.element) {
    return null; // no player — can't find its buttons
  }
  const playerRoot = result.details.element;

  for (const btn of Array.from(playerRoot.querySelectorAll('button, [role="button"]'))) {
    if (!isElementVisible(btn)) {
      continue; // skip hidden buttons (e.g. controls bar not yet revealed)
    }
    // Combine all text attributes into one searchable string.
    const combined = [
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || '',
      btn.getAttribute('data-a-target') || ''
    ].join(' ').toLowerCase();

    // "fullscreen" (English) or "vollbild" (German).
    if (combined.includes('fullscreen') || combined.includes('vollbild')) {
      return btn;
    }
  }
  return null; // no matching button found
}

/**
 * Attempts to restore browser fullscreen after the extension accidentally
 * caused Twitch to drop from fullscreen to cinema/theater mode.
 * Tries requestFullscreen() on the player directly first; falls back to
 * clicking Twitch's "Enter Fullscreen" button.
 */
export async function attemptRestoreTwitchFullscreen() {
  // Bail immediately if already in fullscreen — nothing to restore.
  if (isBrowserInFullscreen()) {
    debug('fullscreen restore: already in fullscreen, nothing to do');
    return;
  }

  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok || !playerRootResult.details?.element) {
    debug('fullscreen restore: player not found');
    return;
  }
  const playerRoot = playerRootResult.details.element;

  // Hover to reveal controls, then click Twitch's own fullscreen button.
  // Letting Twitch handle the requestFullscreen() call internally ensures it uses
  // the right element and applies the correct layout — direct API calls cause a
  // partial layout glitch (bottom ~20% dark, player shifted up).
  wakePlayerControls(playerRoot);
  await wait(600); // give Twitch time to show the controls bar after hover

  const btn = findTwitchFullscreenButton();
  if (!btn) {
    // Button not found — fall back to calling the Fullscreen API directly.
    // This path produces the layout glitch but is better than not restoring at all.
    debug('fullscreen restore: fullscreen button not found, falling back to requestFullscreen()');
    try {
      const requestFn = playerRoot.requestFullscreen?.bind(playerRoot)
        || playerRoot.webkitRequestFullscreen?.bind(playerRoot);
      if (requestFn) {
        await requestFn();
        debug('fullscreen restore: requestFullscreen() fallback succeeded');
      }
    } catch (err) {
      debug('fullscreen restore: requestFullscreen() fallback also failed', String(err));
    }
    return;
  }

  // If the Fullscreen API still reports fullscreen, Twitch's internal model
  // considers itself in fullscreen — don't click the button or we'll exit again.
  if (isBrowserInFullscreen()) {
    debug('fullscreen restore: already in fullscreen per API, skipping click');
    return;
  }

  debug('fullscreen restore: clicking button to restore', { label: btn.getAttribute('aria-label') });
  stealthClick(btn, { prepare: false }); // prepare:false — controls are already visible
}
