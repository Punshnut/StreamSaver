/**
 * content/setup.js
 *
 * Wires together the two top-level content-script lifecycle concerns:
 *
 * bindCommandPort()
 *   Registers the chrome.runtime.onMessage listener that receives requests from
 *   the popup (setQuality, streamsaverPopupProbe). Every inbound message goes
 *   through plugin-enabled and page-support checks before being dispatched.
 *
 * bootEnforcementLoop()
 *   Attaches the event hooks that keep quality re-enforced automatically:
 *     - chrome.storage.onChanged  → settings changed in popup
 *     - setInterval (URL polling) → Twitch SPA navigation (channel switch)
 *     - document visibilitychange → tab made visible again
 *     - window focus              → window regained focus
 *     - document fullscreenchange → fullscreen entered/exited
 *     - window pageshow           → bfcache page restore
 *
 * The fullscreenchange handler also manages the arenaState flags that decide
 * whether a fullscreen exit was caused by the extension (and should be
 * restored) or by the user (and should trigger a quality re-check).
 */

import { missionState, arenaState, STORAGE_KEYS, TIMINGS } from './constants.js';
import { debug } from './utils.js';
import { queueEnforcementRound } from './enforcement.js';
import { routeQualityRequest } from './automation.js';
import { isBrowserInFullscreen, attemptRestoreTwitchFullscreen } from './fullscreen.js';
import { isSupportedTwitchPage, forgeResponse } from './page-support.js';
import { loadPluginEnabledSetting } from './storage.js';
import { scanMenuRoots } from './menu-find.js';

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
    // Wrap the entire handler in an IIFE so we can use async/await, then pipe
    // the result back through the synchronous sendResponse callback.
    (async () => {
      // Reject anything that isn't a well-formed { action: string } object.
      if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
        return forgeResponse(false, 'unknown', 'Invalid message payload.');
      }

      const { action } = message;
      debug('Received message', { action, message, sender });

      // Plugin-enabled check comes before page-support so users get a clear
      // "plugin is off" message rather than a confusing page error. Quick-resolution
      // buttons send manualOverride to bypass this and work even when off.
      const isManualQualityOverride = action === 'setQuality' && message.manualOverride === true;
      if (!isManualQualityOverride) {
        const pluginEnabledResult = await loadPluginEnabledSetting();
        if (!pluginEnabledResult.ok) {
          return forgeResponse(false, action, pluginEnabledResult.message, pluginEnabledResult.details);
        }
        if (!pluginEnabledResult.details?.pluginEnabled) {
          return forgeResponse(false, action, 'Plugin logic is disabled. Turn it on in the popup to apply quality changes.', {
            pluginEnabled: false
          });
        }
      }

      // Reject the message if the current page can't support quality automation.
      const pageSupport = getPageSupportState();
      if (!pageSupport.ok) {
        return forgeResponse(false, action, pageSupport.message, pageSupport);
      }

      if (action === 'setQuality') {
        // Full quality-switch pipeline — acquires the automation lock internally.
        return routeQualityRequest(message.targetQuality, pageSupport, message.manualOverride === true);
      }

      // Probe used by the popup to set its idle status on open — returns whether
      // the current page has a supported player without changing anything.
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

    // Return true to keep the message channel open for the async sendResponse call.
    return true;
  });
}

