import { missionState, arenaState, STORAGE_KEYS, TIMINGS } from './constants.js';
import { debug } from './utils.js';
import { queueEnforcementRound } from './enforcement.js';
import { routeQualityRequest } from './automation.js';
import { isBrowserInFullscreen, attemptRestoreTwitchFullscreen } from './fullscreen.js';
import { isSupportedTwitchPage, forgeResponse } from './page-support.js';
import { loadPluginEnabledSetting } from './storage.js';

/** Bridges page-support classification into structured step results. */
function getPageSupportState() {
  const support = isSupportedTwitchPage();
  if (!support.supported) {
    return { ok: false, code: 'UNSUPPORTED_PAGE', message: support.reason, details: support.details };
  }
  return { ok: true, code: 'SUPPORTED_PAGE', message: support.reason, details: { support } };
}

/** Sets up the chrome.runtime message handler for popup communication. */
export function bindCommandPort() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
        return forgeResponse(false, 'unknown', 'Invalid message payload.');
      }

      const { action } = message;
      debug('Received message', { action, message, sender });

      const pluginEnabledResult = await loadPluginEnabledSetting();
      if (!pluginEnabledResult.ok) {
        return forgeResponse(false, action, pluginEnabledResult.message, pluginEnabledResult.details);
      }
      if (!pluginEnabledResult.details?.pluginEnabled) {
        return forgeResponse(false, action, 'Plugin logic is disabled. Turn it on in the popup to apply quality changes.', {
          pluginEnabled: false
        });
      }

      const pageSupport = getPageSupportState();
      if (!pageSupport.ok) {
        return forgeResponse(false, action, pageSupport.message, pageSupport);
      }

      if (action === 'setQuality') {
        return routeQualityRequest(message.targetQuality, pageSupport);
      }

      // streamsaverPopupProbe — responds with current page support state
      if (action === 'streamsaverPopupProbe') {
        return forgeResponse(pageSupport.ok, action, pageSupport.message, pageSupport.details);
      }

      return forgeResponse(false, action, `Unknown action: ${action}`);
    })()
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        debug('Unhandled message error', String(error));
        sendResponse(forgeResponse(false, 'unknown', 'Unhandled content script error.', { error: String(error) }));
      });

    return true;
  });
}

/** Registers storage/navigation/focus hooks that keep mode quality enforced. */
export function bootEnforcementLoop() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    const relevantKeys = [STORAGE_KEYS.ACTIVE_MODE, STORAGE_KEYS.FAST_TOGGLE_LOW, STORAGE_KEYS.FAST_TOGGLE_HIGH, STORAGE_KEYS.PLUGIN_ENABLED].filter((key) => {
      return Object.prototype.hasOwnProperty.call(changes, key);
    });
    if (relevantKeys.length === 0) {
      return;
    }

    debug('quality enforcement: storage change detected', {
      keys: relevantKeys
    });
    queueEnforcementRound('storage-change', {
      force: true,
      delayMs: TIMINGS.STORAGE_CHANGE_DELAY_MS
    });
  });

  // Cancel any in-flight ad polling timer before starting fresh (safety for re-init).
  if (missionState.adScanTimerId) {
    clearInterval(missionState.adScanTimerId);
    missionState.adScanTimerId = null;
  }

  // Compare only origin+pathname so query-param-only changes (e.g. Twitch VOD ?t= timestamp
  // updates that fire every ~10 s during playback) are not treated as SPA navigations.
  const getUrlKey = () => location.origin + location.pathname;
  let previousUrl = getUrlKey();
  missionState.urlWatchTimerId = setInterval(() => {
    const currentUrl = getUrlKey();
    if (currentUrl === previousUrl) {
      return;
    }

    const fromUrl = previousUrl;
    previousUrl = currentUrl;
    debug('quality enforcement: twitch SPA navigation detected', {
      fromUrl,
      toUrl: previousUrl
    });
    queueEnforcementRound('spa-navigation', {
      force: true,
      delayMs: TIMINGS.WARP_DELAY_MS
    });
  }, TIMINGS.URL_WATCH_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    debug('quality enforcement: tab became visible');
    queueEnforcementRound('visibility-visible', {
      delayMs: TIMINGS.VISIBILITY_DELAY_MS
    });
  });

  window.addEventListener('focus', () => {
    debug('quality enforcement: window focused');
    // If a force-enforcement was blocked while focus was away (e.g. popup open during
    // a resolution change), replay it as force now so it bypasses cooldown and trust TTL.
    const hadForcePending = missionState.forcePendingAfterFocus;
    missionState.forcePendingAfterFocus = false;
    queueEnforcementRound('window-focus', {
      force: hadForcePending,
      delayMs: TIMINGS.FOCUS_DELAY_MS
    });
  });

  function onFullscreenChange() {
    const isFullscreen = isBrowserInFullscreen();
    debug('quality enforcement: fullscreenchange', { isFullscreen });
    if (isFullscreen) {
      // User entered fullscreen — remember intent and reset restoration counter.
      arenaState.userIntended = true;
      arenaState.restorationAttempts = 0;
      return;
    }

    // Fullscreen was lost. Decide: did our enforcement cause this, or did the user exit?
    // Signal: enforcement was running at the moment fullscreen exited, or completed very
    // recently (≤3 s) — Twitch reacts to our DOM clicks with a slight delay.
    const msSinceEnforcement = Date.now() - missionState.lastStrikeAtMs;
    const likelyCausedByUs = arenaState.userIntended
      && (missionState.inProgress || msSinceEnforcement < TIMINGS.ENFORCEMENT_RECENT_WINDOW_MS);

    if (likelyCausedByUs && arenaState.restorationAttempts < 3) {
      arenaState.restorationAttempts += 1;
      debug('fullscreen restore: fullscreen lost during/after enforcement, scheduling restore', {
        attempt: arenaState.restorationAttempts,
        enforcementInProgress: missionState.inProgress,
        msSinceEnforcement
      });
      // Give Twitch time to fully settle into cinema mode before re-entering fullscreen.
      setTimeout(() => {
        if (isBrowserInFullscreen()) {
          return; // already back in fullscreen somehow
        }
        if (arenaState.restorationInProgress) {
          return;
        }
        arenaState.restorationInProgress = true;
        attemptRestoreTwitchFullscreen().catch((err) => {
          debug('fullscreen restore: error', String(err));
        }).finally(() => {
          arenaState.restorationInProgress = false;
        });
      }, TIMINGS.FULLSCREEN_RESTORE_DELAY_MS);
    } else {
      // User intentionally exited fullscreen — clear intent, apply quality.
      arenaState.userIntended = false;
      arenaState.restorationAttempts = 0;
      queueEnforcementRound('fullscreen-exit', { delayMs: TIMINGS.FULLSCREEN_EXIT_DELAY_MS });
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  window.addEventListener('pageshow', () => {
    debug('quality enforcement: pageshow event');
    queueEnforcementRound('pageshow', {
      force: true,
      delayMs: TIMINGS.PAGESHOW_DELAY_MS
    });
  });
}
