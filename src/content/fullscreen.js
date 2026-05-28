import { debug, wait, isElementVisible, stealthClick } from './utils.js';
import { getPlayerRoot, wakePlayerControls } from './player.js';

/** Returns true when the browser's fullscreen API has an active element. */
export function isBrowserInFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Finds the Twitch fullscreen toggle button inside the player.
 * Returns the element or null if not found.
 */
export function findTwitchFullscreenButton() {
  const result = getPlayerRoot();
  if (!result.ok || !result.details?.element) {
    return null;
  }
  const playerRoot = result.details.element;
  for (const btn of Array.from(playerRoot.querySelectorAll('button, [role="button"]'))) {
    if (!isElementVisible(btn)) {
      continue;
    }
    const combined = [
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || '',
      btn.getAttribute('data-a-target') || ''
    ].join(' ').toLowerCase();
    if (combined.includes('fullscreen') || combined.includes('vollbild')) {
      return btn;
    }
  }
  return null;
}

/**
 * Attempts to restore browser fullscreen after the extension accidentally
 * caused Twitch to drop from fullscreen to cinema/theater mode.
 * Tries requestFullscreen() on the player directly first; falls back to
 * clicking Twitch's "Enter Fullscreen" button.
 */
export async function attemptRestoreTwitchFullscreen() {
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
  await wait(600);

  const btn = findTwitchFullscreenButton();
  if (!btn) {
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

  const combined = [
    btn.getAttribute('aria-label') || '',
    btn.getAttribute('title') || ''
  ].join(' ').toLowerCase();

  // 'exit' / 'beenden' means Twitch already considers itself in fullscreen — skip.
  if (combined.includes('exit') || combined.includes('beenden')) {
    debug('fullscreen restore: button is in exit-fullscreen state, skipping');
    return;
  }

  debug('fullscreen restore: clicking button to restore', { label: btn.getAttribute('aria-label') });
  stealthClick(btn, { prepare: false });
}
