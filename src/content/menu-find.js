import { SETTINGS_MENU_LABEL_GROUPS, SETTINGS_MENU_CLOSE_TERMS } from './constants.js';
import { isElementVisible, isMenuEntryUsable } from './utils.js';
import { serializeRect, isRectNear } from './geometry.js';

/** Collects visible menu-like overlay roots. */
export function scanMenuRoots() {
  const selectors = [
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
    '[aria-label*="settings" i][role="dialog"]',
    '[data-a-target*="player-settings" i]',
    '[data-a-target*="settings-menu" i]',
    '[data-a-target*="dropdown-menu" i]',
    '[data-test-selector*="menu" i]',
    '[class*="settings-menu" i]'
  ];

  const seen = new Set();
  const roots = [];

  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!isElementVisible(element)) {
        continue;
      }
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);
      roots.push(element);
    }
  }

  return roots;
}

/** Fallback finder for settings-like containers by visible text. */
export function findSettingsMenuRootsByText() {
  const selector = 'div, section, [role="dialog"], [data-a-target], [class*="menu" i]';
  const raw = [];

  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (!isMenuEntryUsable(element)) {
      continue;
    }

    const ow = element.offsetWidth;
    const oh = element.offsetHeight;
    if (ow < 180 || oh < 120) {
      continue;
    }
    if (ow > window.innerWidth * 0.96 || oh > window.innerHeight * 0.96) {
      continue;
    }

    const lower = String(element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!lower) {
      continue;
    }

    const hasQuality = SETTINGS_MENU_LABEL_GROUPS.quality.some((term) => lower.includes(term));
    const hasSubtitles = SETTINGS_MENU_LABEL_GROUPS.subtitles.some((term) => lower.includes(term));
    const hasAdvanced = SETTINGS_MENU_LABEL_GROUPS.advanced.some((term) => lower.includes(term));
    const hasClose = SETTINGS_MENU_CLOSE_TERMS.some((term) => lower.includes(term));
    const matchedGroupCount = Number(hasQuality) + Number(hasSubtitles) + Number(hasAdvanced);

    if (!(matchedGroupCount >= 2 || (hasQuality && hasClose))) {
      continue;
    }

    raw.push(element);
  }

  // Keep smallest matching containers to avoid huge wrapper nodes.
  // Use offsetWidth/offsetHeight instead of getBoundingClientRect so this works
  // even when filter:opacity(0) from the menu hider causes BCR to return 0×0.
  raw.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));

  const kept = [];
  for (const element of raw) {
    if (kept.some((existing) => element.contains(existing))) {
      continue;
    }
    kept.push(element);
    if (kept.length >= 3) {
      break;
    }
  }

  return kept;
}

/** Fallback probe: player-near panel with visible quality text. */
export function findPlayerNearQualityPanel(playerRoot) {
  if (!(playerRoot instanceof Element) || !isElementVisible(playerRoot)) {
    return null;
  }

  const roots = scanMenuRoots();
  const seen = new Set(roots);
  for (const root of findSettingsMenuRootsByText()) {
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }

  const playerRect = playerRoot.getBoundingClientRect();
  for (const root of roots) {
    if (!isMenuEntryUsable(root)) {
      continue;
    }
    const rect = root.getBoundingClientRect();
    // Firefox: filter:opacity(0) causes getBoundingClientRect to return 0×0 for menu roots.
    // When that happens, skip the proximity check and rely on text content alone.
    if (rect.width > 0 && rect.height > 0 && !isRectNear(playerRect, rect, 120)) {
      continue;
    }

    const text = String(root.innerText || root.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!text) {
      continue;
    }

    const hasQuality = SETTINGS_MENU_LABEL_GROUPS.quality.some((term) => text.includes(term));
    if (!hasQuality) {
      continue;
    }

    return {
      rect: serializeRect(rect),
      hasQuality,
      hasClose: SETTINGS_MENU_CLOSE_TERMS.some((term) => text.includes(term)),
      textPreview: text.slice(0, 220)
    };
  }

  return null;
}
