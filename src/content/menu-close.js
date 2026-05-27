import { SETTINGS_MENU_CLOSE_TERMS, SETTINGS_MENU_BACK_TERMS, SETTINGS_MENU_LABEL_GROUPS, QUALITY_SET } from './constants.js';
import { debug, createResult, isElementVisible, isMenuEntryUsable, getMenuEntryText, getVisibleText, wait, clickElementSafely, waitForCondition, jitter } from './utils.js';
import { serializeRect } from './geometry.js';
import { findVisibleMenuRoots } from './menu-find.js';
import { getPlayerRoot, triggerPlayerHover, findPlayerControlScopes, collectSettingsButtonCandidates } from './player.js';
import { normalizeQualityLabel } from './quality-matching.js';
import { getVisibleMenuEntryTexts } from './settings-menu.js';
import { isAdCurrentlyPlaying } from './ad-detection.js';
import { isBrowserInFullscreen } from './fullscreen.js';

/** Attempts closing via visible "Close/Schließen" entries inside menu overlays. */
export function tryCloseViaVisibleMenuCloseEntry() {
  const menuRoots = findVisibleMenuRoots();
  if (menuRoots.length === 0) {
    return createResult(false, 'NO_VISIBLE_MENUS', 'No visible menus for close-entry attempt.');
  }

  const selector = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]';
  const candidates = [];

  for (const menuRoot of menuRoots) {
    for (const entry of Array.from(menuRoot.querySelectorAll(selector))) {
      if (!(entry instanceof HTMLElement) || !isElementVisible(entry)) {
        continue;
      }
      const text = getVisibleText(entry);
      if (!text) {
        continue;
      }
      const lower = text.toLowerCase();
      if (!SETTINGS_MENU_CLOSE_TERMS.some((term) => lower.includes(term))) {
        continue;
      }

      candidates.push({
        element: entry,
        text,
        score: (entry.matches('button, [role="button"]') ? 2 : 0) + Math.max(0, 30 - text.length)
      });
    }
  }

  if (candidates.length === 0) {
    return createResult(false, 'MENU_CLOSE_ENTRY_NOT_FOUND', 'No visible close entry found inside menus.');
  }

  candidates.sort((a, b) => b.score - a.score);
  const target = candidates[0];
  const clickResult = clickElementSafely(target.element, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click visible menu close entry.', {
      text: target.text,
      clickResult
    });
  }

  return createResult(true, 'MENU_CLOSE_ENTRY_CLICKED', 'Clicked visible menu close entry.', {
    text: target.text
  });
}

/** Tries closing menus by toggling the settings button. */
export function tryCloseViaSettingsToggle() {
  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    return createResult(false, 'PLAYER_NOT_FOUND', 'Cannot close via settings toggle without a player root.');
  }

  const playerRoot = playerRootResult.details.element;
  const controlScopes = findPlayerControlScopes(playerRoot);
  const candidates = collectSettingsButtonCandidates(playerRoot, controlScopes);
  if (candidates.length === 0) {
    return createResult(false, 'SETTINGS_TOGGLE_NOT_FOUND', 'Settings toggle not found for close attempt.');
  }

  const expandedCandidate = candidates.find((candidate) => {
    return String(candidate.element.getAttribute('aria-expanded') || '').toLowerCase() === 'true';
  });
  if (!expandedCandidate) {
    return createResult(false, 'NO_EXPANDED_MENU', 'Settings button found but aria-expanded is not true; skipping click to avoid re-opening menu.');
  }
  const clickResult = clickElementSafely(expandedCandidate.element, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click settings toggle for close attempt.', {
      ariaLabel: expandedCandidate.ariaLabel,
      text: expandedCandidate.text,
      clickResult
    });
  }

  return createResult(true, 'SETTINGS_TOGGLE_CLICKED', 'Clicked settings toggle to close menu overlay.', {
    ariaLabel: expandedCandidate.ariaLabel,
    text: expandedCandidate.text
  });
}

