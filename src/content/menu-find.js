/**
 * content/menu-find.js
 *
 * DOM discovery helpers for locating visible Twitch menu overlays. Three
 * complementary strategies are used in combination because Twitch's markup
 * varies between live streams, VODs, and localized UI versions:
 *
 * scanMenuRoots()
 *   Primary strategy: query well-known ARIA roles and data-a-target attributes.
 *   Fast and precise — returns only elements that already look like menus.
 *
 * findSettingsMenuRootsByText()
 *   Text-content fallback: finds containers that contain at least two of the
 *   three label groups (quality / subtitles / advanced) or quality + close.
 *   Filters to the smallest matching containers to avoid huge wrapper nodes.
 *
 * findPlayerNearQualityPanel(playerRoot)
 *   Geometry fallback: combines both strategies and filters to menus that are
 *   near the player rect AND contain quality-related text.
 *
 * Firefox note: filter:opacity(0) from the menu hider causes getBoundingClientRect
 * to return 0×0 for affected elements. All geometry comparisons here fall back to
 * offsetWidth/offsetHeight for size checks and skip proximity checks when BCR
 * returns a zero rect.
 */

import { SETTINGS_MENU_LABEL_GROUPS, SETTINGS_MENU_CLOSE_TERMS } from './constants.js';
import { isElementVisible, isMenuEntryUsable } from './utils.js';
import { serializeRect, isRectNear } from './geometry.js';

/** Collects visible menu-like overlay roots. */
export function scanMenuRoots() {
  // These selectors cover Twitch's known menu markup patterns.
  // Listed roughly in order of specificity — ARIA roles are most reliable.
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

  const seen = new Set(); // prevent duplicates when multiple selectors match the same node
  const roots = [];

  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      // Skip invisible elements and ones we've already collected.
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
  // Cast a wider net than scanMenuRoots — these elements may lack ARIA roles.
  const selector = 'div, section, [role="dialog"], [data-a-target], [class*="menu" i]';
  const raw = [];

  for (const element of Array.from(document.querySelectorAll(selector))) {
    // isMenuEntryUsable uses offsetWidth/Height — immune to the filter:opacity BCR bug.
    if (!isMenuEntryUsable(element)) {
      continue;
    }

    const ow = element.offsetWidth;
    const oh = element.offsetHeight;

    // Size guard: must be at least menu-sized but not full-viewport.
    // Prevents matching the page body or a tiny icon.
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

    // Score against known settings label groups.
    const hasQuality   = SETTINGS_MENU_LABEL_GROUPS.quality.some((term) => lower.includes(term));
    const hasSubtitles = SETTINGS_MENU_LABEL_GROUPS.subtitles.some((term) => lower.includes(term));
    const hasAdvanced  = SETTINGS_MENU_LABEL_GROUPS.advanced.some((term) => lower.includes(term));
    const hasClose     = SETTINGS_MENU_CLOSE_TERMS.some((term) => lower.includes(term));

    // Require at least two matching groups, OR quality + close button text.
    // A single "quality" match is too ambiguous — it could be a stream title.
    const matchedGroupCount = Number(hasQuality) + Number(hasSubtitles) + Number(hasAdvanced);
    if (!(matchedGroupCount >= 2 || (hasQuality && hasClose))) {
      continue;
    }

    raw.push(element);
  }

  // Prefer the smallest matching containers — large wrappers are usually parents of the
  // actual menu. Sort by offset area (not BCR area — immune to filter:opacity(0) bug).
  raw.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));

  const kept = [];
  for (const element of raw) {
    // Drop any element that contains an already-kept smaller element.
    if (kept.some((existing) => element.contains(existing))) {
      continue;
    }
    kept.push(element);
    if (kept.length >= 3) {
      break; // cap to avoid expensive lookups on busy pages
    }
  }

  return kept;
}

/** Fallback probe: player-near panel with visible quality text. */
export function findPlayerNearQualityPanel(playerRoot) {
  if (!(playerRoot instanceof Element) || !isElementVisible(playerRoot)) {
    return null;
  }

  // Combine both strategies into one candidate list.
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

    // filter:opacity(0) BCR bug: if BCR is 0×0, skip geometry and rely on text alone.
    if (rect.width > 0 && rect.height > 0 && !isRectNear(playerRect, rect, 120)) {
      continue; // visible rect, but too far from the player — not our menu
    }

    const text = String(root.innerText || root.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!text) {
      continue;
    }

    // Must contain quality-related text to count as a quality panel.
    const hasQuality = SETTINGS_MENU_LABEL_GROUPS.quality.some((term) => text.includes(term));
    if (!hasQuality) {
      continue;
    }

    return {
      rect: serializeRect(rect),
      hasQuality,
      hasClose: SETTINGS_MENU_CLOSE_TERMS.some((term) => text.includes(term)),
      textPreview: text.slice(0, 220) // truncate for debug payloads
    };
  }

  return null;
}
