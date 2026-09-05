/**
 * popup/constants.js
 *
 * All compile-time constants for the popup UI.
 * Re-exports quality and mode sets from shared/constants.js so popup modules
 * only need to import from one place.
 *
 * Defines:
 *   MODE_LABELS        — human-readable display strings for each mode key
 *   ACTION_NAMES       — message action identifiers sent to the content script
 *   STATUS_TYPES       — CSS state strings for the status bar (loading/success/error)
 *   SETTINGS_KEYS      — chrome.storage.local key names
 *   DEFAULT_SETTINGS   — default values used when storage is empty or corrupt
 *   Status messages    — fixed strings displayed in the popup status bar
 *   POPUP_TIMINGS      — timing constants for auto-resetting status messages
 *   isTwitchUrl()      — URL pattern check for any twitch.tv page
 *   isInjectableTwitchUrl() — narrower check for www.twitch.tv where the
 *                             content script is actually injected
 */

export { QUALITY_VALUES, QUALITY_SET, MODE_VALUES, MODE_SET, resolveQuality } from '../shared/constants.js';
import { MODE_VALUES } from '../shared/constants.js';

export const MODE_LABELS = {
  [MODE_VALUES.LOW]: 'Travel / Data Saver',
  [MODE_VALUES.MEDIUM]: 'Balanced',
  [MODE_VALUES.HIGH]: 'High Quality'
};
export const ACTION_NAMES = {
  SET_QUALITY: 'setQuality'
};
export const STATUS_TYPES = {
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error'
};
export const SETTINGS_KEYS = {
  LOW: 'fastToggleLow',
  MEDIUM: 'fastToggleMedium',
  HIGH: 'fastToggleHigh',
  ACTIVE_MODE: 'activeMode',
  QUICK_RESOLUTION_VISIBLE: 'quickResolutionVisible',
  PLUGIN_ENABLED: 'pluginEnabled',
  TRIPLE_MODE_ENABLED: 'tripleModeEnabled',
  LAST_STANDARD_MODE: 'lastStandardMode'
};
export const DEFAULT_SETTINGS = {
  [SETTINGS_KEYS.LOW]: '480p',
  [SETTINGS_KEYS.MEDIUM]: '720p',
  [SETTINGS_KEYS.HIGH]: 'Source',
  [SETTINGS_KEYS.ACTIVE_MODE]: MODE_VALUES.HIGH,
  [SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]: false,
  [SETTINGS_KEYS.PLUGIN_ENABLED]: true,
  [SETTINGS_KEYS.TRIPLE_MODE_ENABLED]: false,
  [SETTINGS_KEYS.LAST_STANDARD_MODE]: MODE_VALUES.HIGH
};
export const READY_STATUS_MESSAGE = 'Ready. Manage mode or switch resolutions manually.';
export const DISABLED_STATUS_MESSAGE = 'Plugin logic is disabled. Settings are saved but Twitch quality is unchanged.';
export const OPEN_TWITCH_STREAM_STATUS_MESSAGE = 'Open a live Twitch stream on www.twitch.tv to control quality.';
export const RELOAD_TWITCH_TAB_STATUS_MESSAGE = 'Reload the Twitch tab and try again.';
export const UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE = 'This Twitch tab is unsupported. Open a stream on www.twitch.tv.';

// Popup-side timing constants.
export const POPUP_TIMINGS = {
  STATUS_SUCCESS_RESET_MS: 1_500, // quality apply / default success reset
  STATUS_SAVE_RESET_MS:    1_200, // save-setting confirmations
  STATUS_INFO_RESET_MS:    1_000, // brief info (e.g. already-active mode click)
};

/** True when a URL points to any Twitch page/subdomain. */
export function isTwitchUrl(url) {
  return typeof url === 'string' && /^https:\/\/([a-z0-9-]+\.)?twitch\.tv\//i.test(url);
}

/** True when URL matches the host where this extension injects content scripts. */
export function isInjectableTwitchUrl(url) {
  return typeof url === 'string' && /^https:\/\/www\.twitch\.tv\//i.test(url);
}
