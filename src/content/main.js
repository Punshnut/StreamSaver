/**
 * content/main.js
 *
 * Content-script entry point. Injected by the browser into every Twitch page
 * that matches the manifest's content_scripts declaration.
 *
 * Responsibilities:
 *   1. Guard-checks the hostname — bail immediately on non-Twitch pages.
 *   2. Calls bindCommandPort() to register the chrome.runtime message listener
 *      so the popup can send setQuality / probe requests to this tab.
 *   3. Calls bootEnforcementLoop() to attach storage/navigation/focus event
 *      listeners that keep quality aligned with the active mode at all times.
 *   4. Queues the initial enforcement round so quality is set as soon as the
 *      player is ready after page load.
 *   5. Runs a non-blocking startup probe to verify the player root appears
 *      within 3 s (for debug visibility only — does not block anything).
 */

import { debug, awaitSignal } from './utils.js';
import { getPlayerRoot } from './player.js';
import { bootEnforcementLoop, bindCommandPort } from './setup.js';
import { queueEnforcementRound } from './enforcement.js';
import { TIMINGS } from './constants.js';

// Guard: run only on twitch.tv hosts.
if (location.hostname.endsWith('twitch.tv')) {
  debug('Loaded on Twitch page', location.href);

  bindCommandPort();
  bootEnforcementLoop();
  queueEnforcementRound('initial-load', {
    force: true,
    delayMs: TIMINGS.SPAWN_DELAY_MS
  });

  // Startup probe for visible player readiness.
  awaitSignal(() => getPlayerRoot().ok, {
    timeoutMs: 3000,
    intervalMs: 150,
    description: 'visible player root'
  }).then((result) => {
    if (result.ok) {
      debug('Startup check passed', result.details);
    } else {
      debug('Startup check pending/no player yet', result.details);
    }
  });
}
