import { STORAGE_KEYS, DEFAULT_MODE_SETTINGS, MODE_VALUES } from './constants.js';
import { debug, createResult } from './utils.js';
import { validateQuality, validateMode, validatePluginEnabled } from './page-support.js';

/** Reads plugin-enabled state from storage with safe fallback. */
export async function loadPluginEnabledSetting() {
  try {
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.PLUGIN_ENABLED]: DEFAULT_MODE_SETTINGS[STORAGE_KEYS.PLUGIN_ENABLED] });
    return createResult(true, 'PLUGIN_ENABLED_READY', 'Loaded plugin-enabled setting from storage.', {
      pluginEnabled: validatePluginEnabled(stored[STORAGE_KEYS.PLUGIN_ENABLED])
    });
  } catch (error) {
    return createResult(false, 'PLUGIN_ENABLED_READ_FAILED', 'Failed to read plugin-enabled setting from storage.', {
      error: String(error),
      pluginEnabled: DEFAULT_MODE_SETTINGS[STORAGE_KEYS.PLUGIN_ENABLED]
    });
  }
}

/** Loads and sanitizes active-mode quality settings from extension storage. */
export async function loadModeSettingsForEnforcement() {
  try {
    const stored = await chrome.storage.local.get(DEFAULT_MODE_SETTINGS);
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

/** Resolves target quality from current mode settings. */
export function resolveTargetQualityForMode(modeSettings) {
  const pluginEnabled = validatePluginEnabled(modeSettings?.pluginEnabled);
  const activeMode = validateMode(modeSettings?.activeMode);
  const fastToggleLow = validateQuality(modeSettings?.fastToggleLow) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_LOW];
  const fastToggleHigh = validateQuality(modeSettings?.fastToggleHigh) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_HIGH];
  const targetQuality = activeMode === MODE_VALUES.LOW ? fastToggleLow : fastToggleHigh;

  return {
    pluginEnabled,
    activeMode,
    fastToggleLow,
    fastToggleHigh,
    targetQuality
  };
}
