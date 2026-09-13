/**
 * content/advanced-menu.js
 *
 * Reads and toggles Twitch's Low Latency setting, which lives inside the
 * Settings gear → Advanced submenu (unlike Subtitles, a direct toolbar
 * button). Mirrors the open/find/click/confirm shape of quality-menu.js, but
 * for a single on/off row instead of a list of quality tiers.
 *
 * findAdvancedMenuEntry()  — locates the "Advanced" row inside the open settings overlay
 * deployAdvancedPanel()    — opens settings, clicks Advanced, waits for its submenu to render
 * findLowLatencyRow()      — locates the "Low Latency" row inside the open Advanced submenu
 * readLowLatencyState()    — infers on/off from aria-checked / checked input / class hints
 * applyLowLatencyState()   — full apply sequence, shielded so the overlay never visibly flashes
 */

import { SETTINGS_MENU_LABEL_GROUPS } from './constants.js';
import { debug, createResult, isMenuEntryUsable, getMenuEntryText, wait, stealthClick, awaitSignal } from './utils.js';
import { serializeRect } from './geometry.js';
import { scanMenuRoots, findSettingsMenuRootsByText } from './menu-find.js';
import { deploySettingsPanel } from './settings-menu.js';
import { canProceedAfterSettingsResult } from './quality-menu.js';
import { deployMenuShield, liftMenuShield } from './menu-hider.js';
import { sweepMenus } from './menu-close.js';
import { getPlayerRoot, wakePlayerControls } from './player.js';

function collectMenuRoots() {
  const menuRoots = scanMenuRoots();
  const seenRoots = new Set(menuRoots);
  for (const root of findSettingsMenuRootsByText()) {
    if (!seenRoots.has(root)) {
      seenRoots.add(root);
      menuRoots.push(root);
    }
  }
  return menuRoots;
}

/** Finds the "Advanced" row inside the currently open settings overlay. */
export function findAdvancedMenuEntry() {
  const menuRoots = collectMenuRoots();
  if (menuRoots.length === 0) {
    return createResult(false, 'MENU_NOT_VISIBLE', 'No visible menu to search for the Advanced entry.');
  }

  const selector = 'button, [role="menuitem"], [role="option"], [role="button"], a, [data-a-target], div, span';
  const candidates = [];

  for (const menuRoot of menuRoots) {
    const entries = Array.from(menuRoot.querySelectorAll(selector)).filter((entry) => isMenuEntryUsable(entry));
    for (const entry of entries) {
      const entryText = getMenuEntryText(entry) || String(entry.textContent || '').replace(/\s+/g, ' ').trim();
      if (!entryText) {
        continue;
      }
      const text = entryText.toLowerCase();
      const labelMatch = SETTINGS_MENU_LABEL_GROUPS.advanced.some((label) => text.includes(label));
      if (!labelMatch) {
        continue;
      }

      const score =
        4 +
        (entry.matches('button, [role="button"], [role="menuitem"]') ? 2 : 0) +
        Math.max(0, 20 - entryText.length) / 10;

      candidates.push({
        element: entry,
        label: entryText,
        score,
        rect: serializeRect(entry.getBoundingClientRect())
      });
    }
  }

  if (candidates.length === 0) {
    return createResult(false, 'ADVANCED_ENTRY_NOT_FOUND', 'Advanced entry was not found in visible menus.');
  }

  candidates.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  const best = candidates[0];
  return createResult(true, 'ADVANCED_ENTRY_FOUND', 'Found Advanced menu entry.', {
    element: best.element,
    label: best.label
  });
}

