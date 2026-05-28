/**
 * popup/idle-status.js
 *
 * Determines and applies the "resting" status the popup shows between active
 * actions. The idle status persists until an action is triggered; temporary
 * action statuses (loading, success, error) revert back to it after their timer.
 *
 * probeIdleStatus(showImmediately) — inspects active tab, updates idle status
 * decodeProbeSignal(response)      — maps probe response to status type/message
 */

import { STATUS_TYPES, READY_STATUS_MESSAGE, DISABLED_STATUS_MESSAGE, OPEN_TWITCH_STREAM_STATUS_MESSAGE, UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE, isTwitchUrl, isInjectableTwitchUrl } from './constants.js';
export { isTwitchUrl, isInjectableTwitchUrl };
import { isPluginEnabled, isRoundActive, setIdleStatus, setStatus } from './ui.js';
import { getActiveTab, sendMessageToTab, decodeDispatchError } from './messaging.js';

/** Maps content-script probe responses into a contextual idle status. */
export function decodeProbeSignal(response) {
  const message = response && typeof response.message === 'string' ? response.message : '';
  const normalized = message.toLowerCase();

  // The content script reports this when the plugin is off — propagate it to
  // the idle status so the popup always shows "disabled" while plugin is off.
  if (normalized.includes('plugin logic is disabled')) {
    return {
      type: STATUS_TYPES.SUCCESS,
      message: DISABLED_STATUS_MESSAGE
    };
  }

  // Any of these strings means the current Twitch page doesn't have a live player.
  const unsupportedPageSignals = [
    'not a supported stream player page',
    'are not supported',
    'not a live player view',
    'no visible player detected',
    'no twitch player found'
  ];

  if (unsupportedPageSignals.some((signal) => normalized.includes(signal))) {
    return {
      type: STATUS_TYPES.ERROR,
      message: 'Twitch is open, but no live stream player was found. Open a live stream and try again.'
    };
  }

  // Anything else (e.g. a supported stream page) → ready.
  return {
    type: STATUS_TYPES.SUCCESS,
    message: READY_STATUS_MESSAGE
  };
}

/** Detects active-tab readiness and updates the popup's idle status message. */
export async function probeIdleStatus(showImmediately = true) {
  // Start with the appropriate default based on plugin state — this is also what
  // gets applied if the tab query or message fails for an unexpected reason.
  let nextStatus = {
    type: STATUS_TYPES.SUCCESS,
    message: isPluginEnabled ? READY_STATUS_MESSAGE : DISABLED_STATUS_MESSAGE
  };

  // If the plugin is off we don't need to inspect the tab — apply the disabled
  // status immediately and return.
  if (!isPluginEnabled) {
    setIdleStatus(nextStatus.type, nextStatus.message);
    if (showImmediately && !isRoundActive) {
      setStatus(nextStatus.type, nextStatus.message);
    }
    return nextStatus;
  }

  try {
    const activeTab = await getActiveTab();
    const tabUrl = typeof activeTab.url === 'string' ? activeTab.url : '';

    if (!isTwitchUrl(tabUrl)) {
      // Not a Twitch page at all.
      nextStatus = {
        type: STATUS_TYPES.ERROR,
        message: OPEN_TWITCH_STREAM_STATUS_MESSAGE
      };
    } else if (!isInjectableTwitchUrl(tabUrl)) {
      // A Twitch page, but one we don't inject into (e.g. clips.twitch.tv).
      nextStatus = {
        type: STATUS_TYPES.ERROR,
        message: UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE
      };
    } else {
      // Looks like a valid Twitch URL — ask the content script for its state.
      try {
        const probeResponse = await sendMessageToTab(activeTab.id, { action: 'streamsaverPopupProbe' });
        nextStatus = decodeProbeSignal(probeResponse);
      } catch (error) {
        // Content script didn't respond — likely not injected yet (fresh tab, wrong page).
        nextStatus = {
          type: STATUS_TYPES.ERROR,
          message: decodeDispatchError(error.message)
        };
      }
    }
  } catch (error) {
    // getActiveTab() failed — no active tab or permission issue.
    nextStatus = {
      type: STATUS_TYPES.ERROR,
      message: decodeDispatchError(error.message)
    };
  }

  // Always update the idle baseline so auto-reset timers revert to the right message.
  setIdleStatus(nextStatus.type, nextStatus.message);

  // showImmediately=false is used when the plugin toggle fires a probe — in that
  // case we only want to update the baseline, not override an in-flight action's status.
  if (showImmediately && !isRoundActive) {
    setStatus(nextStatus.type, nextStatus.message);
  }

  return nextStatus;
}
