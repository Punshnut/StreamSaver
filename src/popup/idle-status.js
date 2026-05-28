import { STATUS_TYPES, READY_STATUS_MESSAGE, DISABLED_STATUS_MESSAGE, OPEN_TWITCH_STREAM_STATUS_MESSAGE, UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE, isTwitchUrl, isInjectableTwitchUrl } from './constants.js';
export { isTwitchUrl, isInjectableTwitchUrl };
import { isPluginEnabled, isRoundActive, setIdleStatus, setStatus } from './ui.js';
import { getActiveTab, sendMessageToTab, decodeDispatchError } from './messaging.js';

/** Maps content-script probe responses into a contextual idle status. */
export function decodeProbeSignal(response) {
  const message = response && typeof response.message === 'string' ? response.message : '';
  const normalized = message.toLowerCase();

  if (normalized.includes('plugin logic is disabled')) {
    return {
      type: STATUS_TYPES.SUCCESS,
      message: DISABLED_STATUS_MESSAGE
    };
  }

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

  return {
    type: STATUS_TYPES.SUCCESS,
    message: READY_STATUS_MESSAGE
  };
}

/** Detects active-tab readiness and updates the popup's idle status message. */
export async function probeIdleStatus(showImmediately = true) {
  let nextStatus = {
    type: STATUS_TYPES.SUCCESS,
    message: isPluginEnabled ? READY_STATUS_MESSAGE : DISABLED_STATUS_MESSAGE
  };

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
      nextStatus = {
        type: STATUS_TYPES.ERROR,
        message: OPEN_TWITCH_STREAM_STATUS_MESSAGE
      };
    } else if (!isInjectableTwitchUrl(tabUrl)) {
      nextStatus = {
        type: STATUS_TYPES.ERROR,
        message: UNSUPPORTED_TWITCH_HOST_STATUS_MESSAGE
      };
    } else {
      try {
        const probeResponse = await sendMessageToTab(activeTab.id, { action: 'streamsaverPopupProbe' });
        nextStatus = decodeProbeSignal(probeResponse);
      } catch (error) {
        nextStatus = {
          type: STATUS_TYPES.ERROR,
          message: decodeDispatchError(error.message)
        };
      }
    }
  } catch (error) {
    nextStatus = {
      type: STATUS_TYPES.ERROR,
      message: decodeDispatchError(error.message)
    };
  }

  setIdleStatus(nextStatus.type, nextStatus.message);
  if (showImmediately && !isRoundActive) {
    setStatus(nextStatus.type, nextStatus.message);
  }

  return nextStatus;
}
