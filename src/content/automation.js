/**
 * content/automation.js
 *
 * High-level quality automation orchestration. Each exported function wraps one
 * full UI interaction sequence and returns a structured result object.
 *
 * lockQualityRun(action, runFn)
 *   Module-level mutex: ensures only one quality change runs at a time.
 *   Returns SETQUALITY_BUSY if called while a run is already in progress.
 *
 * runQualityMission(targetQuality, pageSupport, action, extraDetails)
 *   Full pipeline for switching quality:
 *     1. Deploys the menu shield (CSS hider)
 *     2. Closes any pre-existing menus
 *     3. Optionally stops at settings-debug mode to check menu accessibility
 *     4. Calls engageQuality() to open menus and click the target
 *     5. Closes all menus again
 *     6. Lifts the menu shield
 *
 * scanQualityState()
 *   Opens the quality submenu, reads the currently selected option, then
 *   closes the submenu. Used by enforcement.js to detect whether quality
 *   already matches the target before deciding whether a click is needed.
 *
 * routeQualityRequest(targetQuality, pageSupport)
 *   Entry point for popup-initiated setQuality messages. Acquires the lock,
 *   checks plugin-enabled state, then delegates to runQualityMission().
 */

import { SETTINGS_MENU_DEBUG_MODE } from './constants.js';
import { debug, createResult, wait } from './utils.js';
import { forgeResponse, validateQuality } from './page-support.js';
import { isAdLive } from './ad-detection.js';
import { deployMenuShield, liftMenuShield } from './menu-hider.js';
import { engageQuality } from './quality-apply.js';
import { deployQualityPanel, readActiveQuality, scanQualityOptions } from './quality-menu.js';
import { sweepMenus } from './menu-close.js';
import { loadPluginEnabledSetting } from './storage.js';
import { getPlayerRoot } from './player.js';

// Holds the currently executing quality run Promise, or null when idle.
// Inspected by lockQualityRun to reject concurrent callers immediately.
let activeSetQualityRun = null;

/** Serializes quality requests to avoid UI races. */
export async function lockQualityRun(action, runFn) {
  // If a run is already in flight, tell the caller to retry rather than
  // queuing — queuing would cause two sequential menu interactions.
  if (activeSetQualityRun) {
    return forgeResponse(false, action, 'Another settings request is still running. Please retry in a moment.', {
      code: 'SETQUALITY_BUSY'
    });
  }

  // Wrap runFn in a resolved promise so the assignment happens before the
  // first await, making the slot visibly "taken" to any concurrent caller.
  const runPromise = Promise.resolve().then(runFn);
  activeSetQualityRun = runPromise;
  try {
    return await runPromise;
  } finally {
    // Only clear the slot if we still own it — a racing call could have
    // replaced it, though that shouldn't happen given the guard above.
    if (activeSetQualityRun === runPromise) {
      activeSetQualityRun = null;
    }
  }
}

