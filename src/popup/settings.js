import { SETTINGS_KEYS, DEFAULT_SETTINGS, STATUS_TYPES } from './constants.js';
import { setActionButtonsDisabled, setStatus, isRoundActive, setQuickResolutionVisibility, setPluginEnabledState, fastToggleLow, fastToggleHigh } from './ui.js';
import { sanitizeQualityValue, sanitizeModeValue, refreshModeHUD, setCurrentActiveMode } from './mode-quality.js';
import { probeIdleStatus } from './idle-status.js';

/** Persists one settings key immediately in local extension storage. */
export async function saveSetting(key, value, successMessage = '') {
  try {
    await chrome.storage.local.set({ [key]: value });
    console.log(`[StreamSaver][popup] Saved setting ${key}: ${value}`);
    setStatus(STATUS_TYPES.SUCCESS, successMessage || `Saved ${key}: ${value}`, 1200);
    return true;
  } catch (error) {
    console.error(`[StreamSaver][popup] Failed to save setting ${key}:`, error);
    setStatus(STATUS_TYPES.ERROR, `Failed to save ${key}.`);
    return false;
  }
}

/** Validates and saves a dropdown change for either mode resolution endpoint. */
export function handleSelectChange(settingKey, selectEl) {
  const selectedValue = sanitizeQualityValue(selectEl.value, DEFAULT_SETTINGS[settingKey]);

  if (selectedValue !== selectEl.value) {
    selectEl.value = selectedValue;
    setStatus(STATUS_TYPES.ERROR, 'Invalid quality value selected.');
    return;
  }

  console.log(`[StreamSaver][popup] ${settingKey} set to: ${selectedValue}`);
  saveSetting(settingKey, selectedValue);
}

/** Loads persisted settings and hydrates popup controls. */
export async function loadSettings() {
  setActionButtonsDisabled(true);
  setStatus(STATUS_TYPES.LOADING, 'Loading settings...');

  try {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    const lowValue = sanitizeQualityValue(stored[SETTINGS_KEYS.LOW], DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]);
    const highValue = sanitizeQualityValue(stored[SETTINGS_KEYS.HIGH], DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH]);
    const activeMode = sanitizeModeValue(stored[SETTINGS_KEYS.ACTIVE_MODE], DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE]);
    const quickResolutionVisible = stored[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE] === true;
    const pluginEnabled = stored[SETTINGS_KEYS.PLUGIN_ENABLED] !== false;

    fastToggleLow.value = lowValue;
    fastToggleHigh.value = highValue;
    setCurrentActiveMode(activeMode);
    setQuickResolutionVisibility(quickResolutionVisible);
    setPluginEnabledState(pluginEnabled);
    refreshModeHUD();

    console.log('[StreamSaver][popup] Settings loaded:', {
      lowValue,
      highValue,
      activeMode,
      quickResolutionVisible,
      pluginEnabled
    });
    await probeIdleStatus(true);
  } catch (error) {
    console.error('[StreamSaver][popup] Failed to load settings:', error);
    fastToggleLow.value = DEFAULT_SETTINGS[SETTINGS_KEYS.LOW];
    fastToggleHigh.value = DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH];
    setCurrentActiveMode(DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE]);
    setQuickResolutionVisibility(DEFAULT_SETTINGS[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]);
    setPluginEnabledState(DEFAULT_SETTINGS[SETTINGS_KEYS.PLUGIN_ENABLED]);
    refreshModeHUD();
    setStatus(STATUS_TYPES.ERROR, 'Failed to load settings. Using defaults.');
  } finally {
    if (!isRoundActive) {
      setActionButtonsDisabled(false);
    }
    refreshModeHUD();
  }
}
