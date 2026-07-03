/**
 * popup/messaging.js
 *
 * All chrome.tabs / chrome.runtime communication from the popup to the active
 * content script. Provides a clean async API over the callback-based Chrome
 * extension messaging APIs.
 *
 * getActiveTab()               — Promise wrapper for chrome.tabs.query
 * sendMessageToTab()           — Promise wrapper for chrome.tabs.sendMessage
 * dispatchToActiveTab()        — combines both with URL guards
 * decodeDispatchError()        — maps raw chrome error strings to user-facing messages
 * launchActionWithStatus()     — full action dispatch with UI lock/unlock
 * craftSuccessLabel()          — builds the success status string after quality is applied
 * craftQualityRequest()        — builds the { action, targetQuality } message object
 * isStructuredActionResponse() — validates the content script returned a proper envelope
 */

import { ACTION_NAMES, STATUS_TYPES, UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE, OPEN_TWITCH_STREAM_STATUS_MESSAGE, RELOAD_TWITCH_TAB_STATUS_MESSAGE, POPUP_TIMINGS, isTwitchUrl, isInjectableTwitchUrl } from './constants.js';
import { resolveQuality } from '../shared/constants.js';
import { isPluginEnabled, setStatus, lockControls, releaseControls, idleStatusType, idleStatusMessage } from './ui.js';

/** Reads the currently focused browser tab in the current window. */
export function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        reject(new Error('No active browser tab found.'));
        return;
      }

      resolve(tabs[0]);
    });
  });
}

/** Sends a tab message and rejects runtime errors. */
export function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        // Common cause: content script not injected (wrong page, extension just installed).
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response || typeof response !== 'object') {
        reject(new Error('Invalid response from content script.'));
        return;
      }

      resolve(response);
    });
  });
}

/** Maps low-level extension transport errors to user-facing messages. */
export function decodeDispatchError(errorMessage) {
  const normalized = String(errorMessage || '').toLowerCase();

  // These checks map specific chrome error substrings to helpful popup messages.
  // Order matters — more specific checks come before generic fallbacks.

  if (normalized.includes('active tab is not a supported twitch host')) {
    return UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE;
  }

  if (normalized.includes('active tab is not twitch.tv')) {
    return OPEN_TWITCH_STREAM_STATUS_MESSAGE;
  }

  // "receiving end does not exist" means the content script isn't loaded in this tab.
  // This happens on pages where the manifest didn't inject the script (wrong URL scheme,
  // brand new tab that hasn't loaded yet, or a tab that was open before the extension installed).
  if (normalized.includes('receiving end does not exist')) {
    return `No StreamSaver connection in this tab. ${OPEN_TWITCH_STREAM_STATUS_MESSAGE} ${RELOAD_TWITCH_TAB_STATUS_MESSAGE}`;
  }

  // chrome:// pages and some extension pages reject content injection entirely.
  if (normalized.includes('cannot access contents of url')) {
    return `This page cannot be controlled by StreamSaver. ${OPEN_TWITCH_STREAM_STATUS_MESSAGE}`;
  }

  if (normalized.includes('cannot access a chrome:// url')) {
    return 'This tab cannot run StreamSaver. Open a Twitch stream tab.';
  }

  if (normalized.includes('no active browser tab found')) {
    return OPEN_TWITCH_STREAM_STATUS_MESSAGE;
  }

  // Unknown error — include the raw message so the user has something to report.
  return `Request failed: ${errorMessage}`;
}

/** Dispatches one message to the active Twitch tab only. */
export async function dispatchToActiveTab(message) {
  const activeTab = await getActiveTab();

  // Guard 1: not even a Twitch URL — give a clear "open Twitch" message.
  if (activeTab.url && !isTwitchUrl(activeTab.url)) {
    throw new Error('Active tab is not twitch.tv.');
  }
  // Guard 2: a Twitch subdomain we don't inject into (e.g. clips.twitch.tv).
  if (activeTab.url && !isInjectableTwitchUrl(activeTab.url)) {
    throw new Error('Active tab is not a supported Twitch host.');
  }

  return sendMessageToTab(activeTab.id, message);
}