/** Registers storage/navigation/focus hooks that keep mode quality enforced. */
export function bootEnforcementLoop() {
  // --- Trigger 1: settings changed in popup ---
  // Fires when the user changes mode, quality presets, or the plugin toggle.
  // Use force:true so changes bypass the cooldown and trust TTL immediately.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    // Only care about our own keys in local storage — ignore sync/managed areas.
    if (areaName !== 'local') {
      return;
    }

    // Filter to only the keys we actually act on; ignore unrelated storage writes.
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

  // Safety: if bootEnforcementLoop is ever called a second time (re-init scenario),
  // clear any lingering ad-polling interval from the previous boot.
  if (missionState.adScanTimerId) {
    clearInterval(missionState.adScanTimerId);
    missionState.adScanTimerId = null;
  }

  // --- Trigger 2: SPA navigation (channel switch) ---
  // Twitch is a React SPA — switching channels does not reload the page, so we
  // cannot rely on load events. Poll the URL and fire when it changes.
  // Compare only origin+pathname so query-param-only changes (e.g. Twitch VOD ?t=
  // timestamp updates that fire every ~10 s during playback) are not treated as
  // navigations.
  const getUrlKey = () => location.origin + location.pathname;
  let previousUrl = getUrlKey();
  missionState.urlWatchTimerId = setInterval(() => {
    const currentUrl = getUrlKey();
    if (currentUrl === previousUrl) {
      return; // no navigation — nothing to do
    }

    const fromUrl = previousUrl;
    previousUrl = currentUrl; // update before the async enforcement so re-entry is safe
    debug('quality enforcement: twitch SPA navigation detected', {
      fromUrl,
      toUrl: previousUrl
    });
    // Force:true — the new channel may have a different quality state.
    queueEnforcementRound('spa-navigation', {
      force: true,
      delayMs: TIMINGS.WARP_DELAY_MS
    });
  }, TIMINGS.URL_WATCH_INTERVAL_MS);

  // --- Trigger 3: tab visibility ---
  // Twitch may have reset quality while the tab was in the background.
  // Only react on becoming visible — going hidden doesn't need enforcement.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    debug('quality enforcement: tab became visible');
    queueEnforcementRound('visibility-visible', {
      delayMs: TIMINGS.VISIBILITY_DELAY_MS
    });
  });

  // --- Trigger 4: window focus ---
  window.addEventListener('focus', () => {
    debug('quality enforcement: window focused');
    // If a force-enforcement was blocked while focus was away (e.g. popup open during
    // a resolution change), replay it as force now so it bypasses cooldown and trust TTL.
    const hadForcePending = missionState.forcePendingAfterFocus;
    missionState.forcePendingAfterFocus = false; // clear before the async round so it's not re-read
    queueEnforcementRound('window-focus', {
      force: hadForcePending,
      delayMs: TIMINGS.FOCUS_DELAY_MS
    });
  });

  // --- Trigger 5: fullscreen change ---
  // Shared handler for both standard and webkit-prefixed fullscreen events.
  function onFullscreenChange() {
    const isFullscreen = isBrowserInFullscreen();
    debug('quality enforcement: fullscreenchange', { isFullscreen });

    if (isFullscreen) {
      // User entered fullscreen — record intent so we know to restore it if
      // the extension accidentally kicks them out during enforcement.
      arenaState.userIntended = true;
      arenaState.restorationAttempts = 0; // reset counter for the new session
      return;
    }

    // Fullscreen was lost. Two possible causes:
    //   A) Our own enforcement triggered it (Twitch exits fullscreen when the
    //      settings overlay opens). We should silently restore fullscreen.
    //   B) The user pressed Escape / F / clicked the button intentionally.
    //      We should queue a quality check instead.
    //
    // Heuristic: if enforcement was running at the moment fullscreen exited, or
    // completed very recently (within ENFORCEMENT_RECENT_WINDOW_MS), it was
    // almost certainly us — Twitch reacts to our DOM clicks with a slight delay.
    const msSinceEnforcement = Date.now() - missionState.lastStrikeAtMs;
    const likelyCausedByUs = arenaState.userIntended
      && (missionState.inProgress || msSinceEnforcement < TIMINGS.ENFORCEMENT_RECENT_WINDOW_MS);

    if (likelyCausedByUs && arenaState.restorationAttempts < 3) {
      arenaState.restorationAttempts += 1; // cap to 3 so we don't loop forever on a broken state
      debug('fullscreen restore: fullscreen lost during/after enforcement, scheduling restore', {
        attempt: arenaState.restorationAttempts,
        enforcementInProgress: missionState.inProgress,
        msSinceEnforcement
      });
      // Give Twitch time to fully settle into cinema mode before re-entering fullscreen.
      setTimeout(() => {
        if (isBrowserInFullscreen()) {
          return; // another event already restored fullscreen — nothing to do
        }
        if (arenaState.restorationInProgress) {
          return; // a previous restoration attempt is still pending
        }
        arenaState.restorationInProgress = true;
        attemptRestoreTwitchFullscreen().catch((err) => {
          debug('fullscreen restore: error', String(err));
        }).finally(() => {
          arenaState.restorationInProgress = false;
        });
      }, TIMINGS.FULLSCREEN_RESTORE_DELAY_MS);
    } else {
      // User intentionally exited fullscreen (or we ran out of restoration attempts).
      // Clear the intent flag and queue a quality check to re-confirm the setting.
      arenaState.userIntended = false;
      arenaState.restorationAttempts = 0;
      queueEnforcementRound('fullscreen-exit', { delayMs: TIMINGS.FULLSCREEN_EXIT_DELAY_MS });
    }
  }
  // Register both the standard and webkit-prefixed variants for Safari/old Chrome compat.
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // --- Trigger 6: bfcache restore ---
  // When the user navigates back/forward and the browser restores the page from
  // the back-forward cache, load events don't fire but pageshow does. Twitch may
  // have buffered at a different quality while cached.
  window.addEventListener('pageshow', () => {
    debug('quality enforcement: pageshow event');
    queueEnforcementRound('pageshow', {
      force: true,
      delayMs: TIMINGS.PAGESHOW_DELAY_MS
    });
  });

  // --- Trigger 7: user-opened menu closed ---
  // Watch for menu removal so we can resume automation promptly when the user
  // closes a player menu they opened themselves (Guard 5.5 in enforcement.js
  // pauses enforcement while userMenuOpen is true).
  watchUserMenuActivity();
}

/**
 * Watches the DOM for player menu removal. When enforcement was paused because
 * the user had a menu open (missionState.userMenuOpen), re-queues enforcement as
 * soon as all visible menu roots are gone.
 *
 * The MutationObserver callback exits immediately in the common case where no
 * user menu is active, so the constant subtree observation has negligible overhead.
 */
function watchUserMenuActivity() {
  const observer = new MutationObserver(() => {
    if (!missionState.userMenuOpen) return;
    if (scanMenuRoots().some(el => el.offsetParent !== null)) return; // still open

    const hadForcePending = missionState.userMenuForcePending;
    missionState.userMenuOpen = false;
    missionState.userMenuForcePending = false;
    debug('quality enforcement: user menu closed — resuming');
    queueEnforcementRound('user-menu-closed', {
      force: hadForcePending,
      delayMs: TIMINGS.USER_MENU_RESUME_DELAY_MS
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
