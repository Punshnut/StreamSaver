import { SETTINGS_MENU_LABEL_GROUPS, SETTINGS_MENU_CLOSE_TERMS } from './constants.js';
import { debug, createResult, isElementVisible, isMenuEntryUsable, getMenuEntryText, wait, clickElementSafely, waitForCondition } from './utils.js';
import { serializeRect, isRectInside, isRectNear } from './geometry.js';
import { getPlayerRoot, triggerPlayerHover, findPlayerControlScopes, collectSettingsButtonCandidates } from './player.js';
import { findVisibleMenuRoots, findSettingsMenuRootsByText, findPlayerNearQualityPanel } from './menu-find.js';
import { closeMenusIfNeeded } from './menu-close.js';

/** Collects visible menu labels with dedupe and fallback parsing. */
export function getVisibleMenuEntryTexts(menuRoot) {
  const selector = 'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"], a';
  const seen = new Set();
  const entries = [];

  for (const entry of Array.from(menuRoot.querySelectorAll(selector))) {
    if (!isMenuEntryUsable(entry)) {
      continue;
    }
    const text = getMenuEntryText(entry);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(text);
  }

  if (entries.length > 0) {
    return entries;
  }

  // Fallback for menu variants that render plain text rows.
  const rootText = String(menuRoot.innerText || menuRoot.textContent || '');
  if (!rootText.trim()) {
    return [];
  }

  const textLines = rootText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2);
  const deduped = [];
  const seenLines = new Set();
  for (const line of textLines) {
    const key = line.toLowerCase();
    if (seenLines.has(key)) {
      continue;
    }
    seenLines.add(key);
    deduped.push(line);
    if (deduped.length >= 20) {
      break;
    }
  }

  return deduped;
}