/** Executes the existing quality-change automation flow for one target quality. */
export async function runQualityMission(targetQuality, pageSupport, action = 'setQuality', extraDetails = {}) {
  // Normalize and validate before touching anything else — reject unknown values early.
  const normalizedTarget = validateQuality(targetQuality);
  if (!normalizedTarget) {
    return forgeResponse(false, action, 'Invalid target quality.', { targetQuality, ...extraDetails });
  }

  debug('runQualityMission: request received', {
    action,
    normalizedTarget,
    settingsMenuDebugOnly: SETTINGS_MENU_DEBUG_MODE
  });

  // Confirm the player is still present. It may have unmounted between the
  // caller's last check and now (e.g. during a SPA navigation).
  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    return forgeResponse(false, action, 'No Twitch player found on this page.', {
      targetQuality: normalizedTarget,
      step: playerRootResult,
      pageSupport,
      ...extraDetails
    });
  }

  // Mid-stream ads can appear at any time. Quality switching during an ad
  // confuses Twitch's ad playback state; bail and let the caller retry after.
  if (isAdLive()) {
    return forgeResponse(false, action, 'Quality change skipped — Twitch ad is currently playing.', {
      targetQuality: normalizedTarget,
      pageSupport,
      ...extraDetails
    });
  }

  // Raise the CSS hider before any DOM interaction so the user never sees the
  // settings overlay flash open. The hider is ref-counted — liftMenuShield()
  // in the finally block decrements it and removes the style tag when it hits 0.
  deployMenuShield();
  try {
    // Sweep any menus that may already be open from a previous failed run.
    // allowBodyClick:false because we haven't verified focus is still valid yet.
    const closeBeforeResult = await sweepMenus({
      allowBodyClick: false,
      aggressiveBodyClicks: false,
      waitBeforeMs: 0,
      maxAttempts: 2
    });
    if (!closeBeforeResult.ok) {
      debug('runQualityMission: close-before step incomplete; continuing', closeBeforeResult);
    }

    // Debug-only mode: open the quality submenu and confirm it renders, then
    // close it without clicking anything. Used for diagnosing menu detection issues.
    if (SETTINGS_MENU_DEBUG_MODE) {
      const qualitySubmenuResult = await deployQualityPanel();
      debug('runQualityMission: settings-menu debug result', qualitySubmenuResult);
      const closeAfterDebugResult = await sweepMenus({
        allowBodyClick: true,
        aggressiveBodyClicks: true,
        waitBeforeMs: 160,
        maxAttempts: 2
      });

      if (!qualitySubmenuResult.ok) {
        return forgeResponse(false, action, qualitySubmenuResult.message, {
          targetQuality: normalizedTarget,
          settingsMenuDebugOnly: true,
          resultCode: qualitySubmenuResult.code,
          step: qualitySubmenuResult,
          closeBefore: closeBeforeResult,
          closeAfter: closeAfterDebugResult,
          playerSelector: playerRootResult.details.selector,
          pageSupport,
          ...extraDetails
        });
      }

      return forgeResponse(true, action, 'Quality submenu debug check passed. Resolution switching is temporarily disabled.', {
        targetQuality: normalizedTarget,
        settingsMenuDebugOnly: true,
        resultCode: qualitySubmenuResult.code,
        step: qualitySubmenuResult,
        closeBefore: closeBeforeResult,
        closeAfter: closeAfterDebugResult,
        playerSelector: playerRootResult.details.selector,
        pageSupport,
        ...extraDetails
      });
    }

    const attemptResult = await engageQuality(normalizedTarget);

    // Extract quality values from the result with safe fallbacks.
    // appliedQuality may differ from requestedQuality when a boundary fallback
    // was used (e.g. stream max is 720p but user wanted 1080p → applied 720p).
    const requestedQuality =
      validateQuality(attemptResult?.details?.requestedQuality) || validateQuality(attemptResult?.details?.targetQuality) || normalizedTarget;
    const appliedQuality =
      validateQuality(attemptResult?.details?.appliedQuality) || validateQuality(attemptResult?.details?.targetQuality) || requestedQuality;
    const resolutionAdjustment =
      attemptResult?.details?.resolutionAdjustment && typeof attemptResult.details.resolutionAdjustment === 'object'
        ? attemptResult.details.resolutionAdjustment
        : null;

    // Snapshot focus state now, before the async close passes below.
    // If the user tabbed away while engageQuality was running we must not
    // dispatch a player-area body click — it would land on the video overlay
    // and toggle play/pause on the VOD (or live stream).
    const windowHasFocus = document.visibilityState === 'visible' && document.hasFocus();

    // First close pass: 350 ms settle gives Twitch time to finish its own
    // menu-close animation after our click.
    let closeAfterResult = await sweepMenus({
      allowBodyClick: windowHasFocus,
      aggressiveBodyClicks: true,
      waitBeforeMs: 350,
      maxAttempts: 2
    });
    if (!closeAfterResult.ok) {
      // Menus are still open after first pass — give them more time to settle
      // (Firefox often needs a longer wait) then try again.
      debug('runQualityMission: close-after first pass failed, retrying with extra settle delay', closeAfterResult);
      const closeAfterRetryResult = await sweepMenus({
        allowBodyClick: windowHasFocus,
        aggressiveBodyClicks: true,
        waitBeforeMs: 500,
        maxAttempts: 2
      });
      // Wrap both pass results together so the caller can inspect what happened.
      closeAfterResult = closeAfterRetryResult.ok
        ? createResult(true, 'MENUS_CLOSED_AFTER_RETRY', 'Menus closed successfully after delayed retry.', {
            firstPass: closeAfterResult,
            retryPass: closeAfterRetryResult
          })
        : createResult(false, 'MENU_CLOSE_TIMEOUT_AFTER_RETRY', 'Menus remained open after immediate and delayed close attempts.', {
            firstPass: closeAfterResult,
            retryPass: closeAfterRetryResult
          });
    }
    if (!closeAfterResult.ok) {
      debug('runQualityMission: close-after step incomplete', closeAfterResult);
    }

    // Return failure or success — both paths include the full diagnostic payload
    // so the popup can display precise status messages.
    if (!attemptResult.ok) {
      return forgeResponse(false, action, attemptResult.message, {
        requestedQuality,
        targetQuality: appliedQuality,
        appliedQuality,
        resolutionAdjustment,
        resultCode: attemptResult.code,
        step: attemptResult,
        closeBefore: closeBeforeResult,
        closeAfter: closeAfterResult,
        playerSelector: playerRootResult.details.selector,
        pageSupport,
        ...extraDetails
      });
    }

    return forgeResponse(true, action, attemptResult.message, {
      requestedQuality,
      targetQuality: appliedQuality,
      appliedQuality,
      resolutionAdjustment,
      resultCode: attemptResult.code,
      step: attemptResult,
      closeBefore: closeBeforeResult,
      closeAfter: closeAfterResult,
      playerSelector: playerRootResult.details.selector,
      pageSupport,
      ...extraDetails
    });
  } finally {
    // Always lift the shield — even if we threw. liftMenuShield() will attempt
    // a final menu sweep before removing the <style> tag.
    await liftMenuShield();
  }
}

