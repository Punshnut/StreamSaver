import { QUALITY_SET, MODE_SET, MODE_VALUES, MODE_LABELS, SETTINGS_KEYS, DEFAULT_SETTINGS, STATUS_TYPES } from './constants.js';
import { isPluginEnabled, setStatus, popupRoot, modeLowButton, modeHighButton, modeSummaryEl, fastToggleLow, fastToggleHigh, setEndActionCallback } from './ui.js';
import { runActionWithStatus, buildSetQualityRequest } from './messaging.js';
import { saveSetting } from './settings.js';

// currentActiveMode lives here because all mode-related logic is in this module.
// settings.js sets it via setCurrentActiveMode().
export let currentActiveMode = DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE];

export function setCurrentActiveMode(value) {
  currentActiveMode = value;
}

// Register syncModeButtonsState as the endAction callback to break the circular dep.
// This runs after the module is evaluated, so syncModeButtonsState is defined by then.
// We use a deferred registration pattern: call setEndActionCallback here after defining the function.

/** Accepts only supported quality values and falls back otherwise. */
export function sanitizeQualityValue(value, fallback) {
  return QUALITY_SET.has(value) ? value : fallback;
}

/** Normalizes mode values with fallback. */
export function sanitizeModeValue(value, fallback) {
  return MODE_SET.has(value) ? value : fallback;
}

/** Quick membership check for quality button and select input values. */
export function isSupportedQuality(value) {
  return QUALITY_SET.has(value);
}

/** Returns the display label for a mode key. */
export function getModeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS[MODE_VALUES.HIGH];
}

/** Reads and sanitizes the configured low/high mode resolutions from dropdowns. */
export function readModeResolutions() {
  return {
    lowValue: sanitizeQualityValue(fastToggleLow.value, DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]),
    highValue: sanitizeQualityValue(fastToggleHigh.value, DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH])
  };
}

/** Updates mode button state and summary text. */
export function syncModeButtonsState() {
  const activeMode = sanitizeModeValue(currentActiveMode, MODE_VALUES.HIGH);
  const lowIsActive = activeMode === MODE_VALUES.LOW;
  const highIsActive = activeMode === MODE_VALUES.HIGH;

  if (popupRoot instanceof HTMLElement) {
    popupRoot.dataset.activeMode = activeMode;
  }
  modeLowButton.dataset.active = String(lowIsActive);
  modeHighButton.dataset.active = String(highIsActive);
  modeLowButton.setAttribute('aria-pressed', String(lowIsActive));
  modeHighButton.setAttribute('aria-pressed', String(highIsActive));
  modeSummaryEl.textContent = `Current mode: ${getModeLabel(activeMode)}`;
}

// Register the callback now that syncModeButtonsState is defined.
setEndActionCallback(syncModeButtonsState);

/** Handles one quick-resolution button click and dispatches setQuality. */
export function handleQualityButtonClick(button) {
  const quality = sanitizeQualityValue(button.dataset.quality, 'Unknown');
  console.log(`[StreamSaver][popup] Quality click: ${quality}`);

  if (!isSupportedQuality(quality)) {
    setStatus(STATUS_TYPES.ERROR, 'Unsupported quality button value.');
    return;
  }

  runActionWithStatus(buildSetQualityRequest(quality), `Applying ${quality}...`);
}

/** Saves mode change, then applies its target quality. */
export async function handleModeButtonClick(mode) {
  const normalizedMode = sanitizeModeValue(mode, MODE_VALUES.HIGH);

  if (normalizedMode === currentActiveMode) {
    setStatus(STATUS_TYPES.SUCCESS, `Mode already set: ${getModeLabel(normalizedMode)}.`, 1000);
    return;
  }

  const previousMode = currentActiveMode;
  currentActiveMode = normalizedMode;
  syncModeButtonsState();
  const didSave = await saveSetting(SETTINGS_KEYS.ACTIVE_MODE, normalizedMode, `Mode set: ${getModeLabel(normalizedMode)}.`);
  if (!didSave) {
    currentActiveMode = previousMode;
    syncModeButtonsState();
    return;
  }

  if (!isPluginEnabled) {
    setStatus(STATUS_TYPES.SUCCESS, 'Mode saved. Plugin logic is disabled, so no player changes were applied.', 1400);
    return;
  }

  const { lowValue, highValue } = readModeResolutions();
  const targetQuality = normalizedMode === MODE_VALUES.LOW ? lowValue : highValue;
  runActionWithStatus(buildSetQualityRequest(targetQuality), `Applying ${targetQuality} for ${getModeLabel(normalizedMode)}...`);
}
