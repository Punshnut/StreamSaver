/**
 * content/player.js
 *
 * Locates the Twitch video player in the DOM and provides helpers for
 * interacting with the player controls area.
 *
 * getPlayerRoot()
 *   Returns the outermost visible player container element. Uses a cached
 *   reference when the element is still connected and visible, hunting fresh
 *   when it has been removed or replaced (e.g. after a SPA navigation).
 *
 * wakePlayerControls(playerRoot)
 *   Dispatches synthetic hover events at two points inside the player to
 *   make Twitch reveal its controls bar (which is hidden when the mouse
 *   is outside the player area). Required before hunting for the gear button.
 *
 * mapControlZones(playerRoot)
 *   Queries the player for control-bar containers and returns them as an array
 *   of { selector, element, rect } scopes. Provides the spatial context that
 *   huntSettingsTriggers() needs to constrain its button search.
 *
 * huntSettingsTriggers(playerRoot, controlScopes)
 *   Searches for the settings/gear button inside the control zones using both
 *   semantic attributes (aria-label, title, data-a-target) and locale-aware
 *   SETTINGS_TRIGGER_TERMS. Scores and sorts candidates so the best match is
 *   always first. Returns an empty array when no controls are visible.
 */

import { SETTINGS_TRIGGER_TERMS } from './constants.js';
import { createResult, isElementVisible, getVisibleText, jitter } from './utils.js';
import { serializeRect, isRectInside } from './geometry.js';

// Selectors tried in priority order — the first one that yields a visible element wins.
// The 'video' fallback crawls up to the nearest section/div to get a proper container.
const PLAYER_SELECTORS = [
  '[data-a-target="video-player"]',
  '[role="application"][aria-label*="player" i]',
  '[role="region"][aria-label*="player" i]',
  '[role="region"][aria-label*="video" i]',
  'video'
];

// Lock-on cache for the player root. Released when the element leaves the DOM.
// Avoids repeated querySelectorAll calls on every enforcement round.
let lockedPlayerRoot = null;

/** Scans the DOM for the best candidate player root element. */
function huntPlayerRoot() {
  for (const selector of PLAYER_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    for (const candidate of candidates) {
      // For a bare <video> tag, walk up to the nearest semantic container so
      // callers get a proper bounding box that includes the controls bar.
      const root = selector === 'video' ? candidate.closest('section, div, main, article') || candidate : candidate;
      if (isElementVisible(root)) {
        return createResult(true, 'PLAYER_FOUND', 'Found likely Twitch player root.', {
          selector,
          element: root
        });
      }
    }
  }
  return createResult(false, 'PLAYER_NOT_FOUND', 'No visible Twitch player root was found.');
}

/** Finds the best visible root for the Twitch player, with DOM-connected lock-on cache. */
export function getPlayerRoot() {
  // Re-use the cached element if it's still connected and visible — avoids
  // re-running the full selector scan on every call during a single enforcement round.
  if (lockedPlayerRoot?.isConnected && isElementVisible(lockedPlayerRoot)) {
    return createResult(true, 'PLAYER_FOUND', 'Found likely Twitch player root.', {
      selector: 'cached',
      element: lockedPlayerRoot
    });
  }
  // Cache miss or stale reference — hunt fresh and update the cache.
  const result = huntPlayerRoot();
  lockedPlayerRoot = result.ok ? result.details.element : null;
  return result;
}

/** Wakes player controls by dispatching hover events. */
export function wakePlayerControls(playerRoot) {
  if (!(playerRoot instanceof Element)) {
    return;
  }

  const rect = playerRoot.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return; // player has no layout — can't compute hover targets
  }

  // Two hover points: center and lower-right where controls typically live.
  // Jitter is added so events don't land on the exact same pixel every call —
  // Twitch's hover detection sometimes ignores identical repeat coordinates.
  const hoverPoints = [
    { x: rect.left + rect.width * 0.5 + jitter(), y: rect.top + rect.height * 0.5 + jitter() },
    { x: rect.left + rect.width * 0.85 + jitter(), y: rect.top + rect.height * 0.9 + jitter() }
  ];

  for (const point of hoverPoints) {
    // Dispatch the full hover sequence: enter → over → move.
    // bubbles:true so Twitch's delegated event listeners on parent nodes fire too.
    playerRoot.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: point.x, clientY: point.y }));
    playerRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: point.x, clientY: point.y }));
    playerRoot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: point.x, clientY: point.y }));
  }
}

