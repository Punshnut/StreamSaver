/**
 * popup/mode-quality.js
 *
 * Handles the mode system (Data Saver / Balanced / High Quality — Balanced only
 * shown when Triple Mode is enabled) and the quality button interactions in
 * the popup.
 *
 * currentActiveMode        — module-level variable for the active mode key
 * lastStandardMode         — last Low/High mode pressed (never Balanced); used to
 *                            fall back to a standard mode when Triple Mode is disabled
 * refreshModeHUD()         — syncs button states and summary text
 * handleQualityButtonClick() — dispatches a direct quality-set action
 * handleModeButtonClick()  — saves mode, applies its quality, updates HUD
 */

import { QUALITY_SET, MODE_SET, MODE_VALUES, MODE_LABELS, SETTINGS_KEYS, DEFAULT_SETTINGS, STATUS_TYPES, POPUP_TIMINGS } from './constants.js';
import { resolveQuality } from '../shared/constants.js';
import { isPluginEnabled, setStatus, popupRoot, modeLowButton, modeMediumButton, modeHighButton, modeSummaryEl, fastToggleLow, fastToggleMedium, fastToggleHigh, setReleaseCallback } from './ui.js';
import { launchActionWithStatus, craftQualityRequest } from './messaging.js';
import { saveSetting } from './settings.js';

// currentActiveMode lives here because all mode-related logic is in this module.
// settings.js sets it via setCurrentActiveMode() after loading from storage.
export let currentActiveMode = DEFAULT_SETTINGS[SETTINGS_KEYS.ACTIVE_MODE];

/** Updates the in-memory mode value (called by settings.js after storage load). */
export function setCurrentActiveMode(value) {
  currentActiveMode = value;
}

// lastStandardMode remembers the last Low/High mode pressed (never Balanced), so
// disabling Triple Mode while Balanced is active knows which mode to fall back to.
export let lastStandardMode = DEFAULT_SETTINGS[SETTINGS_KEYS.LAST_STANDARD_MODE];

/** Updates the in-memory last-standard-mode value. */
export function setLastStandardMode(value) {
  lastStandardMode = value;
}

// Register refreshModeHUD as the releaseControls callback to break the circular dep.
// This runs after the module is evaluated, so refreshModeHUD is defined by then.
// We use a deferred registration pattern: call setReleaseCallback here after defining the function.

/** Accepts only supported quality values and falls back otherwise. */
export function sanitizeQualityValue(value, fallback) {
  // resolveQuality returns fallback for any value not in QUALITY_SET.
  return resolveQuality(value, fallback);
}

/** Normalizes mode values with fallback. */
export function sanitizeModeValue(value, fallback) {
  return MODE_SET.has(value) ? value : fallback;
}

/** Normalizes to a "standard" (Low/High, never Balanced) mode value with fallback. */
export function sanitizeStandardModeValue(value, fallback) {
  return value === MODE_VALUES.LOW || value === MODE_VALUES.HIGH ? value : fallback;
}

/** Quick membership check for quality button and select input values. */
export function isSupportedQuality(value) {
  return QUALITY_SET.has(value);
}

/** Returns the display label for a mode key. */
export function getModeLabel(mode) {
  // Fallback to HIGH label for unknown mode keys so the HUD never shows undefined.
  return MODE_LABELS[mode] || MODE_LABELS[MODE_VALUES.HIGH];
}

/** Reads and sanitizes the configured low/high mode resolutions from dropdowns. */
export function readModeResolutions() {
  return {
    lowValue: sanitizeQualityValue(fastToggleLow.value, DEFAULT_SETTINGS[SETTINGS_KEYS.LOW]),
    mediumValue: sanitizeQualityValue(fastToggleMedium.value, DEFAULT_SETTINGS[SETTINGS_KEYS.MEDIUM]),
    highValue: sanitizeQualityValue(fastToggleHigh.value, DEFAULT_SETTINGS[SETTINGS_KEYS.HIGH])
  };
}

