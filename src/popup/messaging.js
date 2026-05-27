import { ACTION_NAMES, STATUS_TYPES, UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE, OPEN_TWITCH_STREAM_STATUS_MESSAGE, RELOAD_TWITCH_TAB_STATUS_MESSAGE, QUALITY_SET } from './constants.js';
import { isPluginEnabled, setStatus, beginAction, endAction, idleStatusType, idleStatusMessage } from './ui.js';

/** Accepts only supported quality values and falls back otherwise. (Local copy to avoid circular dep with mode-quality.js) */
function sanitizeQualityValue(value, fallback) {
  return QUALITY_SET.has(value) ? value : fallback;
}

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
export function mapDispatchErrorToUserMessage(errorMessage) {
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

/** True when a URL points to any Twitch page/subdomain. */
function isTwitchUrl(url) {
  return typeof url === 'string' && /^https:\/\/([a-z0-9-]+\.)?twitch\.tv\//i.test(url);
}

/** True when URL matches the host where this extension injects content scripts. */
function isInjectableTwitchUrl(url) {
  return typeof url === 'string' && /^https:\/\/www\.twitch\.tv\//i.test(url);
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
export function buildSuccessStatusMessage(request, response) {
  const details = response && typeof response.details === 'object' ? response.details : {};
  const requestedQuality = sanitizeQualityValue(details.requestedQuality, '');
  const appliedQuality = sanitizeQualityValue(details.appliedQuality || details.targetQuality, '');
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
    const targetQuality = sanitizeQualityValue(details.appliedQuality || details.targetQuality, '');
    if (targetQuality) {
      return `Applied ${targetQuality}.`;
    }
  }

  return response.message || 'Action completed.';
}

/** Runs one action and updates popup status. */
export async function runActionWithStatus(request, loadingMessage) {
  if (!isPluginEnabled) {
    setStatus(STATUS_TYPES.ERROR, 'Plugin logic is disabled. Turn it on to apply quality changes.');
    return;
  }

  if (!beginAction(loadingMessage)) {
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

    setStatus(STATUS_TYPES.SUCCESS, buildSuccessStatusMessage(request, response), 1500);
  } catch (error) {
    console.error('[StreamSaver][popup] Message dispatch failed:', error);
    setStatus(STATUS_TYPES.ERROR, mapDispatchErrorToUserMessage(error.message));
  } finally {
    endAction();
  }
}

/** Creates the normalized payload used for direct quality-set actions. */
export function buildSetQualityRequest(quality) {
  return {
    action: ACTION_NAMES.SET_QUALITY,
    targetQuality: quality
  };
}
