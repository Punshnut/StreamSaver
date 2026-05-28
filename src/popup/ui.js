import { STATUS_TYPES, SETTINGS_KEYS, DEFAULT_SETTINGS, READY_STATUS_MESSAGE, DISABLED_STATUS_MESSAGE, MODE_VALUES, MODE_SET } from './constants.js';

// DOM element refs
export const statusEl = document.getElementById('status');
export const popupRoot = document.querySelector('.popup');
export const modeLowButton = document.getElementById('mode-low-btn');
export const modeHighButton = document.getElementById('mode-high-btn');
export const modeSummaryEl = document.getElementById('mode-summary');
export const qualityButtons = Array.from(document.querySelectorAll('.quality-btn'));
export const fastToggleLow = document.getElementById('fastToggleLow');
export const fastToggleHigh = document.getElementById('fastToggleHigh');
export const pluginEnabledToggle = document.getElementById('plugin-enabled');
export const pluginEnabledLabel = document.getElementById('plugin-enabled-label');
export const quickResolutionToggle = document.getElementById('quick-resolution-visible');
export const quickResolutionContent = document.getElementById('quick-resolution-content');
export const actionButtons = [...qualityButtons, modeLowButton, modeHighButton].filter(
  (button) => button instanceof HTMLButtonElement
);

// Module-level state
export let statusResetTimer = null;
export let isRoundActive = false;
export let isQuickResolutionVisible = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]);
export let isPluginEnabled = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.PLUGIN_ENABLED]);
export let idleStatusType = STATUS_TYPES.SUCCESS;
export let idleStatusMessage = READY_STATUS_MESSAGE;

// Callback pattern to break circular dep: releaseControls → refreshModeHUD (in mode-quality.js)
let onActionComplete = () => {};
export function setReleaseCallback(fn) { onActionComplete = fn; }

/** Clears any pending status reset timer. */
export function clearStatusResetTimer() {
  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }
}

/** Sets popup status and optional auto-reset. */
export function setStatus(type, message, autoResetMs = 0) {
  clearStatusResetTimer();
  statusEl.dataset.state = type;
  statusEl.textContent = message;

  if (autoResetMs > 0) {
    statusResetTimer = setTimeout(() => {
      statusEl.dataset.state = idleStatusType;
      statusEl.textContent = idleStatusMessage;
      statusResetTimer = null;
    }, autoResetMs);
  }
}

/** Stores the default status shown after temporary status updates expire. */
export function setIdleStatus(type, message) {
  idleStatusType = type;
  idleStatusMessage = message;
}

/** Toggles all popup action buttons. */
export function setActionButtonsDisabled(disabled) {
  actionButtons.forEach((button) => {
    button.disabled = Boolean(disabled);
  });
}

/** Starts an action; returns false when busy. */
export function lockControls(loadingMessage) {
  if (isRoundActive) {
    setStatus(STATUS_TYPES.LOADING, 'Another action is still running...');
    return false;
  }

  isRoundActive = true;
  setActionButtonsDisabled(true);
  setStatus(STATUS_TYPES.LOADING, loadingMessage);
  return true;
}

/** Completes the current popup action and restores button interactivity. */
export function releaseControls() {
  isRoundActive = false;
  setActionButtonsDisabled(false);
  onActionComplete();
}

/** Syncs Quick Resolution visibility and ARIA state. */
export function setQuickResolutionVisibility(visible) {
  const nextVisible = Boolean(visible);
  isQuickResolutionVisible = nextVisible;

  if (quickResolutionContent instanceof HTMLElement) {
    quickResolutionContent.hidden = !nextVisible;
  }

  if (quickResolutionToggle instanceof HTMLInputElement) {
    quickResolutionToggle.checked = nextVisible;
    quickResolutionToggle.setAttribute('aria-expanded', String(nextVisible));
  }

}

/** Syncs plugin enable/disable switch state and related visual cues. */
export function setPluginEnabledState(enabled) {
  const nextEnabled = Boolean(enabled);
  isPluginEnabled = nextEnabled;

  if (popupRoot instanceof HTMLElement) {
    popupRoot.dataset.pluginEnabled = String(nextEnabled);
  }

  if (pluginEnabledToggle instanceof HTMLInputElement) {
    pluginEnabledToggle.checked = nextEnabled;
    pluginEnabledToggle.setAttribute('aria-checked', String(nextEnabled));
  }

  if (pluginEnabledLabel instanceof HTMLElement) {
    pluginEnabledLabel.textContent = nextEnabled ? 'Enabled' : 'Disabled';
  }

  setIdleStatus(STATUS_TYPES.SUCCESS, nextEnabled ? READY_STATUS_MESSAGE : DISABLED_STATUS_MESSAGE);
}
