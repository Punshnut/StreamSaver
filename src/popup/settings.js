/**
 * popup/settings.js
 *
 * Persistence and hydration of popup settings via chrome.storage.local.
 *
 * saveSetting()      — writes one key, updates status bar
 * handleSelectChange() — validates dropdown before saving
 * loadSettings()     — reads all settings on popup open, hydrates all controls
 */

import { SETTINGS_KEYS, DEFAULT_SETTINGS, STATUS_TYPES, POPUP_TIMINGS, MODE_VALUES } from './constants.js';
import { setActionButtonsDisabled, setStatus, isRoundActive, setQuickResolutionVisibility, setPluginEnabledState, setTripleModeState, setAggressiveModeState, fastToggleLow, fastToggleMedium, fastToggleHigh } from './ui.js';
import { sanitizeQualityValue, sanitizeModeValue, sanitizeStandardModeValue, refreshModeHUD, setCurrentActiveMode, setLastStandardMode } from './mode-quality.js';
import { probeIdleStatus } from './idle-status.js';

/** Persists one settings key immediately in local extension storage. */
export async function saveSetting(key, value, successMessage = '') {
  try {
    await chrome.storage.local.set({ [key]: value });
    setStatus(STATUS_TYPES.SUCCESS, successMessage || `Saved ${key}: ${value}`, POPUP_TIMINGS.STATUS_SAVE_RESET_MS);
    return true;
  } catch (error) {
    console.error(`[StreamSaver][popup] Failed to save setting ${key}:`, error);
    setStatus(STATUS_TYPES.ERROR, `Failed to save ${key}.`);
    return false; // caller uses this to decide whether to proceed with quality application
  }
}

/** Validates and saves a dropdown change for either mode resolution endpoint. */
export function handleSelectChange(settingKey, selectEl) {
  const selectedValue = sanitizeQualityValue(selectEl.value, DEFAULT_SETTINGS[settingKey]);

  // If validation changed the value, reset the dropdown so the DOM stays in sync
  // with what will actually be persisted.
  if (selectedValue !== selectEl.value) {
    selectEl.value = selectedValue;
    setStatus(STATUS_TYPES.ERROR, 'Invalid quality value selected.');
    return;
  }

  saveSetting(settingKey, selectedValue); // fire-and-forget
}

/** Loads persisted settings and hydrates popup controls. */
export async function loadSettings() {
  // Disable action buttons while loading to prevent clicks on stale UI state.
  setActionButtonsDisabled(true);
  setStatus(STATUS_TYPES.LOADING, 'Loading settings...');

  try {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);

    // Validate each value before applying — storage may contain corrupt data from
    // an older extension version or manual browser storage edits.
    const lowValue = sanitizeQualityValue(stored[SETTINGS_KEYS.LOW], DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]);
    const mediumValue = sanitizeQualityValue(stored[SETTINGS_KEYS.MEDIUM], DEFAULT_SETTINGS[SETTINGS_KEYS.MEDIUM]);
    const highValue = sanitizeQualityValue(stored[SETTINGS_KEYS.HIGH], DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH]);
    let activeMode = sanitizeModeValue(stored[SETTINGS_KEYS.ACTIVE_MODE], DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE]);
    const lastStandardMode = sanitizeStandardModeValue(
      stored[SETTINGS_KEYS.LAST_STANDARD_MODE],
      DEFAULT_SETTINGS[SETTINGS_KEYS.LAST_STANDARD_MODE]
    );
    // Boolean settings: use strict comparison to avoid treating null/undefined as false.
    const quickResolutionVisible = stored[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE] === true;
    const pluginEnabled = stored[SETTINGS_KEYS.PLUGIN_ENABLED] !== false;
    const tripleModeEnabled = stored[SETTINGS_KEYS.TRIPLE_MODE_ENABLED] === true;
    const aggressiveModeEnabled = stored[SETTINGS_KEYS.AGGRESSIVE_MODE] === true;

    // Defensive consistency check: Balanced mode can only be active while Triple Mode
    // is enabled — fall back to the remembered standard mode if storage disagrees
    // (e.g. edited out of band, or Triple Mode was turned off in another popup instance).
    if (activeMode === MODE_VALUES.MEDIUM && !tripleModeEnabled) {
      activeMode = lastStandardMode;
    }

    // Hydrate all controls with the loaded values.
    fastToggleLow.value = lowValue;
    fastToggleMedium.value = mediumValue;
    fastToggleHigh.value = highValue;
    setCurrentActiveMode(activeMode);
    setLastStandardMode(lastStandardMode);
    setQuickResolutionVisibility(quickResolutionVisible);
    setPluginEnabledState(pluginEnabled);
    setTripleModeState(tripleModeEnabled);
    setAggressiveModeState(aggressiveModeEnabled);
    refreshModeHUD();

    // Probe the active tab to set the correct idle status (ready / no stream / disabled).
    await probeIdleStatus(true);
  } catch (error) {
    // Storage read failed — apply defaults so the popup is still usable.
    console.error('[StreamSaver][popup] Failed to load settings:', error);
    fastToggleLow.value = DEFAULT_SETTINGS[SETTINGS_KEYS.LOW];
    fastToggleMedium.value = DEFAULT_SETTINGS[SETTINGS_KEYS.MEDIUM];
    fastToggleHigh.value = DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH];
    setCurrentActiveMode(DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE]);
    setLastStandardMode(DEFAULT_SETTINGS[SETTINGS_KEYS.LAST_STANDARD_MODE]);
    setQuickResolutionVisibility(DEFAULT_SETTINGS[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]);
    setPluginEnabledState(DEFAULT_SETTINGS[SETTINGS_KEYS.PLUGIN_ENABLED]);
    setTripleModeState(DEFAULT_SETTINGS[SETTINGS_KEYS.TRIPLE_MODE_ENABLED]);
    setAggressiveModeState(DEFAULT_SETTINGS[SETTINGS_KEYS.AGGRESSIVE_MODE]);
    refreshModeHUD();
    setStatus(STATUS_TYPES.ERROR, 'Failed to load settings. Using defaults.');
  } finally {
    // Re-enable buttons only if no action is already in progress — a mode switch
    // could have been triggered before this finally block runs.
    if (!isRoundActive) {
      setActionButtonsDisabled(false);
    }
    // Always refresh the HUD in case the finally block runs before the try's
    // refreshModeHUD call (e.g. an early throw in try).
    refreshModeHUD();
  }
}
