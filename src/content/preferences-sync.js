/**
 * content/preferences-sync.js
 *
 * Keeps Twitch's live Subtitles / Low Latency state aligned with the user's
 * stored preference. Deliberately lighter-weight than quality enforcement —
 * no cooldown or trust-TTL cache, since both appliers are already idempotent
 * (they skip the click when the live state already matches) and cheap to
 * re-check.
 *
 * queuePreferenceSync(reason, opts) — debounced entry point, called on
 *   initial page load, SPA navigation, a popup-triggered storage change from
 *   another tab, and (when Aggressive Mode is on) the drift watchdog.
 * syncPreferences() — the actual check-and-apply, run once the debounce fires.
 */

import { debug } from './utils.js';
import { missionState } from './constants.js';
import { isSupportedTwitchPage } from './page-support.js';
import { loadPluginEnabledSetting, loadSubtitlesSetting, loadLowLatencySetting } from './storage.js';
import { routeSubtitlesRequest, routeLowLatencyRequest } from './automation.js';
import { scanMenuRoots } from './menu-find.js';

let debounceTimerId = null;

/** Debounces calls to syncPreferences so rapid-fire triggers coalesce into one run. */
export function queuePreferenceSync(reason, options = {}) {
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0;

  if (debounceTimerId) {
    clearTimeout(debounceTimerId);
  }
  debounceTimerId = setTimeout(() => {
    debounceTimerId = null;
    debug('preferences-sync: running', { reason });
    syncPreferences().catch((error) => {
      debug('preferences-sync: unhandled error', String(error));
    });
  }, delayMs);
}

/** Reads stored Subtitles/Low Latency preferences and applies them if the page supports it. */
export async function syncPreferences() {
  const support = isSupportedTwitchPage();
  if (!support.supported) {
    return;
  }

  const pluginEnabledResult = await loadPluginEnabledSetting();
  if (!pluginEnabledResult.details?.pluginEnabled) {
    return;
  }

  // Mirror quality enforcement's Guard 5.5 (enforcement.js): if the user has a player
  // menu open themselves, don't sweep/reopen it out from under them. setup.js's
  // watchUserMenuActivity() re-queues this sync once the menu closes.
  if (scanMenuRoots().some((el) => el.offsetParent !== null)) {
    debug('preferences-sync: skipped — user has a player menu open');
    missionState.preferenceSyncPendingAfterUserMenu = true;
    return;
  }

  const [subtitlesResult, lowLatencyResult] = await Promise.all([loadSubtitlesSetting(), loadLowLatencySetting()]);

  const subtitlesResponse = await routeSubtitlesRequest(Boolean(subtitlesResult.details?.subtitlesEnabled), { supported: true });
  debug('preferences-sync: subtitles result', subtitlesResponse);

  const lowLatencyResponse = await routeLowLatencyRequest(Boolean(lowLatencyResult.details?.lowLatencyEnabled), { supported: true });
  debug('preferences-sync: low latency result', lowLatencyResponse);
}