/** Ensures content script replies use the expected structured response envelope. */
export function isStructuredActionResponse(response, expectedAction) {
  if (!response || typeof response !== 'object') {
    return false;
  }
  if (typeof response.ok !== 'boolean' || typeof response.action !== 'string' || typeof response.message !== 'string') {
    return false;
  }
  // The action field must echo back the action we sent — prevents cross-message confusion.
  return response.action === expectedAction;
}

/** Builds a concise popup success label from structured response details. */
export function craftSuccessLabel(request, response) {
  const details = response && typeof response.details === 'object' ? response.details : {};

  const requestedQuality = resolveQuality(details.requestedQuality, '');
  const appliedQuality = resolveQuality(details.appliedQuality || details.targetQuality, '');
  const adjustment = details && typeof details.resolutionAdjustment === 'object' ? details.resolutionAdjustment : null;
  const direction = adjustment && adjustment.direction === 'up' ? 'up' : adjustment && adjustment.direction === 'down' ? 'down' : '';

  // If the applied quality differs from what was requested, a boundary fallback was used.
  // Show a specific message so the user understands why they got a different quality.
  if (requestedQuality && appliedQuality && requestedQuality !== appliedQuality) {
    if (direction === 'down') {
      return `Requested ${requestedQuality} unavailable. Using highest available: ${appliedQuality}.`;
    }
    if (direction === 'up') {
      return `Requested ${requestedQuality} unavailable. Using lowest available: ${appliedQuality}.`;
    }
    return `Requested ${requestedQuality} unavailable. Applied ${appliedQuality}.`;
  }

  // Normal setQuality success — just confirm what was applied.
  if (request.action === ACTION_NAMES.SET_QUALITY) {
    const targetQuality = resolveQuality(details.appliedQuality || details.targetQuality, '');
    if (targetQuality) {
      return `Applied ${targetQuality}.`;
    }
  }

  // Fallback to the raw response message or a generic string.
  return response.message || 'Action completed.';
}

/** Runs one action and updates popup status. */
export async function launchActionWithStatus(request, loadingMessage) {
  // Guard: don't send if the plugin is disabled — the content script would reject
  // it anyway, but we show a clearer message from the popup side. Manual-override
  // requests (quick-resolution buttons) bypass this so they work even when off.
  if (!isPluginEnabled && !request.manualOverride) {
    setStatus(STATUS_TYPES.ERROR, 'Plugin logic is disabled. Turn it on to apply quality changes.');
    return;
  }

  // Acquire the UI lock — disables buttons and shows the loading message.
  // Returns false if another action is already running.
  if (!lockControls(loadingMessage)) {
    return;
  }

  try {
    const response = await dispatchToActiveTab(request);

    // Validate that the response matches the expected shape and action.
    if (!isStructuredActionResponse(response, request.action)) {
      setStatus(STATUS_TYPES.ERROR, 'Invalid response from content script.');
      return;
    }

    if (!response.ok) {
      // Content script reported a failure — show its message directly.
      setStatus(STATUS_TYPES.ERROR, response.message || 'Action failed.');
      return;
    }

    // Success — show a human-readable summary and auto-reset after a short delay.
    setStatus(STATUS_TYPES.SUCCESS, craftSuccessLabel(request, response), POPUP_TIMINGS.STATUS_SUCCESS_RESET_MS);
  } catch (error) {
    console.error('[StreamSaver][popup] Message dispatch failed:', error);
    // Transport-level error — decode to a user-friendly string.
    setStatus(STATUS_TYPES.ERROR, decodeDispatchError(error.message));
  } finally {
    // Always release the lock — re-enables buttons and runs the release callback
    // (refreshModeHUD) regardless of success or failure.
    releaseControls();
  }
}

/** Creates the normalized payload used for direct quality-set actions. */
export function craftQualityRequest(quality, manualOverride = false) {
  return {
    action: ACTION_NAMES.SET_QUALITY,
    targetQuality: quality,
    manualOverride
  };
}
