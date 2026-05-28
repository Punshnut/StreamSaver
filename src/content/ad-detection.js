/**
 * content/ad-detection.js
 *
 * Detects whether a Twitch ad is currently playing in the active player.
 *
 * isAdLive()
 *   Queries the DOM for any of the known ad indicator selectors defined in
 *   constants.js (ad banner text, countdown overlay, picture-in-picture player).
 *   Returns true as soon as any indicator is present and painted.
 *
 *   The position:fixed fallback handles elements that always have
 *   offsetParent===null regardless of visibility — for those, we check
 *   computed styles and getBoundingClientRect instead.
 *
 *   Called by enforcement.js before opening menus (to avoid interrupting
 *   an ad break) and by automation.js as a mid-flow guard.
 *   The enforcement loop starts a 2 s interval poll whenever an ad is
 *   detected, so quality is re-applied immediately after the ad ends.
 */

import { AD_INDICATOR_SELECTORS } from './constants.js';

/** Returns true when a Twitch ad is currently visible in the player. */
export function isAdLive() {
  return AD_INDICATOR_SELECTORS.some((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return false; // selector not present at all — no ad

    // offsetParent is non-null for most visible elements — the fast path.
    if (el.offsetParent !== null) return true;

    // position:fixed elements always have offsetParent===null regardless of
    // visibility, so we can't use that to rule them out. Fall back to computed
    // style + bounding rect to confirm they're actually painted.
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0; // only counts if it has a painted size
  });
}