/** Opens Settings → Advanced and waits for its submenu to render. */
export async function deployAdvancedPanel() {
  debug('deployAdvancedPanel: opening settings first');

  const settingsResult = await deploySettingsPanel();
  if (!canProceedAfterSettingsResult(settingsResult)) {
    return createResult(false, settingsResult.code, settingsResult.message, settingsResult.details);
  }

  let advancedEntryResult = findAdvancedMenuEntry();
  if (!advancedEntryResult.ok) {
    const waitResult = await awaitSignal(() => {
      const maybeEntry = findAdvancedMenuEntry();
      return maybeEntry.ok ? maybeEntry : null;
    }, { timeoutMs: 1200, intervalMs: 80, description: 'advanced menu entry' });

    if (!waitResult.ok) {
      return createResult(false, 'ADVANCED_ENTRY_NOT_FOUND', 'Could not find the Advanced entry after opening settings.', {
        settingsResult,
        waitResult
      });
    }
    advancedEntryResult = waitResult.details.value;
  }

  debug('deployAdvancedPanel: clicking advanced entry', advancedEntryResult.details.label);
  const clickResult = stealthClick(advancedEntryResult.details.element, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click the Advanced entry.', { clickResult });
  }

  // Keep the settings overlay awake while polling for the submenu to render —
  // without a re-hover, Twitch's own idle/inactivity timer can start dismissing
  // the overlay mid-wait, which surfaces as a false ADVANCED_SUBMENU_NOT_FOUND.
  // Mirrors subtitles-toggle.js's equivalent wait loop, which does the same.
  const playerRootResult = getPlayerRoot();
  const playerRoot = playerRootResult.ok ? playerRootResult.details.element : null;

  const rowWaitResult = await awaitSignal(() => {
    wakePlayerControls(playerRoot);
    const maybeRow = findLowLatencyRow();
    return maybeRow.ok ? maybeRow : null;
  }, { timeoutMs: 1400, intervalMs: 90, description: 'Advanced submenu rows' });

  if (!rowWaitResult.ok) {
    return createResult(false, 'ADVANCED_SUBMENU_NOT_FOUND', 'Advanced submenu did not render visible rows in time.', { rowWaitResult });
  }

  return createResult(true, 'ADVANCED_SUBMENU_OPEN', 'Advanced submenu opened successfully.', {
    lowLatencyRow: rowWaitResult.details.value
  });
}

/** Finds the "Low Latency" row inside the open Advanced submenu. */
export function findLowLatencyRow() {
  const menuRoots = collectMenuRoots();
  if (menuRoots.length === 0) {
    return createResult(false, 'MENU_NOT_VISIBLE', 'No visible menu to search for the Low Latency row.');
  }

  const selector = 'button, [role="menuitem"], [role="menuitemradio"], [role="option"], label, div, span';
  const candidates = [];

  for (const menuRoot of menuRoots) {
    const entries = Array.from(menuRoot.querySelectorAll(selector)).filter((entry) => isMenuEntryUsable(entry));
    for (const entry of entries) {
      const entryText = getMenuEntryText(entry) || String(entry.textContent || '').replace(/\s+/g, ' ').trim();
      if (!entryText) {
        continue;
      }
      const text = entryText.toLowerCase();
      const labelMatch = SETTINGS_MENU_LABEL_GROUPS.lowLatency.some((label) => text.includes(label));
      if (!labelMatch) {
        continue;
      }

      candidates.push({
        element: entry,
        label: entryText,
        score: entry.matches('button, [role="menuitemradio"], [role="menuitem"], label') ? 2 : 1
      });
    }
  }

  if (candidates.length === 0) {
    return createResult(false, 'LOW_LATENCY_ROW_NOT_FOUND', 'Low Latency row was not found in visible menus.');
  }

  candidates.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  const best = candidates[0];
  return createResult(true, 'LOW_LATENCY_ROW_FOUND', 'Found Low Latency row.', {
    element: best.element,
    label: best.label
  });
}

