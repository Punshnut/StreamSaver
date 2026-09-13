/**
 * content/user-gear-guard.js
 *
 * Detects a genuine (isTrusted) user click on Twitch's real settings gear
 * button and immediately gets automation out of the way, so a user opening
 * the menu themselves is never left staring at an invisible/dead overlay
 * while sweepMenus() tries to close it out from under them.
 *
 * Every synthetic click the extension makes (stealthClick()'s element.click(),
 * or the manually constructed MouseEvents in menu-close.js's outside-click
 * fallback) is inherently isTrusted:false — a real user gesture is always
 * isTrusted:true. That's a reliable signal with no new instrumentation needed.
 *
 * installUserGearClickGuard() — registers the capture-phase listener; call once at boot.
 */

import { missionState } from './constants.js';
import { getPlayerRoot, mapControlZones, huntSettingsTriggers } from './player.js';
import { forceRevealMenuShield } from './menu-hider.js';
import { debug } from './utils.js';

/** True when `target` is (or is inside) the current best settings-gear candidate. */
function isSettingsGearClick(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    return false;
  }
  const playerRoot = playerRootResult.details.element;

  const controlScopes = mapControlZones(playerRoot);
  const candidates = huntSettingsTriggers(playerRoot, controlScopes);
  return candidates.some((candidate) => candidate.element === target || candidate.element.contains(target));
}

/**
 * Registers a capture-phase pointerdown listener that fires ahead of Twitch's
 * own handlers. On a real click on the settings gear: marks a user menu as
 * open (reusing the same missionState.userMenuOpen flag Guard 5.5 already
 * checks before starting new automation rounds, and that watchUserMenuActivity()
 * already resumes automation from once the menu closes) and force-reveals the
 * hider immediately rather than waiting for the normal close/retry path.
 */
export function installUserGearClickGuard() {
  document.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted) {
      return; // one of our own synthetic interactions — ignore
    }
    if (!isSettingsGearClick(event.target)) {
      return;
    }

    debug('user-gear-guard: real user click on settings gear detected — standing down');
    missionState.userMenuOpen = true;
    forceRevealMenuShield();
  }, true);
}
