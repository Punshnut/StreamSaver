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