/** Updates mode button state and summary text. */
export function refreshModeHUD() {
  const activeMode = sanitizeModeValue(currentActiveMode, MODE_VALUES.HIGH);
  const lowIsActive = activeMode === MODE_VALUES.LOW;
  const mediumIsActive = activeMode === MODE_VALUES.MEDIUM;
  const highIsActive = activeMode === MODE_VALUES.HIGH;

  // data-active-mode drives CSS rules that style the active mode section.
  if (popupRoot instanceof HTMLElement) {
    popupRoot.dataset.activeMode = activeMode;
  }

  // Toggle the visual active state on each mode button.
  modeLowButton.dataset.active = String(lowIsActive);
  modeMediumButton.dataset.active = String(mediumIsActive);
  modeHighButton.dataset.active = String(highIsActive);

  // aria-pressed communicates toggle button state to screen readers.
  modeLowButton.setAttribute('aria-pressed', String(lowIsActive));
  modeMediumButton.setAttribute('aria-pressed', String(mediumIsActive));
  modeHighButton.setAttribute('aria-pressed', String(highIsActive));

  // Plain-language summary for sighted users.
  modeSummaryEl.textContent = `Current mode: ${getModeLabel(activeMode)}`;
}

// Register the callback now that refreshModeHUD is defined.
// releaseControls() will call this after every action completes so the HUD
// is always in sync even when an action was triggered from another module.
setReleaseCallback(refreshModeHUD);

/** Handles one quick-resolution button click and dispatches setQuality. */
export function handleQualityButtonClick(button) {
  const quality = sanitizeQualityValue(button.dataset.quality, 'Unknown');

  // Reject unknown values that somehow got into the button's data attribute.
  if (!isSupportedQuality(quality)) {
    setStatus(STATUS_TYPES.ERROR, 'Unsupported quality button value.');
    return;
  }

  // Quick-resolution buttons manually override the plugin-enabled gate so they
  // work even when plugin logic is turned off.
  launchActionWithStatus(craftQualityRequest(quality, true), `Applying ${quality}...`);
}

/** Saves mode change, then applies its target quality. */
export async function handleModeButtonClick(mode) {
  const normalizedMode = sanitizeModeValue(mode, MODE_VALUES.HIGH);

  // No-op if the clicked mode is already active — show a brief confirmation.
  if (normalizedMode === currentActiveMode) {
    setStatus(STATUS_TYPES.SUCCESS, `Mode already set: ${getModeLabel(normalizedMode)}.`, POPUP_TIMINGS.STATUS_INFO_RESET_MS);
    return;
  }

  // Optimistically update the HUD before the storage write so the UI feels instant.
  const previousMode = currentActiveMode;
  currentActiveMode = normalizedMode;
  refreshModeHUD();

  // Persist the new mode — roll back the optimistic update if the save fails.
  const didSave = await saveSetting(SETTINGS_KEYS.ACTIVE_MODE, normalizedMode, `Switched to ${getModeLabel(normalizedMode)}.`);
  if (!didSave) {
    currentActiveMode = previousMode;
    refreshModeHUD();
    return; // saveSetting already set an error status
  }

  // Remember the last Low/High mode pressed (never Balanced) so Triple Mode can be
  // switched off later and fall back to whatever standard mode the user last picked.
  if (normalizedMode !== MODE_VALUES.MEDIUM) {
    setLastStandardMode(normalizedMode);
    saveSetting(SETTINGS_KEYS.LAST_STANDARD_MODE, normalizedMode); // fire-and-forget
  }

  // If the plugin is off, save was still valuable (persists the preference) but
  // we shouldn't try to apply quality — tell the user explicitly.
  if (!isPluginEnabled) {
    setStatus(STATUS_TYPES.SUCCESS, 'Mode saved. Plugin logic is disabled, so no player changes were applied.', POPUP_TIMINGS.STATUS_SAVE_RESET_MS);
    return;
  }

  // Apply the mode's target quality immediately after switching.
  const { lowValue, mediumValue, highValue } = readModeResolutions();
  const targetQuality =
    normalizedMode === MODE_VALUES.LOW ? lowValue : normalizedMode === MODE_VALUES.MEDIUM ? mediumValue : highValue;
  launchActionWithStatus(craftQualityRequest(targetQuality), `Applying ${targetQuality} for ${getModeLabel(normalizedMode)}...`);
}