/** Scores whether a visible menu resembles Twitch's quality submenu view. */
function analyzeMenuForQualitySubmenu(menuRoot) {
  const entryTexts = getVisibleMenuEntryTexts(menuRoot);
  const rootTextLower = String(menuRoot.innerText || menuRoot.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const hasAdvanced = SETTINGS_MENU_LABEL_GROUPS.advanced.some((term) => rootTextLower.includes(term));
  const hasSubtitles = SETTINGS_MENU_LABEL_GROUPS.subtitles.some((term) => rootTextLower.includes(term));
  const qualityOptionCount = entryTexts.filter((text) => {
    const normalized = normalizeQualityLabel(text);
    return QUALITY_SET.has(normalized);
  }).length;
  const likelyQualitySubmenu = qualityOptionCount >= 1 && !hasAdvanced && !hasSubtitles;

  return {
    entryTexts,
    qualityOptionCount,
    hasAdvanced,
    hasSubtitles,
    likelyQualitySubmenu
  };
}

/** If quality submenu is open, click Back first. */
export async function tryStepBackFromQualitySubmenu() {
  const menuRoots = findVisibleMenuRoots();
  if (menuRoots.length === 0) {
    return createResult(false, 'NO_VISIBLE_MENUS', 'No visible menus for quality-back attempt.');
  }

  const menuAssessments = menuRoots.map((menuRoot) => ({
    menuRoot,
    analysis: analyzeMenuForQualitySubmenu(menuRoot)
  }));
  const likelyQualityMenus = menuAssessments.filter((item) => item.analysis.likelyQualitySubmenu);
  if (likelyQualityMenus.length === 0) {
    return createResult(false, 'QUALITY_SUBMENU_NOT_DETECTED', 'No likely quality submenu detected for back navigation.');
  }

  const selector = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [data-a-target]';
  const candidates = [];

  for (const item of likelyQualityMenus) {
    const menuRoot = item.menuRoot;
    for (const entry of Array.from(menuRoot.querySelectorAll(selector))) {
      if (!(entry instanceof HTMLElement) || !isElementVisible(entry)) {
        continue;
      }

      const text = getVisibleText(entry);
      const ariaLabel = String(entry.getAttribute('aria-label') || '');
      const title = String(entry.getAttribute('title') || '');
      const dataTarget = String(entry.getAttribute('data-a-target') || '');
      const classData = String(entry.className || '');
      const searchable = [text, ariaLabel, title, dataTarget, classData].join(' ').toLowerCase();
      const matchedBy = [];

      if (SETTINGS_MENU_BACK_TERMS.some((term) => searchable.includes(term))) {
        matchedBy.push('back-term');
      }
      if (/\b(back|zurueck|zurück)\b/.test(dataTarget.toLowerCase())) {
        matchedBy.push('data-target');
      }

      if (matchedBy.length === 0) {
        continue;
      }

      const score =
        matchedBy.length * 4 +
        (ariaLabel ? 2 : 0) +
        (title ? 1 : 0) +
        (dataTarget ? 2 : 0) +
        (text ? 1 : 0);
      candidates.push({
        element: entry,
        text,
        ariaLabel,
        title,
        dataTarget,
        matchedBy,
        score
      });
    }
  }

  if (candidates.length === 0) {
    return createResult(false, 'QUALITY_BACK_CONTROL_NOT_FOUND', 'Quality submenu detected, but no back control found.');
  }

  candidates.sort((a, b) => b.score - a.score);
  const target = candidates[0];
  const clickResult = clickElementSafely(target.element, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click quality submenu back control.', {
      target,
      clickResult
    });
  }

  const waitResult = await waitForCondition(() => {
    const afterMenus = findVisibleMenuRoots();
    if (afterMenus.length === 0) {
      return { closed: true };
    }
    const stillInQualitySubmenu = afterMenus.some((menuRoot) => analyzeMenuForQualitySubmenu(menuRoot).likelyQualitySubmenu);
    return stillInQualitySubmenu ? null : { returnedToSettings: true, remainingMenus: afterMenus.length };
  }, {
    timeoutMs: 800,
    intervalMs: 80,
    description: 'return from quality submenu'
  });

  if (!waitResult.ok) {
    return createResult(false, 'QUALITY_BACK_NO_EFFECT', 'Clicked back control but submenu state did not change in time.', {
      target,
      waitResult
    });
  }

  return createResult(true, 'QUALITY_BACK_APPLIED', 'Returned from quality submenu to parent settings menu.', {
    target,
    transition: waitResult.details.value
  });
}

