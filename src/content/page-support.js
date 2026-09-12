/**
 * content/page-support.js
 *
 * URL classification and response/validation utilities for the content script.
 *
 * isSupportedTwitchPage()
 *   Classifies the current URL as supported or unsupported. Checks in order:
 *     1. Must be on a twitch.tv hostname
 *     2. Must not be the homepage, a directory/category page, a clips page,
 *        or a non-player root path (settings, wallet, messages, etc.)
 *     3. Must not be a non-live channel subpage (/about, /schedule, /videos…)
 *     4. Must have a visible player element in the DOM
 *   Called by enforcement.js and setup.js before any menu interaction.
 *
 * forgeResponse(ok, action, message, details)
 *   Builds the structured response envelope sent back to popup message callers.
 *   details is passed through serializeForMessage() so DOM elements and circular
 *   refs are stripped — safe to postMessage across extension contexts.
 *
 * validateQuality(value)   — normalizes + validates an inbound quality string
 * validateMode(value)      — validates a mode key, defaults unknown to HIGH
 * validatePluginEnabled()  — coerces the stored boolean, defaults unknown to true
 * validateAggressiveMode() — coerces the stored boolean, defaults unknown to false (opt-in)
 */

import { QUALITY_SET, MODE_SET, MODE_VALUES } from './constants.js';
import { debug, serializeForMessage } from './utils.js';
import { getPlayerRoot } from './player.js';
import { parseQualityTag } from './quality-matching.js';

/** Classifies current Twitch URL as supported/unsupported with a clear reason. */
export function isSupportedTwitchPage() {
  // --- Check 1: hostname ---
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
  // Normalize trailing slashes so "/channel/" and "/channel" are treated the same.
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

  // --- Check 2: non-player pages ---
  if (lowerPath.startsWith('/directory')) {
    const result = {
      supported: false,
      reason: 'Directory/category pages are not supported.',
      details: { path: normalizedPath }
    };
    debug('Page rejected', result);
    return result;
  }

  // /clips and /channel/clip/ are read-only — no live player controls.
  if (lowerPath.startsWith('/clips') || lowerPath.includes('/clip/')) {
    const result = {
      supported: false,
      reason: 'Clips pages are not supported.',
      details: { path: normalizedPath }
    };
    debug('Page rejected', result);
    return result;
  }

  // Top-level paths that never have a video player.
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

  // --- Check 3: channel subpages without a live player ---
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

  // --- Check 4: visible player in DOM ---
  // Even on a channel page the player might not have rendered yet (SPA navigation),
  // or the URL belongs to a page type we didn't enumerate above. Require a visible
  // player element as the final gate.
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
export function forgeResponse(ok, action, message, details = null) {
  return {
    ok,
    action,
    message: String(message || ''),
    // Serialize details so DOM nodes, functions, and circular refs are stripped
    // before the object crosses the extension message boundary.
    details: serializeForMessage(details)
  };
}

/** Validates and normalizes inbound quality values from popup messages. */
export function validateQuality(value) {
  // parseQualityTag maps raw labels to canonical keys; QUALITY_SET confirms the key is known.
  const normalized = parseQualityTag(value);
  return QUALITY_SET.has(normalized) ? normalized : '';
}

/** Validates mode keys and defaults unknown values to HIGH mode. */
export function validateMode(value) {
  // Unknown values (undefined, corrupt storage) default to HIGH so quality never
  // inadvertently drops to a low-data preset on a fresh install.
  return MODE_SET.has(value) ? value : MODE_VALUES.HIGH;
}

/** Validates plugin-enabled state and defaults unknown values to enabled. */
export function validatePluginEnabled(value) {
  // The only falsy value that disables the plugin is explicit false.
  // null, undefined, and corrupt values default to enabled.
  return value !== false;
}

/** Coerces the stored Aggressive Mode flag — opt-in, so anything but explicit true defaults to off. */
export function validateAggressiveMode(value) {
  return value === true;
}
