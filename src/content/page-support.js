import { QUALITY_SET, MODE_SET, MODE_VALUES } from './constants.js';
import { debug, serializeForMessage } from './utils.js';
import { getPlayerRoot } from './player.js';
import { normalizeQualityLabel } from './quality-matching.js';

/** Classifies current Twitch URL as supported/unsupported with a clear reason. */
export function isSupportedTwitchPage() {
  if (!location.hostname.endsWith('twitch.tv')) {
    const result = {
      supported: false,
      reason: 'Unsupported host: not a twitch.tv page.',
      details: { hostname: location.hostname }
    };
    debug('Page rejected', result);
    return result;
  }

  const rawPath = location.pathname || '/';
  const normalizedPath = rawPath.replace(/\/+$/, '') || '/';
  const lowerPath = normalizedPath.toLowerCase();
  const segments = lowerPath.split('/').filter(Boolean);

  if (normalizedPath === '/') {
    const result = {
      supported: false,
      reason: 'Homepage is not a supported stream player page.',
      details: { path: normalizedPath }
    };
    debug('Page rejected', result);
    return result;
  }

  if (lowerPath.startsWith('/directory')) {
    const result = {
      supported: false,
      reason: 'Directory/category pages are not supported.',
      details: { path: normalizedPath }
    };
    debug('Page rejected', result);
    return result;
  }

  if (lowerPath.startsWith('/clips') || lowerPath.includes('/clip/')) {
    const result = {
      supported: false,
      reason: 'Clips pages are not supported.',
      details: { path: normalizedPath }
    };
    debug('Page rejected', result);
    return result;
  }

  const unsupportedRootPaths = new Set([
    'downloads',
    'jobs',
    'settings',
    'search',
    'p',
    'wallet',
    'friends',
    'messages',
    'subscriptions'
  ]);
  if (segments.length > 0 && unsupportedRootPaths.has(segments[0])) {
    const result = {
      supported: false,
      reason: 'This Twitch page type does not support stream quality automation.',
      details: { path: normalizedPath, rootSegment: segments[0] }
    };
    debug('Page rejected', result);
    return result;
  }

  const unsupportedChannelSubpages = new Set(['about', 'schedule', 'videos', 'clips', 'collections']);
  if (segments.length >= 2 && unsupportedChannelSubpages.has(segments[1])) {
    const result = {
      supported: false,
      reason: 'Channel subpage is not a live player view.',
      details: { path: normalizedPath, subpage: segments[1] }
    };
    debug('Page rejected', result);
    return result;
  }

  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    const result = {
      supported: false,
      reason: 'No visible player detected. This is likely not a live stream page.',
      details: { path: normalizedPath, playerCode: playerRootResult.code }
    };
    debug('Page rejected', result);
    return result;
  }

  const accepted = {
    supported: true,
    reason: 'Supported Twitch live stream page detected.',
    details: {
      path: normalizedPath,
      playerSelector: playerRootResult.details.selector
    }
  };
  debug('Page accepted', accepted);
  return accepted;
}

/** Standard response envelope returned to popup message callers. */
export function makeResponse(ok, action, message, details = null) {
  return {
    ok,
    action,
    message: String(message || ''),
    details: serializeForMessage(details)
  };
}

/** Validates and normalizes inbound quality values from popup messages. */
export function validateQuality(value) {
  const normalized = normalizeQualityLabel(value);
  return QUALITY_SET.has(normalized) ? normalized : '';
}

/** Validates mode keys and defaults unknown values to HIGH mode. */
export function validateMode(value) {
  return MODE_SET.has(value) ? value : MODE_VALUES.HIGH;
}

/** Validates plugin-enabled state and defaults unknown values to enabled. */
export function validatePluginEnabled(value) {
  return value !== false;
}
