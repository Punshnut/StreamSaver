/**
 * popup/ui.js
 *
 * DOM state management for the popup. Owns all direct references to HTML
 * elements and exposes them as module-level exports so other modules can read
 * them without querying the DOM themselves.
 *
 * State exports (let — mutated by setter functions below):
 *   isRoundActive           — true while an action is in flight; blocks new clicks
 *   isQuickResolutionVisible — current visibility of the quick-resolution panel
 *   isPluginEnabled          — mirrors the stored plugin-enabled flag
 *   idleStatusType/Message   — the "resting" status shown after temp messages expire
 *
 * Key functions:
 *   setStatus / setIdleStatus     — status bar updates
 *   lockControls / releaseControls — UI action mutex
 *   setQuickResolutionVisibility  — panel show/hide sync
 *   setPluginEnabledState         — toggle + label + CSS data-attr sync
 *   setReleaseCallback            — breaks circular dep with mode-quality.js
 */

import { STATUS_TYPES, SETTINGS_KEYS, DEFAULT_SETTINGS, READY_STATUS_MESSAGE, DISABLED_STATUS_MESSAGE, MODE_VALUES, MODE_SET } from './constants.js';

// ─── DOM element references ───────────────────────────────────────────────────
// Queried once at module evaluation time — the popup DOM is static.
export const statusEl = document.getElementById('status');
export const popupRoot = document.querySelector('.popup');
export const modeLowButton = document.getElementById('mode-low-btn');
export const modeMediumButton = document.getElementById('mode-medium-btn');
export const modeHighButton = document.getElementById('mode-high-btn');
export const modeToggleGroup = document.querySelector('.mode-toggle');
export const modeSummaryEl = document.getElementById('mode-summary');
export const qualityButtons = Array.from(document.querySelectorAll('.quality-btn'));
export const fastToggleLow = document.getElementById('fastToggleLow');
export const fastToggleMedium = document.getElementById('fastToggleMedium');
export const fastToggleHigh = document.getElementById('fastToggleHigh');
export const fastToggleMediumRow = document.getElementById('fastToggleMediumRow');
export const fastToggleMediumWrap = document.getElementById('fastToggleMediumWrap');
export const pluginEnabledToggle = document.getElementById('plugin-enabled');
export const pluginEnabledLabel = document.getElementById('plugin-enabled-label');
export const quickResolutionToggle = document.getElementById('quick-resolution-visible');
export const quickResolutionContent = document.getElementById('quick-resolution-content');
export const tripleModeToggle = document.getElementById('triple-mode-enabled');

// Flat list of all clickable action buttons — used to disable/enable them as a group.
export const actionButtons = [...qualityButtons, modeLowButton, modeMediumButton, modeHighButton].filter(
  (button) => button instanceof HTMLButtonElement
);

// ─── Mutable module state ──────────────────────────────────────────────────────
export let statusResetTimer = null;   // handle for the pending auto-reset timer
export let isRoundActive = false;     // true while an action is in flight
export let isQuickResolutionVisible = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.QUICK_RESOLUTION_VISIBLE]);
export let isPluginEnabled = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.PLUGIN_ENABLED]);
export let isTripleModeEnabled = Boolean(DEFAULT_SETTINGS[SETTINGS_KEYS.TRIPLE_MODE_ENABLED]);
export let idleStatusType = STATUS_TYPES.SUCCESS;      // resting status type
export let idleStatusMessage = READY_STATUS_MESSAGE;   // resting status text

// Callback pattern to break the circular dependency between ui.js and mode-quality.js:
// mode-quality.js registers refreshModeHUD here so releaseControls() can call it.
let onActionComplete = () => {};
export function setReleaseCallback(fn) { onActionComplete = fn; }

/** Clears any pending status reset timer. */
export function clearStatusResetTimer() {
  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }
}

/** Sets popup status and optional auto-reset.
 *  When autoResetMs > 0, reverts to the idle status after the given delay. */
