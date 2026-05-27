import { SETTINGS_KEYS, MODE_VALUES } from './constants.js';
import { qualityButtons, modeLowButton, modeHighButton, pluginEnabledToggle, quickResolutionToggle, fastToggleLow, fastToggleHigh, isPluginEnabled, isQuickResolutionVisible, setQuickResolutionVisibility, setPluginEnabledState } from './ui.js';
import { syncModeButtonsState, handleQualityButtonClick, handleModeButtonClick, getModeLabel, readModeResolutions, currentActiveMode, sanitizeModeValue, isSupportedQuality } from './mode-quality.js';
import { runActionWithStatus, buildSetQualityRequest } from './messaging.js';
import { loadSettings, saveSetting, handleSelectChange } from './settings.js';
import { refreshIdleStatus } from './idle-status.js';

console.log('[StreamSaver][popup] Popup loaded');

/** Binds click handlers for quality and mode controls. */
function bindActionHandlers() {
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

fastToggleLow.addEventListener('change', () => {
  handleSelectChange(SETTINGS_KEYS.LOW, fastToggleLow);
});

fastToggleHigh.addEventListener('change', () => {
  handleSelectChange(SETTINGS_KEYS.HIGH, fastToggleHigh);
});

if (pluginEnabledToggle instanceof HTMLInputElement) {
  pluginEnabledToggle.addEventListener('change', async () => {
    const nextEnabled = pluginEnabledToggle.checked;
    const previousEnabled = isPluginEnabled;

    setPluginEnabledState(nextEnabled);
    const didSave = await saveSetting(
      SETTINGS_KEYS.PLUGIN_ENABLED,
      nextEnabled,
      nextEnabled ? 'Plugin logic enabled.' : 'Plugin logic disabled.'
    );

    if (!didSave) {
      setPluginEnabledState(previousEnabled);
      return;
    }

    await refreshIdleStatus(false);

    if (!nextEnabled) {
      return;
    }

    const { lowValue, highValue } = readModeResolutions();
    const activeMode = sanitizeModeValue(currentActiveMode, MODE_VALUES.HIGH);
    const targetQuality = activeMode === MODE_VALUES.LOW ? lowValue : highValue;
    runActionWithStatus(buildSetQualityRequest(targetQuality), `Applying ${targetQuality} for ${getModeLabel(activeMode)}...`);
  });
}

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

bindActionHandlers();
syncModeButtonsState();
setPluginEnabledState(isPluginEnabled);
setQuickResolutionVisibility(isQuickResolutionVisible);
loadSettings();
