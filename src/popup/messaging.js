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
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response || typeof response !== 'object') {
        reject(new Error('No valid response from page script.'));
        return;
      }

      resolve(response);
    });
  });
}

/** Maps low-level extension transport errors to user-facing messages. */
export function decodeDispatchError(errorMessage) {
  const normalized = String(errorMessage || '').toLowerCase();

  if (normalized.includes('active tab is not a supported twitch host')) {
    return UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE;
  }

  if (normalized.includes('active tab is not twitch.tv')) {
    return OPEN_TWITCH_STREAM_STATUS_MESSAGE;
  }

  if (normalized.includes('receiving end does not exist')) {
    return `No StreamSaver connection in this tab. ${OPEN_TWITCH_STREAM_STATUS_MESSAGE} ${RELOAD_TWITCH_TAB_STATUS_MESSAGE}`;
  }

  if (normalized.includes('cannot access contents of url')) {
    return `This page cannot be controlled by StreamSaver. ${OPEN_TWITCH_STREAM_STATUS_MESSAGE}`;
  }

  if (normalized.includes('cannot access a chrome:// url')) {
    return 'This tab cannot run StreamSaver. Open a Twitch stream tab.';
  }

  if (normalized.includes('no active browser tab found')) {
    return OPEN_TWITCH_STREAM_STATUS_MESSAGE;
  }

  return `Request failed: ${errorMessage}`;
}

/** Dispatches one message to the active Twitch tab only. */
export async function dispatchToActiveTab(message) {
  const activeTab = await getActiveTab();

  if (activeTab.url && !isTwitchUrl(activeTab.url)) {
    throw new Error('Active tab is not twitch.tv.');
  }
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
  return response.action === expectedAction;
}

/** Builds a concise popup success label from structured response details. */
export function craftSuccessLabel(request, response) {
  const details = response && typeof response.details === 'object' ? response.details : {};
  const requestedQuality = resolveQuality(details.requestedQuality, '');
  const appliedQuality = resolveQuality(details.appliedQuality || details.targetQuality, '');
  const adjustment = details && typeof details.resolutionAdjustment === 'object' ? details.resolutionAdjustment : null;
  const direction = adjustment && adjustment.direction === 'up' ? 'up' : adjustment && adjustment.direction === 'down' ? 'down' : '';

  if (requestedQuality && appliedQuality && requestedQuality !== appliedQuality) {
    if (direction === 'down') {
      return `Requested ${requestedQuality} unavailable. Using highest available: ${appliedQuality}.`;
    }
    if (direction === 'up') {
      return `Requested ${requestedQuality} unavailable. Using lowest available: ${appliedQuality}.`;
    }
    return `Requested ${requestedQuality} unavailable. Applied ${appliedQuality}.`;
  }

  if (request.action === ACTION_NAMES.SET_QUALITY) {
    const targetQuality = resolveQuality(details.appliedQuality || details.targetQuality, '');
    if (targetQuality) {
      return `Applied ${targetQuality}.`;
    }
  }

  return response.message || 'Action completed.';
}

/** Runs one action and updates popup status. */
export async function launchActionWithStatus(request, loadingMessage) {
  if (!isPluginEnabled) {
    setStatus(STATUS_TYPES.ERROR, 'Plugin logic is disabled. Turn it on to apply quality changes.');
    return;
  }

  if (!lockControls(loadingMessage)) {
    return;
  }

  try {
    const response = await dispatchToActiveTab(request);
    console.log('[StreamSaver][popup] Response from content script:', response);

    if (!isStructuredActionResponse(response, request.action)) {
      setStatus(STATUS_TYPES.ERROR, 'Invalid response from content script.');
      return;
    }

    if (!response.ok) {
      setStatus(STATUS_TYPES.ERROR, response.message || 'Action failed.');
      return;
    }

    setStatus(STATUS_TYPES.SUCCESS, craftSuccessLabel(request, response), POPUP_TIMINGS.STATUS_SUCCESS_RESET_MS);
  } catch (error) {
    console.error('[StreamSaver][popup] Message dispatch failed:', error);
    setStatus(STATUS_TYPES.ERROR, decodeDispatchError(error.message));
  } finally {
    releaseControls();
  }
}

/** Creates the normalized payload used for direct quality-set actions. */
export function craftQualityRequest(quality) {
  return {
    action: ACTION_NAMES.SET_QUALITY,
    targetQuality: quality
  };
}