/** Maps visible player control containers inside the active player root. */
export function mapControlZones(playerRoot) {
  if (!(playerRoot instanceof Element)) {
    return [];
  }

  // These selectors target the controls bar / toolbar, not the full player container.
  // Used to narrow the settings button search so we don't pick up chat buttons etc.
  const selectors = [
    '[data-a-target*="player-controls" i]',
    '[data-a-target*="player-control" i]',
    '[data-a-target*="player-overlay" i]',
    '[aria-label*="player controls" i]',
    '[class*="player-controls" i]',
    '[role="toolbar"]'
  ];
  const seen = new Set(); // deduplicate — multiple selectors may match the same element
  const scopes = [];

  for (const selector of selectors) {
    for (const element of Array.from(playerRoot.querySelectorAll(selector))) {
      if (!isElementVisible(element) || seen.has(element)) {
        continue;
      }
      seen.add(element);
      scopes.push({
        selector,
        element,
        rect: serializeRect(element.getBoundingClientRect())
      });
    }
  }

  return scopes;
}

/** Hunts for settings-trigger candidates only inside the player controls region. */
export function huntSettingsTriggers(playerRoot, controlScopes) {
  if (!(playerRoot instanceof Element)) {
    return [];
  }
  // No control zones found — controls bar isn't visible yet. Caller should
  // call wakePlayerControls() and retry.
  if (controlScopes.length === 0) {
    return [];
  }

  const playerRect = playerRoot.getBoundingClientRect();
  const scopeElements = controlScopes.map((scope) => scope.element);

  // Attribute selectors that might identify interactive button-like elements.
  const triggerSelectors = [
    '[aria-label]',
    '[title]',
    '[data-a-target]',
    'button',
    '[role="button"]'
  ];
  const seen = new Set();
  const candidates = [];

  for (const selector of triggerSelectors) {
    for (const scopeElement of scopeElements) {
      for (const node of Array.from(scopeElement.querySelectorAll(selector))) {
        // Only HTMLElements can be clicked; invisible or already-seen nodes skip.
        if (!(node instanceof HTMLElement) || !isElementVisible(node) || seen.has(node)) {
          continue;
        }
        seen.add(node);

        // Only consider nodes inside the player root — querySelectorAll on a
        // scopeElement can return portaled nodes that escaped the DOM hierarchy.
        if (!playerRoot.contains(node)) {
          continue;
        }
        // Links would navigate instead of toggling menus.
        if (node.matches('a, [role="link"]')) {
          continue;
        }
        // Must look like an interactive button, not just any labelled element.
        if (!node.matches('button, [role="button"], [data-a-target]')) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        // Reject buttons that have escaped the player bounding box (e.g. chat overlays).
        // 8 px tolerance handles sub-pixel rounding at screen edges.
        if (!isRectInside(playerRect, rect, 8)) {
          continue;
        }

        // Collect all text representations for term matching.
        const text = getVisibleText(node);
        const ariaLabel = String(node.getAttribute('aria-label') || '');
        const title = String(node.getAttribute('title') || '');
        const dataTarget = String(node.getAttribute('data-a-target') || '');
        const textLower = text.toLowerCase();
        const ariaLower = ariaLabel.toLowerCase();
        const titleLower = title.toLowerCase();
        const dataTargetLower = dataTarget.toLowerCase();
        const matchedBy = []; // which attribute(s) triggered the match

        // Check each locale-aware settings trigger term against each attribute.
        if (SETTINGS_TRIGGER_TERMS.some((term) => textLower.includes(term))) matchedBy.push('visibleText');
        if (SETTINGS_TRIGGER_TERMS.some((term) => ariaLower.includes(term))) matchedBy.push('ariaLabel');
        if (SETTINGS_TRIGGER_TERMS.some((term) => titleLower.includes(term))) matchedBy.push('title');
        if (SETTINGS_TRIGGER_TERMS.some((term) => dataTargetLower.includes(term))) matchedBy.push('dataATarget');

        // Must match at least one term — reject unrelated buttons in the controls bar.
        if (matchedBy.length === 0) {
          continue;
        }

        // Must be directly inside a control scope (not a child popover that happened
        // to match the selector).
        const inControlScope = controlScopes.some((scope) => scope.element.contains(node));
        if (!inControlScope) {
          continue;
        }

        // Score: more matching attributes = higher confidence.
        // Bonus if data-a-target contains "player" — that's Twitch's own naming pattern.
        const score = matchedBy.length + 2 + (dataTargetLower.includes('player') ? 1 : 0);
        candidates.push({
          element: node,
          selector,
          text,
          ariaLabel,
          title,
          dataTarget,
          matchedBy,
          inControlScope,
          score,
          rect: serializeRect(rect)
        });
      }
    }
  }

  // Sort best match first; secondary sort by rightmost x-position (settings gear
  // is typically the last button on the right side of the controls bar).
  candidates.sort((a, b) => b.score - a.score || b.rect.x - a.rect.x);
  return candidates;
}
