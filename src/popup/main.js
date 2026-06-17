/**
 * popup/main.js
 *
 * Popup entry point. Executed once when the extension popup window opens.
 *
 * Responsibilities:
 *   1. bindActionHandlers() — attaches click listeners to quality and mode buttons
 *   2. fastToggleLow/High change listeners — persist dropdown, apply quality if active
 *   3. pluginEnabledToggle change listener — save, probe status, apply quality if now enabled
 *   4. quickResolutionToggle change listener — show/hide panel, save preference
 *   5. Initial hydration — refreshModeHUD, setPluginEnabledState, setQuickResolutionVisibility,
 *      loadSettings (which also probes the active tab for idle status)
 */

import { SETTINGS_KEYS, MODE_VALUES, DEFAULT_SETTINGS } from './constants.js';
import { qualityButtons, modeLowButton, modeHighButton, pluginEnabledToggle, quickResolutionToggle, fastToggleLow, fastToggleHigh, isPluginEnabled, isQuickResolutionVisible, setQuickResolutionVisibility, setPluginEnabledState } from './ui.js';
import { refreshModeHUD, handleQualityButtonClick, handleModeButtonClick, getModeLabel, readModeResolutions, currentActiveMode, sanitizeModeValue, sanitizeQualityValue, isSupportedQuality } from './mode-quality.js';
import { launchActionWithStatus, craftQualityRequest } from './messaging.js';
import { loadSettings, saveSetting, handleSelectChange } from './settings.js';
import { probeIdleStatus } from './idle-status.js';

/** Binds click handlers for quality and mode controls. */
function bindActionHandlers() {
  // Each quality button carries its target quality in data-quality.
  qualityButtons.forEach((button) => {
    button.addEventListener('click', () => {
      handleQualityButtonClick(button);
    });
  });

  modeLowButton.addEventListener('click', () => {
    handleModeButtonClick(MODE_VALUES.LOW);
  });

  modeHighButton.addEventListener('click', () => {
    handleModeButtonClick(MODE_VALUES.HIGH);
  });
}

// ─── FastToggleLow dropdown ────────────────────────────────────────────────────
// When the user changes the low-mode quality preset, persist it and immediately
// apply it if low mode is currently active (so the change takes effect at once).
fastToggleLow.addEventListener('change', () => {
  handleSelectChange(SETTINGS_KEYS.LOW, fastToggleLow);
  if (currentActiveMode === MODE_VALUES.LOW) {
    const quality = sanitizeQualityValue(fastToggleLow.value, DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]);
    launchActionWithStatus(craftQualityRequest(quality), `Applying ${quality}...`);
  }
});

// ─── FastToggleHigh dropdown ───────────────────────────────────────────────────
fastToggleHigh.addEventListener('change', () => {
  handleSelectChange(SETTINGS_KEYS.HIGH, fastToggleHigh);
  if (currentActiveMode === MODE_VALUES.HIGH) {
    const quality = sanitizeQualityValue(fastToggleHigh.value, DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH]);
    launchActionWithStatus(craftQualityRequest(quality), `Applying ${quality}...`);
  }
});

// ─── Plugin enable/disable toggle ─────────────────────────────────────────────
if (pluginEnabledToggle instanceof HTMLInputElement) {
  pluginEnabledToggle.addEventListener('change', async () => {
    const nextEnabled = pluginEnabledToggle.checked;
    const previousEnabled = isPluginEnabled; // capture before the optimistic update

    // Optimistically update the UI so it feels instant.
    setPluginEnabledState(nextEnabled);

    const didSave = await saveSetting(
      SETTINGS_KEYS.PLUGIN_ENABLED,
      nextEnabled,
      nextEnabled ? 'Plugin logic enabled.' : 'Plugin logic disabled.'
    );

    // Roll back the UI if the storage write failed.
    if (!didSave) {
      setPluginEnabledState(previousEnabled);
      return;
    }

    // Re-probe the active tab so the idle status reflects the new plugin state.
    await probeIdleStatus(false);

    // Nothing more to do if the plugin was disabled.
    if (!nextEnabled) {
      return;
    }

    // Plugin was just enabled — immediately apply the current mode's target quality
    // so the user doesn't have to click again.
    const { lowValue, highValue } = readModeResolutions();
    const activeMode = sanitizeModeValue(currentActiveMode, MODE_VALUES.HIGH);
    const targetQuality = activeMode === MODE_VALUES.LOW ? lowValue : highValue;
    launchActionWithStatus(craftQualityRequest(targetQuality), `Applying ${targetQuality} for ${getModeLabel(activeMode)}...`);
  });
}

// ─── Quick Resolution visibility toggle ───────────────────────────────────────
// Controls whether the manual quick-resolution panel is shown in the popup.
if (quickResolutionToggle instanceof HTMLInputElement) {
  quickResolutionToggle.addEventListener('change', () => {
    const visible = quickResolutionToggle.checked;
    setQuickResolutionVisibility(visible);
    saveSetting(
      SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE,
      visible,
      visible ? 'Quick Resolution shown.' : 'Quick Resolution hidden.'
    );
  });
}

// ─── Initial hydration ────────────────────────────────────────────────────────
// Run in order: bind handlers → refresh HUD → apply stored enabled/visibility state
// → load full settings from storage (which also probes the active tab).
bindActionHandlers();
refreshModeHUD();
setPluginEnabledState(isPluginEnabled);
setQuickResolutionVisibility(isQuickResolutionVisible);
loadSettings();
