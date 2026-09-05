/**
 * content/constants.js
 *
 * All compile-time and runtime constants for the content script.
 * This is the single source of truth for:
 *   - Quality and mode value sets (re-exported from shared)
 *   - Debug flags
 *   - CSS selector strings used across multiple modules
 *   - All timing delays (tweak latencies here only, not in individual files)
 *   - Extension storage key names and their defaults
 *   - The missionState and arenaState shared-mutable objects that track
 *     enforcement lifecycle and fullscreen intent across async calls
 *   - Locale-aware UI search terms (re-exported from locale-terms.js)
 */

export { QUALITY_VALUES, QUALITY_SET, MODE_VALUES, MODE_SET } from '../shared/constants.js';
import { QUALITY_VALUES, MODE_VALUES } from '../shared/constants.js';

export const DEBUG = false;
export const DEBUG_PREFIX = '[StreamSaver][content]';
export const SETTINGS_MENU_DEBUG_MODE = false;

export const QUALITY_ORDER_MAP = QUALITY_VALUES.reduce((acc, quality, index) => {
  acc[quality] = index;
  return acc;
}, {});

export {
  SOURCE_TERMS,
  AUTO_TERMS,
  QUALITY_ENTRY_TERMS,
  SETTINGS_TRIGGER_TERMS,
  SETTINGS_MENU_LABEL_GROUPS,
  SETTINGS_MENU_CLOSE_TERMS,
  SETTINGS_MENU_BACK_TERMS,
} from './locale-terms.js';
export const RESOLUTION_PATTERN = /\b(160|360|480|720|1080|1440|2160)\s*p?\d*\b/i;
export const AD_INDICATOR_SELECTORS = [
  '[data-test-selector="ad-banner-default-text"]',
  '[data-test-selector="ad-banner"]',
  '[data-a-target="ad-countdown"]',
  '.video-ad-label',
  // Mid-stream ad break: Twitch shows the real stream as a PiP mini-player.
  // This element only exists during commercial breaks.
  '[data-a-target="picture-by-picture-player"]',
];
export const STORAGE_KEYS = {
  FAST_TOGGLE_LOW: 'fastToggleLow',
  FAST_TOGGLE_MEDIUM: 'fastToggleMedium',
  FAST_TOGGLE_HIGH: 'fastToggleHigh',
  ACTIVE_MODE: 'activeMode',
  PLUGIN_ENABLED: 'pluginEnabled'
};
export const DEFAULT_MODE_SETTINGS = {
  [STORAGE_KEYS.FAST_TOGGLE_LOW]: '480p',
  [STORAGE_KEYS.FAST_TOGGLE_MEDIUM]: '720p',
  [STORAGE_KEYS.FAST_TOGGLE_HIGH]: 'Source',
  [STORAGE_KEYS.ACTIVE_MODE]: MODE_VALUES.HIGH,
  [STORAGE_KEYS.PLUGIN_ENABLED]: true
};

// All timing constants in one place — tweak delays here, not scattered across files.
export const TIMINGS = {
  SPAWN_DELAY_MS: 900,             // initial enforcement after content script loads
  WARP_DELAY_MS: 900,              // enforcement after Twitch SPA navigation detected
  STORAGE_CHANGE_DELAY_MS: 160,    // enforcement after settings change in popup
  FOCUS_DELAY_MS: 300,             // enforcement after window regains focus
  VISIBILITY_DELAY_MS: 250,        // enforcement after tab becomes visible
  AD_CLEAR_DELAY_MS: 800,          // enforcement after ad polling detects ad ended
  FULLSCREEN_RESTORE_DELAY_MS: 800, // wait for Twitch to settle before re-entering fullscreen
  FULLSCREEN_EXIT_DELAY_MS: 500,   // enforcement after user intentionally exits fullscreen
  PAGESHOW_DELAY_MS: 700,          // enforcement on bfcache page restore
  TYPING_RESUME_DELAY_MS: 1_500,   // retry delay when user is typing in chat
  ENFORCEMENT_RECENT_WINDOW_MS: 2_000, // msSinceEnforcement threshold for fullscreen-caused-by-us check
  AD_SCAN_INTERVAL_MS: 2_000,      // how often to scan if an ad has ended
  URL_WATCH_INTERVAL_MS: 1_000,    // SPA nav detection poll interval
  ENFORCEMENT_COOLDOWN_MS: 6_000,  // min gap between auto-enforcement runs
  ENFORCEMENT_DEBOUNCE_MS: 600,    // base debounce for scheduled enforcement
  PLAYER_READY_TIMEOUT_MS: 6_000,  // max wait for player to appear before aborting
  QUALITY_TRUST_TTL_MS: 25_000,    // skip detect+set when quality was recently confirmed
  USER_MENU_RESUME_DELAY_MS: 400,  // settle time after user-opened menu closes before re-enforcement
};

// Named re-exports for backwards compatibility with existing imports.
export const ENFORCEMENT_COOLDOWN_MS = TIMINGS.ENFORCEMENT_COOLDOWN_MS;
export const ENFORCEMENT_DEBOUNCE_MS = TIMINGS.ENFORCEMENT_DEBOUNCE_MS;
export const ENFORCEMENT_PLAYER_READY_TIMEOUT_MS = TIMINGS.PLAYER_READY_TIMEOUT_MS;
export const QUALITY_TRUST_TTL_MS = TIMINGS.QUALITY_TRUST_TTL_MS;

// Shared CSS selector strings used across multiple content modules.
export const SELECTORS = {
  MENU_ENTRY: 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]',
  BUTTON_LIKE: 'button, [role="button"]',
};

export const missionState = {
  inProgress: false,
  scheduledTimerId: null,
  lastStrikeAtMs: 0,
  lastRunUrl: '',
  lockedQuality: '',
  lastConfirmedQualityAtMs: 0, // when quality was last successfully confirmed (detect or set)
  urlWatchTimerId: null,
  adScanTimerId: null,      // setInterval handle while waiting for an ad to finish
  forcePendingAfterFocus: false, // force enforcement was blocked by focus-loss; re-fire on next focus
  userMenuOpen: false,           // user has a player menu open; enforcement is paused
  userMenuForcePending: false,   // a force-enforcement was blocked by userMenuOpen; replay on menu close
};

export const arenaState = {
  userIntended: false,       // user explicitly entered fullscreen
  restorationAttempts: 0,
  restorationInProgress: false
};