/** Detects current quality from visible Twitch menu state. */
export async function scanQualityState() {
  // Shield the menus while we open them for inspection — user shouldn't see this.
  deployMenuShield();
  try {
    // Clear any pre-existing menus before opening fresh.
    const closeBeforeResult = await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
    if (!closeBeforeResult.ok) {
      debug('scanQualityState: close-before step incomplete; continuing', closeBeforeResult);
    }

    // Open settings → quality submenu so options become visible.
    const openResult = await deployQualityPanel();
    if (!openResult.ok) {
      // Opening failed — close whatever opened and report failure.
      const closeAfterResult = await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
      return createResult(false, 'CURRENT_QUALITY_OPEN_FAILED', 'Could not open quality menu to detect current selection.', {
        quality: 'unknown',
        openResult,
        closeBeforeResult,
        closeAfterResult
      });
    }

    // Read all visible option elements and their selection signals.
    const optionsResult = scanQualityOptions();
    if (!optionsResult.ok) {
      const closeAfterResult = await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
      return createResult(false, 'CURRENT_QUALITY_OPTIONS_FAILED', optionsResult.message, {
        quality: 'unknown',
        openResult,
        optionsResult,
        closeBeforeResult,
        closeAfterResult
      });
    }

    // Infer which option is selected from the collected aria/class signals.
    const detectionResult = readActiveQuality(optionsResult.details.options);
    debug('scanQualityState: selection inference result', {
      code: detectionResult.code,
      message: detectionResult.message,
      quality: detectionResult.details?.quality,
      method: detectionResult.details?.method,
      reason: detectionResult.details?.reason
    });

    // Close the submenu we opened for detection.
    const closeAfterResult = await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
    if (!closeAfterResult.ok) {
      debug('scanQualityState: close-after step incomplete', closeAfterResult);
    }

    // Attach the open/close results to the detection result for diagnostics.
    detectionResult.details = {
      ...(detectionResult.details || {}),
      closeBeforeResult,
      closeAfterResult
    };
    return detectionResult;
  } finally {
    await liftMenuShield();
  }
}

/** Handles action=setQuality using validated page state and robust UI automation. */
export async function routeQualityRequest(targetQuality, pageSupport) {
  // Acquire the mutex so concurrent popup clicks don't race each other.
  return lockQualityRun('setQuality', async () => {
    // Re-read plugin state at dispatch time — user may have toggled it
    // between the original message check and this inner execution.
    const pluginEnabledResult = await loadPluginEnabledSetting();
    if (!pluginEnabledResult.ok) {
      return forgeResponse(false, 'setQuality', pluginEnabledResult.message, pluginEnabledResult.details);
    }
    if (!pluginEnabledResult.details?.pluginEnabled) {
      return forgeResponse(false, 'setQuality', 'Plugin logic is disabled. Turn it on in the popup to apply quality changes.', {
        pluginEnabled: false
      });
    }
    return runQualityMission(targetQuality, pageSupport, 'setQuality');
  });
}
