import { AD_INDICATOR_SELECTORS } from './constants.js';

/** Returns true when a Twitch ad is currently visible in the player. */
export function isAdCurrentlyPlaying() {
  return AD_INDICATOR_SELECTORS.some((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return false;
    if (el.offsetParent !== null) return true;
    // position:fixed elements always have offsetParent===null; check their painted size instead.
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}
