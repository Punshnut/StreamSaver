export { QUALITY_VALUES, QUALITY_SET, MODE_VALUES, MODE_SET } from '../shared/constants.js';
import { QUALITY_VALUES, MODE_VALUES } from '../shared/constants.js';

export const DEBUG = false;
export const DEBUG_PREFIX = '[StreamSaver][content]';
export const SETTINGS_MENU_DEBUG_MODE = false;

export const QUALITY_ORDER_MAP = QUALITY_VALUES.reduce((acc, quality, index) => {
  acc[quality] = index;
  return acc;
}, {});

export const QUALITY_ENTRY_TERMS = ['quality', 'qualität', 'video quality', 'resolution', 'auflösung'];
export const SETTINGS_TRIGGER_TERMS = ['settings', 'einstellungen'];
export const SETTINGS_MENU_LABEL_GROUPS = {
  quality: ['qualität', 'quality', 'auflösung', 'resolution'],
  subtitles: ['untertitel', 'subtitles'],
  advanced: ['erweitert', 'advanced']
};
export const SETTINGS_MENU_CLOSE_TERMS = ['schließen', 'schliessen', 'close'];
export const SETTINGS_MENU_BACK_TERMS = ['zurück', 'zurueck', 'back', 'go back'];
export const SOURCE_TERMS = ['source', 'quelle', 'chunked'];
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
  FAST_TOGGLE_HIGH: 'fastToggleHigh',
  ACTIVE_MODE: 'activeMode',
  PLUGIN_ENABLED: 'pluginEnabled'
};
export const DEFAULT_MODE_SETTINGS = {
  [STORAGE_KEYS.FAST_TOGGLE_LOW]: '480p',
  [STORAGE_KEYS.FAST_TOGGLE_HIGH]: 'Source',
  [STORAGE_KEYS.ACTIVE_MODE]: MODE_VALUES.HIGH,
  [STORAGE_KEYS.PLUGIN_ENABLED]: true
};
export const ENFORCEMENT_COOLDOWN_MS = 6000;
export const ENFORCEMENT_DEBOUNCE_MS = 600;
export const ENFORCEMENT_PLAYER_READY_TIMEOUT_MS = 6000;
export const QUALITY_TRUST_TTL_MS = 25_000; // skip detect+set when quality was recently confirmed

export const enforcementState = {
  inProgress: false,
  scheduledTimerId: null,
  lastRunAtMs: 0,
  lastRunUrl: '',
  lastResolvedTargetQuality: '',
  lastConfirmedQualityAtMs: 0, // when quality was last successfully confirmed (detect or set)
  urlWatchTimerId: null,
  adPollingTimerId: null,      // setInterval handle while waiting for an ad to finish
  forcePendingAfterFocus: false // force enforcement was blocked by focus-loss; re-fire on next focus
};

export const fullscreenState = {
  userIntended: false,       // user explicitly entered fullscreen
  restorationAttempts: 0,
  restorationInProgress: false
};
