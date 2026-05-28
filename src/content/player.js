import { SETTINGS_TRIGGER_TERMS } from './constants.js';
import { createResult, isElementVisible, getVisibleText, jitter } from './utils.js';
import { serializeRect, isRectInside } from './geometry.js';

const PLAYER_SELECTORS = [
  '[data-a-target="video-player"]',
  '[role="application"][aria-label*="player" i]',
  '[role="region"][aria-label*="player" i]',
  '[role="region"][aria-label*="video" i]',
  'video'
];

// Lock-on cache for the player root. Released when the element leaves the DOM.
let lockedPlayerRoot = null;

function huntPlayerRoot() {
  for (const selector of PLAYER_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    for (const candidate of candidates) {
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
  if (lockedPlayerRoot?.isConnected && isElementVisible(lockedPlayerRoot)) {
    return createResult(true, 'PLAYER_FOUND', 'Found likely Twitch player root.', {
      selector: 'cached',
      element: lockedPlayerRoot
    });
  }
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
    return;
  }

  const hoverPoints = [
    { x: rect.left + rect.width * 0.5 + jitter(), y: rect.top + rect.height * 0.5 + jitter() },
    { x: rect.left + rect.width * 0.85 + jitter(), y: rect.top + rect.height * 0.9 + jitter() }
  ];

  for (const point of hoverPoints) {
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

  const selectors = [
    '[data-a-target*="player-controls" i]',
    '[data-a-target*="player-control" i]',
    '[data-a-target*="player-overlay" i]',
    '[aria-label*="player controls" i]',
    '[class*="player-controls" i]',
    '[role="toolbar"]'
  ];
  const seen = new Set();
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
  if (controlScopes.length === 0) {
    return [];
  }

  const playerRect = playerRoot.getBoundingClientRect();
  const scopeElements = controlScopes.map((scope) => scope.element);
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
        if (!(node instanceof HTMLElement) || !isElementVisible(node) || seen.has(node)) {
          continue;
        }
        seen.add(node);
        if (!playerRoot.contains(node)) {
          continue;
        }
        if (node.matches('a, [role="link"]')) {
          continue;
        }
        if (!node.matches('button, [role="button"], [data-a-target]')) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        if (!isRectInside(playerRect, rect, 8)) {
          continue;
        }

        const text = getVisibleText(node);
        const ariaLabel = String(node.getAttribute('aria-label') || '');
        const title = String(node.getAttribute('title') || '');
        const dataTarget = String(node.getAttribute('data-a-target') || '');
        const textLower = text.toLowerCase();
        const ariaLower = ariaLabel.toLowerCase();
        const titleLower = title.toLowerCase();
        const dataTargetLower = dataTarget.toLowerCase();
        const matchedBy = [];

        if (SETTINGS_TRIGGER_TERMS.some((term) => textLower.includes(term))) matchedBy.push('visibleText');
        if (SETTINGS_TRIGGER_TERMS.some((term) => ariaLower.includes(term))) matchedBy.push('ariaLabel');
        if (SETTINGS_TRIGGER_TERMS.some((term) => titleLower.includes(term))) matchedBy.push('title');
        if (SETTINGS_TRIGGER_TERMS.some((term) => dataTargetLower.includes(term))) matchedBy.push('dataATarget');

        if (matchedBy.length === 0) {
          continue;
        }

        const inControlScope = controlScopes.some((scope) => scope.element.contains(node));
        if (!inControlScope) {
          continue;
        }

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

  candidates.sort((a, b) => b.score - a.score || b.rect.x - a.rect.x);
  return candidates;
}
