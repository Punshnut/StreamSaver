/**
 * content/subtitles-toggle.js
 *
 * Reads and toggles Twitch's native subtitles/closed-captions button. Unlike
 * quality and Low Latency, this control lives directly in the player's
 * toolbar — no settings overlay is involved.
 *
 * findSubtitlesToggleButton(playerRoot)
 *   Locates the CC button via Twitch's stable data-a-target attribute, with a
 *   locale-aware fallback through the same control-zone hunting used for the
 *   settings gear.
 *
 * readSubtitlesState(button)
 *   Reads aria-pressed on the button — Twitch's own on/off signal for this control.
 *
 * applySubtitlesState(desiredEnabled)
 *   Full apply sequence: wake controls, find the button, skip the click if the
 *   live state already matches, otherwise click and confirm the flip.
 */

import { SETTINGS_MENU_LABEL_GROUPS } from './constants.js';
import { debug, createResult, wait, stealthClick, awaitSignal } from './utils.js';
import { getPlayerRoot, wakePlayerControls, mapControlZones, huntSettingsTriggers } from './player.js';
import { sweepMenus } from './menu-close.js';

const SUBTITLES_BUTTON_SELECTOR = '[data-a-target="player-captions-toggle-button"]';

/** Locates the subtitles/CC toggle button inside the player. */
export function findSubtitlesToggleButton(playerRoot) {
  if (!(playerRoot instanceof Element)) {
    return createResult(false, 'PLAYER_NOT_FOUND', 'Cannot find subtitles button without a player root.');
  }

  const direct = playerRoot.querySelector(SUBTITLES_BUTTON_SELECTOR);
  if (direct instanceof HTMLElement) {
    return createResult(true, 'SUBTITLES_BUTTON_FOUND', 'Found subtitles button via data-a-target.', {
      element: direct,
      matchedBy: 'data-a-target'
    });
  }

  // Fallback: reuse the same control-zone + term-matching hunt used for the
  // settings gear, matching against the subtitles locale term group instead.
  const controlScopes = mapControlZones(playerRoot);
  const candidates = huntSettingsTriggers(playerRoot, controlScopes).filter((candidate) => {
    const haystack = `${candidate.text} ${candidate.ariaLabel} ${candidate.title} ${candidate.dataTarget}`.toLowerCase();
    return SETTINGS_MENU_LABEL_GROUPS.subtitles.some((term) => haystack.includes(term));
  });

  if (candidates.length === 0) {
    return createResult(false, 'SUBTITLES_BUTTON_NOT_FOUND', 'Subtitles button not found in player controls.');
  }

  return createResult(true, 'SUBTITLES_BUTTON_FOUND', 'Found subtitles button via locale term match.', {
    element: candidates[0].element,
    matchedBy: 'locale-term'
  });
}

/** Reads whether subtitles currently appear enabled from the button's own state. */
export function readSubtitlesState(button) {
  if (!(button instanceof Element)) {
    return null;
  }
  const ariaPressed = String(button.getAttribute('aria-pressed') || '').toLowerCase();
  if (ariaPressed === 'true') return true;
  if (ariaPressed === 'false') return false;
  return null;
}

/** Applies the desired Subtitles state to the live Twitch player. */
export async function applySubtitlesState(desiredEnabled) {
  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    return createResult(false, 'PLAYER_NOT_FOUND', 'No Twitch player found on this page.');
  }
  const playerRoot = playerRootResult.details.element;

  // Defensive: a leftover overlay from a previous/concurrent operation could be
  // covering the toolbar button. This never opens a menu itself, so it's cheap.
  await sweepMenus({ allowBodyClick: false, maxAttempts: 1 });

  wakePlayerControls(playerRoot);
  await wait(120);

  let buttonResult = findSubtitlesToggleButton(playerRoot);
  if (!buttonResult.ok) {
    const waitResult = await awaitSignal(() => {
      wakePlayerControls(playerRoot);
      const maybe = findSubtitlesToggleButton(playerRoot);
      return maybe.ok ? maybe : null;
    }, { timeoutMs: 1200, intervalMs: 120, description: 'subtitles button' });

    if (!waitResult.ok) {
      return createResult(false, 'SUBTITLES_BUTTON_NOT_FOUND', 'Could not find the subtitles button on this stream.', { waitResult });
    }
    buttonResult = waitResult.details.value;
  }

  const button = buttonResult.details.element;
  const currentState = readSubtitlesState(button);
  debug('applySubtitlesState: current state', { currentState, desiredEnabled, matchedBy: buttonResult.details.matchedBy });

  if (currentState === desiredEnabled) {
    return createResult(true, 'SUBTITLES_ALREADY_CORRECT', `Subtitles already ${desiredEnabled ? 'on' : 'off'}.`, {
      desiredEnabled,
      currentState
    });
  }

  const clickResult = stealthClick(button, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click the subtitles button.', { clickResult });
  }

  const confirmResult = await awaitSignal(() => readSubtitlesState(button) === desiredEnabled, {
    timeoutMs: 800,
    intervalMs: 60,
    description: 'subtitles state flip'
  });

  if (!confirmResult.ok) {
    return createResult(false, 'SUBTITLES_STATE_UNCONFIRMED', 'Clicked the subtitles button, but could not confirm the new state.', { confirmResult });
  }

  return createResult(true, 'SUBTITLES_APPLIED', `Subtitles turned ${desiredEnabled ? 'on' : 'off'}.`, { desiredEnabled });
}