/** Infers whether Low Latency is currently on from aria/class/checkbox hints on its row. */
export function readLowLatencyState(row) {
  if (!(row instanceof Element)) {
    return null;
  }

  const ariaChecked = String(row.getAttribute('aria-checked') || '').toLowerCase();
  if (ariaChecked === 'true') return true;
  if (ariaChecked === 'false') return false;

  const checkedInput = row.querySelector('input[type="checkbox"], input[type="radio"]');
  if (checkedInput instanceof HTMLInputElement) {
    return checkedInput.checked;
  }

  const classDataText = [
    String(row.className || ''),
    String(row.getAttribute('data-a-target') || ''),
    String(row.getAttribute('data-state') || '')
  ].join(' ').toLowerCase();
  if (/\b(selected|is-selected|active|is-active|checked|on)\b/.test(classDataText)) {
    return true;
  }
  if (/\b(unselected|is-inactive|unchecked|off)\b/.test(classDataText)) {
    return false;
  }

  return null;
}

/** Applies the desired Low Latency state via Settings → Advanced, shielded from view. */
export async function applyLowLatencyState(desiredEnabled) {
  deployMenuShield();
  try {
    const closeBeforeResult = await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: false, maxAttempts: 2 });
    if (!closeBeforeResult.ok) {
      debug('applyLowLatencyState: close-before step incomplete; continuing', closeBeforeResult);
    }

    // Every branch below sets applyResult instead of returning directly, so the
    // close-after sweep further down always runs — including on failure paths.
    // Skipping it here previously left Twitch's settings overlay stuck open,
    // which menu-hider.js would then force-close via sweepMenus's last-resort
    // outside-click fallback, landing on (and pausing) a VOD's video layer.
    let applyResult;

    const panelResult = await deployAdvancedPanel();
    if (!panelResult.ok) {
      applyResult = createResult(false, panelResult.code, panelResult.message, { panelResult });
    } else {
      let rowResult = panelResult.details.lowLatencyRow?.ok ? panelResult.details.lowLatencyRow : findLowLatencyRow();
      if (!rowResult.ok) {
        applyResult = createResult(false, rowResult.code, rowResult.message, { rowResult });
      } else {
        const row = rowResult.details.element;
        const currentState = readLowLatencyState(row);
        debug('applyLowLatencyState: current state', { currentState, desiredEnabled });

        if (currentState === desiredEnabled) {
          applyResult = createResult(true, 'LOW_LATENCY_ALREADY_CORRECT', `Low Latency already ${desiredEnabled ? 'on' : 'off'}.`, {
            desiredEnabled,
            currentState
          });
        } else {
          const clickResult = stealthClick(row, { prepare: false });
          if (!clickResult.ok) {
            applyResult = createResult(false, clickResult.code, 'Failed to click the Low Latency row.', { clickResult });
          } else {
            const confirmResult = await awaitSignal(() => readLowLatencyState(row) === desiredEnabled, {
              timeoutMs: 800,
              intervalMs: 60,
              description: 'Low Latency state flip'
            });
            applyResult = confirmResult.ok
              ? createResult(true, 'LOW_LATENCY_APPLIED', `Low Latency turned ${desiredEnabled ? 'on' : 'off'}.`, { desiredEnabled })
              : createResult(false, 'LOW_LATENCY_STATE_UNCONFIRMED', 'Clicked the Low Latency row, but could not confirm the new state.', { confirmResult });
          }
        }
      }
    }

    const windowHasFocus = document.visibilityState === 'visible' && document.hasFocus();
    let closeAfterResult = await sweepMenus({
      allowBodyClick: windowHasFocus,
      aggressiveBodyClicks: true,
      waitBeforeMs: 350,
      maxAttempts: 2
    });
    if (!closeAfterResult.ok) {
      debug('applyLowLatencyState: close-after first pass failed, retrying with extra settle delay', closeAfterResult);
      closeAfterResult = await sweepMenus({
        allowBodyClick: windowHasFocus,
        aggressiveBodyClicks: true,
        waitBeforeMs: 500,
        maxAttempts: 2
      });
    }
    if (!closeAfterResult.ok) {
      debug('applyLowLatencyState: close-after step incomplete', closeAfterResult);
    }

    return createResult(applyResult.ok, applyResult.code, applyResult.message, {
      ...applyResult.details,
      closeBeforeResult,
      closeAfterResult
    });
  } finally {
    await liftMenuShield();
  }
}