export function setStatus(type, message, autoResetMs = 0) {
  clearStatusResetTimer(); // cancel any in-flight reset before setting the new message
  statusEl.dataset.state = type;   // drives CSS styling (color, icon)
  statusEl.textContent = message;

  if (autoResetMs > 0) {
    // Schedule a revert to the idle (resting) status after the success message has been read.
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
  // Does not update the status bar immediately — use setStatus() for that.
}

/** Toggles all popup action buttons. */
export function setActionButtonsDisabled(disabled) {
  actionButtons.forEach((button) => {
    button.disabled = Boolean(disabled);
  });
}

/** Starts an action; returns false when busy. */
export function lockControls(loadingMessage) {
  // Reject the new action if one is already running — prevents stacked requests.
  if (isRoundActive) {
    setStatus(STATUS_TYPES.LOADING, 'Another action is still running...');
    return false;
  }

  isRoundActive = true;
  setActionButtonsDisabled(true);  // prevent double-clicks
  setStatus(STATUS_TYPES.LOADING, loadingMessage);
  return true;
}

/** Completes the current popup action and restores button interactivity. */
export function releaseControls() {
  isRoundActive = false;
  setActionButtonsDisabled(false);
  // Fire the registered callback (refreshModeHUD) so the mode HUD always
  // reflects current state after any action completes.
  onActionComplete();
}

// Matches the CSS transition durations on .collapsible / .fade-toggle (styles.css)
// so `hidden` is only applied once the close animation has actually finished.
const COLLAPSE_TRANSITION_MS = 260;

/** Animates an element between shown/hidden using its `data-open` CSS transition,
 *  instead of snapping `hidden` on/off instantly. Works for both the grid-rows
 *  collapse technique (.collapsible) and the opacity/scale fade (.fade-toggle). */
export function setCollapsed(el, open) {
  if (!(el instanceof HTMLElement)) return;
  const nextOpen = Boolean(open);

  if (nextOpen) {
    // Remove hidden first so the element is back in layout, then flip data-open
    // on the next frame so the browser has a "closed" state to transition from.
    el.hidden = false;
    requestAnimationFrame(() => {
      el.dataset.open = 'true';
    });
  } else {
    el.dataset.open = 'false';
    setTimeout(() => {
      // Guard against a rapid re-open cancelling this stale timeout's effect.
      if (el.dataset.open === 'false') el.hidden = true;
    }, COLLAPSE_TRANSITION_MS);
  }
}

/** Syncs Quick Resolution panel visibility and ARIA state. */
export function setQuickResolutionVisibility(visible) {
  const nextVisible = Boolean(visible);
  isQuickResolutionVisible = nextVisible;

  setCollapsed(quickResolutionContent, nextVisible);

  // Keep the toggle input in sync with the actual state.
  if (quickResolutionToggle instanceof HTMLInputElement) {
    quickResolutionToggle.checked = nextVisible;
    // aria-expanded communicates the panel's open/closed state to screen readers.
    quickResolutionToggle.setAttribute('aria-expanded', String(nextVisible));
  }
}

/** Syncs Triple Mode toggle: shows/hides the Balanced mode button + resolution row. */
export function setTripleModeState(enabled) {
  const nextEnabled = Boolean(enabled);
  isTripleModeEnabled = nextEnabled;

  // Animated show/hide — keeps the Balanced button and resolution row out of the
  // layout when closed (rather than just visually dimming them) so the 2-column
  // mode-toggle layout is preserved when off, but fades/collapses instead of snapping.
  setCollapsed(modeMediumButton, nextEnabled);
  setCollapsed(fastToggleMediumWrap, nextEnabled);

  // data-triple-active drives the CSS grid-template-columns switch on .mode-toggle.
  if (modeToggleGroup instanceof HTMLElement) {
    modeToggleGroup.dataset.tripleActive = String(nextEnabled);
  }

  if (tripleModeToggle instanceof HTMLInputElement) {
    tripleModeToggle.checked = nextEnabled;
    tripleModeToggle.setAttribute('aria-expanded', String(nextEnabled));
  }
}

/** Syncs plugin enable/disable switch state and related visual cues. */
export function setPluginEnabledState(enabled) {
  const nextEnabled = Boolean(enabled);
  isPluginEnabled = nextEnabled;

  // data-plugin-enabled on the root drives CSS rules that dim the UI when disabled.
  if (popupRoot instanceof HTMLElement) {
    popupRoot.dataset.pluginEnabled = String(nextEnabled);
  }

  // Keep the toggle visually and semantically in sync.
  if (pluginEnabledToggle instanceof HTMLInputElement) {
    pluginEnabledToggle.checked = nextEnabled;
    pluginEnabledToggle.setAttribute('aria-checked', String(nextEnabled));
  }

  // Text label next to the toggle ("Enabled" / "Disabled").
  if (pluginEnabledLabel instanceof HTMLElement) {
    pluginEnabledLabel.textContent = nextEnabled ? 'Enabled' : 'Disabled';
  }

  // Also update the idle status message so the "plugin is disabled" notice appears
  // in the status bar when the popup re-opens while the plugin is off.
  setIdleStatus(STATUS_TYPES.SUCCESS, nextEnabled ? READY_STATUS_MESSAGE : DISABLED_STATUS_MESSAGE);
}
