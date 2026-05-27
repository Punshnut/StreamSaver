import { enforcementState, fullscreenState, STORAGE_KEYS } from './constants.js';
import { debug } from './utils.js';
import { scheduleEnsureDesiredQualityForCurrentMode } from './enforcement.js';
import { handleSetQualityRequest } from './automation.js';
import { isBrowserInFullscreen, attemptRestoreTwitchFullscreen } from './fullscreen.js';
import { isSupportedTwitchPage, makeResponse } from './page-support.js';
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
export function setupMessageHandler() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
        return makeResponse(false, 'unknown', 'Invalid message payload.');
      }

      const { action } = message;
      debug('Received message', { action, message, sender });

      const pluginEnabledResult = await loadPluginEnabledSetting();
      if (!pluginEnabledResult.ok) {
        return makeResponse(false, action, pluginEnabledResult.message, pluginEnabledResult.details);
      }
      if (!pluginEnabledResult.details?.pluginEnabled) {
        return makeResponse(false, action, 'Plugin logic is disabled. Turn it on in the popup to apply quality changes.', {
          pluginEnabled: false
        });
      }

      const pageSupport = getPageSupportState();
      if (!pageSupport.ok) {
        return makeResponse(false, action, pageSupport.message, pageSupport);
      }

      if (action === 'setQuality') {
        return handleSetQualityRequest(message.targetQuality, pageSupport);
      }

      // streamsaverPopupProbe — responds with current page support state
      if (action === 'streamsaverPopupProbe') {
        return makeResponse(pageSupport.ok, action, pageSupport.message, pageSupport.details);
      }

      return makeResponse(false, action, `Unknown action: ${action}`);
    })()
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        debug('Unhandled message error', String(error));
        sendResponse(makeResponse(false, 'unknown', 'Unhandled content script error.', { error: String(error) }));
      });

    return true;
  });
}

/** Registers storage/navigation/focus hooks that keep mode quality enforced. */
export function setupAutomaticModeEnforcement() {
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
    scheduleEnsureDesiredQualityForCurrentMode('storage-change', {
      force: true,
      delayMs: 160
    });
  });

  // Cancel any in-flight ad polling timer before starting fresh (safety for re-init).
  if (enforcementState.adPollingTimerId) {
    clearInterval(enforcementState.adPollingTimerId);
    enforcementState.adPollingTimerId = null;
  }

  // Compare only origin+pathname so query-param-only changes (e.g. Twitch VOD ?t= timestamp
  // updates that fire every ~10 s during playback) are not treated as SPA navigations.
  const getUrlKey = () => location.origin + location.pathname;
  let previousUrl = getUrlKey();
  enforcementState.urlWatchTimerId = setInterval(() => {
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
    scheduleEnsureDesiredQualityForCurrentMode('spa-navigation', {
      force: true,
      delayMs: 900
    });
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    debug('quality enforcement: tab became visible');
    scheduleEnsureDesiredQualityForCurrentMode('visibility-visible', {
      delayMs: 250
    });
  });

  window.addEventListener('focus', () => {
    debug('quality enforcement: window focused');
    // If a force-enforcement was blocked while focus was away (e.g. popup open during
    // a resolution change), replay it as force now so it bypasses cooldown and trust TTL.
    const hadForcePending = enforcementState.forcePendingAfterFocus;
    enforcementState.forcePendingAfterFocus = false;
    scheduleEnsureDesiredQualityForCurrentMode('window-focus', {
      force: hadForcePending,
      delayMs: 300
    });
  });

  function onFullscreenChange() {
    const isFullscreen = isBrowserInFullscreen();
    debug('quality enforcement: fullscreenchange', { isFullscreen });
    if (isFullscreen) {
      // User entered fullscreen — remember intent and reset restoration counter.
      fullscreenState.userIntended = true;
      fullscreenState.restorationAttempts = 0;
      return;
    }

    // Fullscreen was lost. Decide: did our enforcement cause this, or did the user exit?
    // Signal: enforcement was running at the moment fullscreen exited, or completed very
    // recently (≤3 s) — Twitch reacts to our DOM clicks with a slight delay.
    const msSinceEnforcement = Date.now() - enforcementState.lastRunAtMs;
    const likelyCausedByUs = fullscreenState.userIntended
      && (enforcementState.inProgress || msSinceEnforcement < 2000);

    if (likelyCausedByUs && fullscreenState.restorationAttempts < 3) {
      fullscreenState.restorationAttempts += 1;
      debug('fullscreen restore: fullscreen lost during/after enforcement, scheduling restore', {
        attempt: fullscreenState.restorationAttempts,
        enforcementInProgress: enforcementState.inProgress,
        msSinceEnforcement
      });
      // Give Twitch time to fully settle into cinema mode before re-entering fullscreen.
      setTimeout(() => {
        if (isBrowserInFullscreen()) {
          return; // already back in fullscreen somehow
        }
        if (fullscreenState.restorationInProgress) {
          return;
        }
        fullscreenState.restorationInProgress = true;
        attemptRestoreTwitchFullscreen().catch((err) => {
          debug('fullscreen restore: error', String(err));
        }).finally(() => {
          fullscreenState.restorationInProgress = false;
        });
      }, 800);
    } else {
      // User intentionally exited fullscreen — clear intent, apply quality.
      fullscreenState.userIntended = false;
      fullscreenState.restorationAttempts = 0;
      scheduleEnsureDesiredQualityForCurrentMode('fullscreen-exit', { delayMs: 500 });
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  window.addEventListener('pageshow', () => {
    debug('quality enforcement: pageshow event');
    scheduleEnsureDesiredQualityForCurrentMode('pageshow', {
      force: true,
      delayMs: 700
    });
  });
}