/** Checks whether a visible menu resembles player settings. */
export function isLikelyPlayerSettingsMenu(menuRoot, playerRoot) {
  if (!(menuRoot instanceof Element) || !isElementVisible(menuRoot)) {
    return {
      accepted: false,
      reason: 'Rejected: menu is not visible.',
      details: {
        menuItemCount: 0,
        entryTexts: []
      }
    };
  }

  const playerRect = playerRoot.getBoundingClientRect();
  const menuRect = menuRoot.getBoundingClientRect();
  // Firefox: filter:opacity(0) from the menu hider causes getBoundingClientRect to return 0×0
  // for layout-present elements. When that happens, skip the proximity check and fall back
  // to semantic content matching only.
  const menuRectFiltered = menuRect.width === 0 && menuRect.height === 0 && menuRoot.offsetWidth > 0;
  const nearPlayer = menuRectFiltered ? false : isRectNear(playerRect, menuRect, 48);
  const entryTexts = getVisibleMenuEntryTexts(menuRoot);
  const loweredEntries = entryTexts.map((text) => text.toLowerCase());
  const rootTextLower = String(menuRoot.innerText || menuRoot.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Check entry labels and full menu text because Twitch markup varies.
  const containsTerm = (terms) => {
    return terms.some((term) => loweredEntries.some((text) => text.includes(term)) || rootTextLower.includes(term));
  };
  const hasQuality = containsTerm(SETTINGS_MENU_LABEL_GROUPS.quality);
  const hasSubtitles = containsTerm(SETTINGS_MENU_LABEL_GROUPS.subtitles);
  const hasAdvanced = containsTerm(SETTINGS_MENU_LABEL_GROUPS.advanced);
  const hasClose = containsTerm(SETTINGS_MENU_CLOSE_TERMS);
  const matchedGroups = [];

  if (hasQuality) matchedGroups.push('quality');
  if (hasSubtitles) matchedGroups.push('subtitles');
  if (hasAdvanced) matchedGroups.push('advanced');

  const strongSemanticMatch = matchedGroups.length >= 2 || (matchedGroups.includes('quality') && hasClose);
  // When Firefox returns a zero rect due to filter:opacity (menuRectFiltered), relax acceptance
  // to quality-only since we cannot use geometry to confirm proximity.
  const accepted = entryTexts.length > 0 && matchedGroups.length > 0 &&
                   (nearPlayer || strongSemanticMatch || (menuRectFiltered && matchedGroups.includes('quality')));
  let reason = 'Accepted: menu matches player-settings entries and location.';
  if (entryTexts.length === 0) {
    reason = 'Rejected: menu has no visible entries.';
  } else if (matchedGroups.length === 0) {
    reason = 'Rejected: menu entries do not contain quality/subtitles/advanced labels.';
  } else if (!nearPlayer && !strongSemanticMatch && !(menuRectFiltered && matchedGroups.includes('quality'))) {
    reason = 'Rejected: menu is not near player and semantic match is too weak.';
  } else if (menuRectFiltered && !nearPlayer && !strongSemanticMatch) {
    reason = 'Accepted: quality match with zero rect (Firefox filter:opacity fallback).';
  } else if (!nearPlayer && strongSemanticMatch) {
    reason = 'Accepted: strong semantic match despite imperfect geometry.';
  }

  return {
    accepted,
    reason,
    details: {
      nearPlayer,
      role: String(menuRoot.getAttribute('role') || ''),
      ariaLabel: String(menuRoot.getAttribute('aria-label') || ''),
      dataTarget: String(menuRoot.getAttribute('data-a-target') || ''),
      rect: serializeRect(menuRect),
      menuItemCount: entryTexts.length,
      hasClose,
      matchedGroups,
      entryTexts
    }
  };
}

/** Returns settings menu state with one clear match. */
export function findOpenPlayerSettingsMenu(playerRoot, options = {}) {
  if (!(playerRoot instanceof Element) || !isElementVisible(playerRoot)) {
    return createResult(false, 'PLAYER_NOT_FOUND', 'Cannot inspect menus without a visible player root.');
  }

  const menuRoots = findVisibleMenuRoots();
  const seenRoots = new Set(menuRoots);
  const textFallbackRoots = findSettingsMenuRootsByText();
  for (const root of textFallbackRoots) {
    if (!seenRoots.has(root)) {
      seenRoots.add(root);
      menuRoots.push(root);
    }
  }
  const assessedMenus = menuRoots.map((menuRoot, index) => ({
    index,
    menuRoot,
    assessment: isLikelyPlayerSettingsMenu(menuRoot, playerRoot)
  }));
  const relevantMenus = assessedMenus.filter((item) => {
    const nearPlayer = Boolean(item.assessment.details?.nearPlayer);
    const menuItemCount = item.assessment.details?.menuItemCount || 0;
    const matchedGroupsCount = item.assessment.details?.matchedGroups?.length || 0;
    const hasClose = Boolean(item.assessment.details?.hasClose);
    const hasSemantic = matchedGroupsCount >= 1 || hasClose;
    return hasSemantic || (nearPlayer && menuItemCount >= 2);
  });
  const acceptedMenus = relevantMenus.filter((item) => item.assessment.accepted);
  const topLevelAcceptedMenus = acceptedMenus.filter((item) => {
    return !acceptedMenus.some((other) => other !== item && other.menuRoot.contains(item.menuRoot));
  });
  const assessments = assessedMenus.map((item) => item.assessment);
  if (options.log !== false) {
    debug('findOpenPlayerSettingsMenu: menu assessments', assessments.map((assessment, index) => ({
      index,
      nearPlayer: Boolean(assessment.details?.nearPlayer),
      accepted: assessment.accepted,
      reason: assessment.reason,
      menuItemCount: assessment.details?.menuItemCount ?? 0,
      matchedGroups: assessment.details?.matchedGroups || [],
      entryTexts: assessment.details?.entryTexts || []
    })));
    debug('findOpenPlayerSettingsMenu: menu assessment summary', assessments.map((assessment, index) => {
      const groups = (assessment.details?.matchedGroups || []).join(',');
      const entryPreview = (assessment.details?.entryTexts || []).slice(0, 4).join(' | ');
      return `#${index} near=${Boolean(assessment.details?.nearPlayer)} accepted=${assessment.accepted} groups=[${groups}] entries=${entryPreview}`;
    }));
  }

  if (topLevelAcceptedMenus.length === 1) {
    return createResult(true, 'PLAYER_SETTINGS_MENU_OPEN', 'One valid player settings menu is open.', {
      menuCount: topLevelAcceptedMenus.length,
      relevantCount: relevantMenus.length,
      globalMenuCount: assessments.length,
      acceptedCount: topLevelAcceptedMenus.length,
      acceptedRawCount: acceptedMenus.length,
      assessments
    });
  }
  if (relevantMenus.length === 0) {
    return createResult(false, 'NO_VISIBLE_MENUS', 'No visible player-near menus are open.', {
      menuCount: 0,
      relevantCount: 0,
      globalMenuCount: assessments.length,
      acceptedCount: 0,
      acceptedRawCount: 0,
      assessments
    });
  }
  if (acceptedMenus.length === 0) {
    return createResult(false, 'NO_VALID_PLAYER_SETTINGS_MENU', 'Visible menus found, but none match player settings.', {
      menuCount: relevantMenus.length,
      relevantCount: relevantMenus.length,
      globalMenuCount: assessments.length,
      acceptedCount: 0,
      acceptedRawCount: 0,
      assessments
    });
  }

  return createResult(false, 'MULTIPLE_MENUS_OPEN', 'Multiple menus detected; expected exactly one player settings menu.', {
    menuCount: topLevelAcceptedMenus.length,
    relevantCount: relevantMenus.length,
    globalMenuCount: assessments.length,
    acceptedCount: topLevelAcceptedMenus.length,
    acceptedRawCount: acceptedMenus.length,
    assessments
  });
}

/** Opens player settings and waits for the overlay. */
export async function openSettingsMenu() {
  debug('openSettingsMenu: locating settings trigger');

  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    debug('openSettingsMenu: player root not found', playerRootResult);
    return createResult(false, 'PLAYER_NOT_FOUND', 'Cannot open settings without a visible player.');
  }

  const playerRoot = playerRootResult.details.element;
  const playerRect = playerRoot.getBoundingClientRect();
  debug('openSettingsMenu: player root found', {
    selector: playerRootResult.details.selector,
    rect: serializeRect(playerRect)
  });

  const preExistingMenuResult = findOpenPlayerSettingsMenu(playerRoot);
  debug('openSettingsMenu: settings menu already open check', {
    alreadyOpen: preExistingMenuResult.ok,
    code: preExistingMenuResult.code,
    menuCount: preExistingMenuResult.details?.menuCount ?? 0,
    acceptedCount: preExistingMenuResult.details?.acceptedCount ?? 0,
    assessments: preExistingMenuResult.details?.assessments || []
  });
  if (preExistingMenuResult.ok) {
    return createResult(true, 'SETTINGS_MENU_ALREADY_OPEN', 'Settings menu already open and valid.', {
      menuState: preExistingMenuResult.details
    });
  }
  if ((preExistingMenuResult.details?.acceptedCount || 0) > 0) {
    return createResult(false, 'SETTINGS_MENU_ALREADY_OPEN_AMBIGUOUS', 'A valid settings menu is already open, but the menu state is ambiguous.', {
      menuState: preExistingMenuResult.details
    });
  }
  if ((preExistingMenuResult.details?.menuCount || 0) > 0) {
    debug('openSettingsMenu: invalid pre-existing menu found, trying escape-only close first', preExistingMenuResult.details);
    const closePreExistingResult = await closeMenusIfNeeded({ allowBodyClick: false, maxAttempts: 1 });
    const postCloseMenuResult = findOpenPlayerSettingsMenu(playerRoot);
    debug('openSettingsMenu: post-close pre-existing menu check', {
      closePreExistingResult,
      code: postCloseMenuResult.code,
      menuCount: postCloseMenuResult.details?.menuCount ?? 0,
      acceptedCount: postCloseMenuResult.details?.acceptedCount ?? 0
    });

    if (postCloseMenuResult.ok) {
      return createResult(true, 'SETTINGS_MENU_ALREADY_OPEN', 'Settings menu already open and valid.', {
        menuState: postCloseMenuResult.details
      });
    }
    if ((postCloseMenuResult.details?.acceptedCount || 0) > 0) {
      return createResult(false, 'SETTINGS_MENU_ALREADY_OPEN_AMBIGUOUS', 'A valid settings menu is already open, but the menu state is ambiguous.', {
        menuState: postCloseMenuResult.details,
        closePreExistingResult
      });
    }
    debug('openSettingsMenu: continuing despite invalid pre-existing menus', {
      closePreExistingResult,
      remainingMenuCount: postCloseMenuResult.details?.menuCount ?? 0
    });
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    debug('openSettingsMenu: search attempt', { attempt });
    triggerPlayerHover(playerRoot);
    await wait(120);

    const menuStateBeforeClick = findOpenPlayerSettingsMenu(playerRoot);
    if (menuStateBeforeClick.ok) {
      debug('openSettingsMenu: valid menu appeared before click', menuStateBeforeClick.details);
      return createResult(true, 'SETTINGS_MENU_ALREADY_OPEN', 'Settings menu already open and valid.', {
        menuState: menuStateBeforeClick.details
      });
    }
    if ((menuStateBeforeClick.details?.acceptedCount || 0) > 0) {
      debug('openSettingsMenu: valid settings menu already open with ambiguous state', menuStateBeforeClick.details);
      return createResult(false, 'SETTINGS_MENU_ALREADY_OPEN_AMBIGUOUS', 'A valid settings menu is already open, but menu state is ambiguous.', {
        menuState: menuStateBeforeClick.details
      });
    }

    const controlScopes = findPlayerControlScopes(playerRoot);
    debug('openSettingsMenu: control scopes inside player', controlScopes.map((scope) => ({
      selector: scope.selector,
      rect: scope.rect
    })));

    const candidates = collectSettingsButtonCandidates(playerRoot, controlScopes);
    debug('openSettingsMenu: candidate buttons', candidates.map((candidate) => ({
      selector: candidate.selector,
      ariaLabel: candidate.ariaLabel,
      title: candidate.title,
      text: candidate.text,
      dataTarget: candidate.dataTarget,
      matchedBy: candidate.matchedBy,
      inControlScope: candidate.inControlScope,
      score: candidate.score,
      rect: candidate.rect
    })));

    if (candidates.length === 0) {
      debug('openSettingsMenu: retry reason - no valid settings candidates found in player controls', { attempt });
      await wait(140);
      continue;
    }

    const candidate = candidates[0];
    if (!isElementVisible(candidate.element)) {
      debug('openSettingsMenu: selected candidate is no longer visible, skipping attempt', {
        attempt,
        candidate
      });
      await wait(120);
      continue;
    }

    if (!isRectInside(playerRect, candidate.element.getBoundingClientRect(), 8)) {
      debug('openSettingsMenu: selected candidate moved outside player bounds, skipping attempt', {
        attempt,
        candidate
      });
      await wait(120);
      continue;
    }

    debug('openSettingsMenu: clicking candidate', {
      attempt,
      selector: candidate.selector,
      matchedBy: candidate.matchedBy,
      ariaLabel: candidate.ariaLabel,
      title: candidate.title,
      text: candidate.text,
      rect: candidate.rect
    });

    const safeClickResult = clickElementSafely(candidate.element, { prepare: false });
    if (!safeClickResult.ok) {
      debug('openSettingsMenu: click candidate failed', safeClickResult);
      await wait(140);
      continue;
    }

    const fallbackWaitResult = await waitForCondition(() => {
      const ariaExpanded = String(candidate.element?.getAttribute('aria-expanded') || '').toLowerCase() === 'true';
      const panel = findPlayerNearQualityPanel(playerRoot);
      return ariaExpanded && panel ? { ariaExpanded, panel } : null;
    }, {
      timeoutMs: 500,
      intervalMs: 50,
      description: 'settings fallback signal'
    });

    if (fallbackWaitResult.ok) {
      debug('openSettingsMenu: accepted fallback settings signal', fallbackWaitResult.details.value);
      return createResult(true, 'SETTINGS_MENU_OPEN_FALLBACK', 'Settings menu opened via fallback signal.', {
        clickedCandidate: {
          selector: candidate.selector,
          text: candidate.text,
          ariaLabel: candidate.ariaLabel,
          matchedBy: candidate.matchedBy
        },
        fallback: fallbackWaitResult.details.value
      });
    }

    const menusBeforeWait = findVisibleMenuRoots();
    const beforeSet = new Set(menusBeforeWait);
    const waitResult = await waitForCondition(() => {
      const menus = findVisibleMenuRoots();
      const hasNewMenuRoot = menus.some((menu) => !beforeSet.has(menu));
      const validated = findOpenPlayerSettingsMenu(playerRoot, { log: false });
      if (validated.ok || hasNewMenuRoot) {
        return menus;
      }
      return null;
    }, {
      timeoutMs: 1400,
      intervalMs: 90,
      description: 'settings menu visibility'
    });

    if (!waitResult.ok) {
      debug('openSettingsMenu: retry reason - click did not open any menu', {
        attempt,
        clickedCandidate: {
          selector: candidate.selector,
          text: candidate.text,
          ariaLabel: candidate.ariaLabel
        }
      });
      await wait(180);
      continue;
    }

    const menusAfterClick = waitResult.details.value;
    const menuStateAfterClick = findOpenPlayerSettingsMenu(playerRoot);
    debug('openSettingsMenu: menus found after click', {
      attempt,
      globalMenuCount: menusAfterClick.length,
      menuCount: menuStateAfterClick.details?.menuCount ?? 0,
      acceptedCount: menuStateAfterClick.details?.acceptedCount ?? 0,
      assessments: menuStateAfterClick.details?.assessments || []
    });

    if (menuStateAfterClick.ok) {
      debug('openSettingsMenu: accepted player settings menu', menuStateAfterClick.details);
      return createResult(true, 'SETTINGS_MENU_OPEN', 'Settings menu opened and validated successfully.', {
        clickedCandidate: {
          selector: candidate.selector,
          text: candidate.text,
          ariaLabel: candidate.ariaLabel,
          matchedBy: candidate.matchedBy
        },
        menuState: menuStateAfterClick.details
      });
    }
    if ((menuStateAfterClick.details?.acceptedCount || 0) > 0) {
      debug('openSettingsMenu: valid settings menu detected but not exactly one', menuStateAfterClick.details);
      return createResult(false, 'SETTINGS_MENU_NOT_EXACTLY_ONE', 'A valid settings menu opened, but not as exactly one visible menu.', {
        clickedCandidate: {
          selector: candidate.selector,
          text: candidate.text,
          ariaLabel: candidate.ariaLabel,
          matchedBy: candidate.matchedBy
        },
        menuState: menuStateAfterClick.details
      });
    }

    debug('openSettingsMenu: menu rejected after click', {
      code: menuStateAfterClick.code,
      reason: menuStateAfterClick.message,
      assessments: menuStateAfterClick.details?.assessments || []
    });
    return createResult(false, 'SETTINGS_MENU_INVALID_AFTER_CLICK', 'Clicked one player candidate, but the opened menu did not match player settings.', {
      clickedCandidate: {
        selector: candidate.selector,
        text: candidate.text,
        ariaLabel: candidate.ariaLabel,
        matchedBy: candidate.matchedBy
      },
      menuState: menuStateAfterClick.details
    });
  }

  return createResult(false, 'SETTINGS_MENU_DEBUG_FAILED', 'Could not open exactly one valid player settings menu.');
}
