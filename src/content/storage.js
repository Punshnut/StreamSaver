/**
 * content/storage.js
 *
 * Thin read-only layer over chrome.storage.local for the content script.
 * Never writes to storage — that is done exclusively by the popup.
 *
 * loadPluginEnabledSetting()
 *   Reads just the plugin-enabled flag. Called at the top of every enforcement
 *   and message handler to bail out early if the user has disabled the plugin.
 *
 * loadModeSettingsForEnforcement()
 *   Reads all four mode settings in one storage call and validates each value
 *   against known-good sets, falling back to defaults for any corrupt entry.
 *
 * aimQualityForMode(modeSettings)
 *   Pure function: given the four mode settings, returns the target quality
 *   string that should be active right now (fastToggleLow vs fastToggleHigh
 *   depending on activeMode).
 */

import { STORAGE_KEYS, DEFAULT_MODE_SETTINGS, MODE_VALUES } from './constants.js';
import { debug, createResult } from './utils.js';
import { validateQuality, validateMode, validatePluginEnabled } from './page-support.js';

/** Reads plugin-enabled state from storage with safe fallback. */
export async function loadPluginEnabledSetting() {
  try {
    // Pass the default as the fallback object so chrome.storage fills it in if
    // the key hasn't been written yet (fresh install / cleared storage).
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.PLUGIN_ENABLED]: DEFAULT_MODE_SETTINGS[STORAGE_KEYS.PLUGIN_ENABLED] });
    return createResult(true, 'PLUGIN_ENABLED_READY', 'Loaded plugin-enabled setting from storage.', {
      pluginEnabled: validatePluginEnabled(stored[STORAGE_KEYS.PLUGIN_ENABLED])
    });
  } catch (error) {
    // Storage read failures can happen if the extension context is being destroyed.
    // Return the default (enabled) so we degrade gracefully rather than blocking enforcement.
    return createResult(false, 'PLUGIN_ENABLED_READ_FAILED', 'Failed to read plugin-enabled setting from storage.', {
      error: String(error),
      pluginEnabled: DEFAULT_MODE_SETTINGS[STORAGE_KEYS.PLUGIN_ENABLED]
    });
  }
}

/** Loads and sanitizes active-mode quality settings from extension storage. */
export async function loadModeSettingsForEnforcement() {
  try {
    // Single call — avoids race conditions between separate reads and fills in defaults.
    const stored = await chrome.storage.local.get(DEFAULT_MODE_SETTINGS);

    // Validate each value individually — corrupt or unknown values fall back to defaults.
    const pluginEnabled = validatePluginEnabled(stored[STORAGE_KEYS.PLUGIN_ENABLED]);
    const activeMode = validateMode(stored[STORAGE_KEYS.ACTIVE_MODE]);
    const fastToggleLow = validateQuality(stored[STORAGE_KEYS.FAST_TOGGLE_LOW]) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_LOW];
    const fastToggleHigh =
      validateQuality(stored[STORAGE_KEYS.FAST_TOGGLE_HIGH]) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_HIGH];

    return createResult(true, 'MODE_SETTINGS_READY', 'Loaded mode settings from storage.', {
      pluginEnabled,
      activeMode,
      fastToggleLow,
      fastToggleHigh
    });
  } catch (error) {
    return createResult(false, 'MODE_SETTINGS_READ_FAILED', 'Failed to read mode settings from storage.', {
      error: String(error)
    });
  }
}

/** Resolves target quality from current mode settings.
 *  Pure function — takes the mode settings object and returns which quality
 *  string the player should show right now. */
export function aimQualityForMode(modeSettings) {
  // Re-validate all inputs even though loadModeSettingsForEnforcement already
  // did — this function can also be called with arbitrary objects in tests.
  const pluginEnabled = validatePluginEnabled(modeSettings?.pluginEnabled);
  const activeMode = validateMode(modeSettings?.activeMode);
  const fastToggleLow = validateQuality(modeSettings?.fastToggleLow) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_LOW];
  const fastToggleHigh = validateQuality(modeSettings?.fastToggleHigh) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_HIGH];

  // The active mode selects which quality preset to target.
  const targetQuality = activeMode === MODE_VALUES.LOW ? fastToggleLow : fastToggleHigh;

  return {
    pluginEnabled,
    activeMode,
    fastToggleLow,
    fastToggleHigh,
    targetQuality
  };
}
