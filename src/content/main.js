import { debug, waitForCondition } from './utils.js';
import { getPlayerRoot } from './player.js';
import { setupAutomaticModeEnforcement, setupMessageHandler } from './setup.js';
import { scheduleEnsureDesiredQualityForCurrentMode } from './enforcement.js';

// Guard: run only on twitch.tv hosts.
if (location.hostname.endsWith('twitch.tv')) {
  debug('Loaded on Twitch page', location.href);

  setupMessageHandler();
  setupAutomaticModeEnforcement();
  scheduleEnsureDesiredQualityForCurrentMode('initial-load', {
    force: true,
    delayMs: 900
  });

  // Startup probe for visible player readiness.
  waitForCondition(() => getPlayerRoot().ok, {
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