/** Attempts to close open Twitch menus, primarily via Escape. */
export async function closeMenusIfNeeded(options = {}) {
  const allowBodyClick = options.allowBodyClick !== false;
  const aggressiveBodyClicks = options.aggressiveBodyClicks === true;
  const waitBeforeMs = Number.isFinite(options.waitBeforeMs) ? Math.max(0, Math.floor(options.waitBeforeMs)) : 0;
  const maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.floor(options.maxAttempts)) : 3;
  const getMenuCount = () => findVisibleMenuRoots().length;

  if (waitBeforeMs > 0) {
    await wait(waitBeforeMs);
  }

  const initialCount = getMenuCount();

  if (initialCount === 0) {
    return createResult(true, 'NO_MENUS_OPEN', 'No menus were open.');
  }

  debug('closeMenusIfNeeded: trying to close menus', {
    initialCount,
    allowBodyClick,
    aggressiveBodyClicks,
    waitBeforeMs,
    maxAttempts
  });

  let backStepAttempted = false;
  let closeEntryAttempted = false;
  let settingsToggleAttempted = false;
  let hoverRetryAttempted = false;
  let playerClickAttempted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const escapeTargets = [
      document.activeElement instanceof Element ? document.activeElement : null,
      document.body,
      document,
      window
    ];
    const seenTargets = new Set();
    for (const target of escapeTargets) {
      if (!(target instanceof EventTarget) || seenTargets.has(target)) {
        continue;
      }
      seenTargets.add(target);
      const eventOptions = {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true
      };
      target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
      await wait(Math.floor(Math.random() * 30) + 20);
      target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
    }
    await wait(100);

    const remaining = getMenuCount();
    if (remaining === 0) {
      debug('closeMenusIfNeeded: closed via escape', { attempt });
      return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', { attempts: attempt });
    }

    if (aggressiveBodyClicks && !backStepAttempted) {
      backStepAttempted = true;
      const backResult = await tryStepBackFromQualitySubmenu();
      if (backResult.ok) {
        const remainingAfterBack = getMenuCount();
        if (remainingAfterBack === 0) {
          debug('closeMenusIfNeeded: closed while stepping back from quality submenu', { attempt, backResult });
          return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', {
            attempts: attempt,
            closedBy: 'quality-back'
          });
        }
        debug('closeMenusIfNeeded: exited quality submenu, continuing close cycle', {
          attempt,
          remainingAfterBack,
          backResult
        });
        await wait(70);
      }
    }

    if (aggressiveBodyClicks && !closeEntryAttempted) {
      closeEntryAttempted = true;
      const closeEntryResult = tryCloseViaVisibleMenuCloseEntry();
      if (closeEntryResult.ok) {
        await wait(90);
        if (getMenuCount() === 0) {
          debug('closeMenusIfNeeded: closed via close-entry click', { attempt, closeEntryResult });
          return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', {
            attempts: attempt,
            closedBy: 'menu-close-entry'
          });
        }
      }
    }
    if (aggressiveBodyClicks && !settingsToggleAttempted) {
      settingsToggleAttempted = true;
      const toggleCloseResult = tryCloseViaSettingsToggle();
      if (toggleCloseResult.ok) {
        await wait(100);
        if (getMenuCount() === 0) {
          debug('closeMenusIfNeeded: closed via settings toggle click', { attempt, toggleCloseResult });
          return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', {
            attempts: attempt,
            closedBy: 'settings-toggle'
          });
        }
      }
    }

    // Hover to reveal controls (settings button may not be visible while in a quality submenu)
    // then retry the settings toggle. Keeps this attempt independent of allowBodyClick so it
    // always runs before the outside-click fallback — which can accidentally toggle VOD play/pause.
    if (aggressiveBodyClicks && !hoverRetryAttempted) {
      hoverRetryAttempted = true;
      const hoverPlayerResult = getPlayerRoot();
      if (hoverPlayerResult.ok && hoverPlayerResult.details?.element) {
        triggerPlayerHover(hoverPlayerResult.details.element);
        await wait(200);
      }
      const hoverRetryResult = tryCloseViaSettingsToggle();
      if (hoverRetryResult.ok) {
        await wait(100);
        if (getMenuCount() === 0) {
          debug('closeMenusIfNeeded: closed via hover + settings toggle retry', { attempt });
          return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', {
            attempts: attempt,
            closedBy: 'hover-settings-toggle-retry'
          });
        }
      }
    }

    // Last resort: click inside player area to avoid navigation.
    if (allowBodyClick && !playerClickAttempted && (aggressiveBodyClicks || attempt >= 2)) {
      // Mark early to prevent re-entry on subsequent iterations regardless of which path runs.
      playerClickAttempted = true;

      // In fullscreen, body clicks on the player trigger Twitch's exit-fullscreen handler.
      // Hover to reveal controls first, then use the settings gear toggle as a safe alternative.
      if (isBrowserInFullscreen()) {
        const fsPlayerResult = getPlayerRoot();
        if (fsPlayerResult.ok && fsPlayerResult.details?.element) {
          triggerPlayerHover(fsPlayerResult.details.element);
          await wait(200);
        }
        const fsToggleResult = tryCloseViaSettingsToggle();
        if (fsToggleResult.ok) {
          await wait(100);
          if (getMenuCount() === 0) {
            debug('closeMenusIfNeeded: fullscreen — closed via hover + settings toggle', { attempt });
            return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', {
              attempts: attempt,
              closedBy: 'fullscreen-hover-settings-toggle'
            });
          }
        }
        await wait(80);
        continue;
      }

      const playerRootResult = getPlayerRoot();
      if (!playerRootResult.ok || !(playerRootResult.details?.element instanceof Element)) {
        await wait(80);
        continue;
      }

      const playerRoot = playerRootResult.details.element;
      const playerRect = playerRoot.getBoundingClientRect();
      if (playerRect.width < 20 || playerRect.height < 20) {
        await wait(80);
        continue;
      }

      const menuRoots = findVisibleMenuRoots();
      const menuRects = menuRoots.map((root) => root.getBoundingClientRect());
      // Skip points inside open menus to avoid accidental selection.
      const pointInsideAnyMenu = (point) => {
        return menuRects.some((rect) => {
          return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
        });
      };

      const clickPoints = [
        { x: playerRect.left + playerRect.width * 0.50 + jitter(), y: playerRect.top + playerRect.height * 0.60 + jitter() },
        { x: playerRect.left + playerRect.width * 0.20 + jitter(), y: playerRect.top + playerRect.height * 0.65 + jitter() },
        { x: playerRect.left + playerRect.width * 0.80 + jitter(), y: playerRect.top + playerRect.height * 0.65 + jitter() }
      ];

      let clicked = false;
      for (const point of clickPoints) {
        const clampedPoint = {
          x: Math.min(window.innerWidth - 2, Math.max(2, Math.floor(point.x))),
          y: Math.min(window.innerHeight - 2, Math.max(2, Math.floor(point.y)))
        };
        if (pointInsideAnyMenu(clampedPoint)) {
          continue;
        }
        const clickTarget = document.elementFromPoint(clampedPoint.x, clampedPoint.y);
        if (!(clickTarget instanceof Element) || !isElementVisible(clickTarget)) {
          continue;
        }
        if (!playerRoot.contains(clickTarget)) {
          continue;
        }
        if (clickTarget.closest('a[href], [role="link"], button, [role="button"], input, select, textarea, video')) {
          continue;
        }
        if (isAdCurrentlyPlaying()) {
          break;
        }
        // Re-check focus at dispatch time — the allowBodyClick flag was set before
        // the preceding await operations (escape key, back button, toggle retries)
        // and may be stale. A stale true flag would cause a body click on Twitch's
        // play/pause overlay, toggling VOD/stream play state.
        if (!document.hasFocus() || document.visibilityState !== 'visible') {
          debug('closeMenusIfNeeded: aborting body click — focus lost since allowBodyClick was set');
          break;
        }
        const mouseOptions = {
          bubbles: true,
          cancelable: true,
          clientX: clampedPoint.x,
          clientY: clampedPoint.y,
          view: window
        };
        clickTarget.dispatchEvent(new MouseEvent('mousedown', mouseOptions));
        await wait(Math.floor(Math.random() * 40) + 30);
        clickTarget.dispatchEvent(new MouseEvent('mouseup', mouseOptions));
        await wait(Math.floor(Math.random() * 20) + 10);
        clickTarget.dispatchEvent(new MouseEvent('click', mouseOptions));
        clicked = true;
        break;
      }

      if (!clicked) {
        await wait(80);
        continue;
      }

      await wait(120);
      const remainingAfterClick = getMenuCount();
      if (remainingAfterClick === 0) {
        debug('closeMenusIfNeeded: closed via outside click', { attempt, aggressiveBodyClicks, clicked });
        return createResult(true, 'MENUS_CLOSED', 'Menus closed successfully.', {
          attempts: attempt,
          closedBy: 'outside-click'
        });
      }
    }
  }

  const remaining = getMenuCount();
  return createResult(false, 'MENU_CLOSE_TIMEOUT', 'Menus remained open after close attempts.', {
    remaining
  });
}
