import { SETTINGS_MENU_DEBUG_MODE } from './constants.js';
import { debug, createResult, wait } from './utils.js';
import { makeResponse, validateQuality } from './page-support.js';
import { isAdCurrentlyPlaying } from './ad-detection.js';
import { showMenuHider, hideMenuHider } from './menu-hider.js';
import { attemptSetQuality } from './quality-apply.js';
import { openQualitySubmenu, detectCurrentSelectedQuality, collectVisibleQualityOptions } from './quality-menu.js';
import { closeMenusIfNeeded } from './menu-close.js';
import { loadPluginEnabledSetting } from './storage.js';
import { getPlayerRoot } from './player.js';

// Module-level state: serializes quality requests.
let activeSetQualityRun = null;

/** Serializes quality requests to avoid UI races. */
export async function runQualityRequestExclusive(action, runFn) {
  if (activeSetQualityRun) {
    return makeResponse(false, action, 'Another settings request is still running. Please retry in a moment.', {
      code: 'SETQUALITY_BUSY'
    });
  }

  const runPromise = Promise.resolve().then(runFn);
  activeSetQualityRun = runPromise;
  try {
    return await runPromise;
  } finally {
    if (activeSetQualityRun === runPromise) {
      activeSetQualityRun = null;
    }
  }
}

/** Executes the existing quality-change automation flow for one target quality. */
export async function executeSetQualityAutomation(targetQuality, pageSupport, action = 'setQuality', extraDetails = {}) {
  const normalizedTarget = validateQuality(targetQuality);
  if (!normalizedTarget) {
    return makeResponse(false, action, 'Invalid target quality.', { targetQuality, ...extraDetails });
  }

  debug('executeSetQualityAutomation: request received', {
    action,
    normalizedTarget,
    settingsMenuDebugOnly: SETTINGS_MENU_DEBUG_MODE
  });

  const playerRootResult = getPlayerRoot();
  if (!playerRootResult.ok) {
    return makeResponse(false, action, 'No Twitch player found on this page.', {
      targetQuality: normalizedTarget,
      step: playerRootResult,
      pageSupport,
      ...extraDetails
    });
  }

  if (isAdCurrentlyPlaying()) {
    return makeResponse(false, action, 'Quality change skipped — Twitch ad is currently playing.', {
      targetQuality: normalizedTarget,
      pageSupport,
      ...extraDetails
    });
  }

  showMenuHider();
  try {
    const closeBeforeResult = await closeMenusIfNeeded({
      allowBodyClick: false,
      aggressiveBodyClicks: false,
      waitBeforeMs: 0,
      maxAttempts: 2
    });
    if (!closeBeforeResult.ok) {
      debug('executeSetQualityAutomation: close-before step incomplete; continuing', closeBeforeResult);
    }

    if (SETTINGS_MENU_DEBUG_MODE) {
      const qualitySubmenuResult = await openQualitySubmenu();
      debug('executeSetQualityAutomation: settings-menu debug result', qualitySubmenuResult);
      const closeAfterDebugResult = await closeMenusIfNeeded({
        allowBodyClick: true,
        aggressiveBodyClicks: true,
        waitBeforeMs: 160,
        maxAttempts: 2
      });

      if (!qualitySubmenuResult.ok) {
        return makeResponse(false, action, qualitySubmenuResult.message, {
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

      return makeResponse(true, action, 'Quality submenu debug check passed. Resolution switching is temporarily disabled.', {
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

    const attemptResult = await attemptSetQuality(normalizedTarget);
    const requestedQuality =
      validateQuality(attemptResult?.details?.requestedQuality) || validateQuality(attemptResult?.details?.targetQuality) || normalizedTarget;
    const appliedQuality =
      validateQuality(attemptResult?.details?.appliedQuality) || validateQuality(attemptResult?.details?.targetQuality) || requestedQuality;
    const resolutionAdjustment =
      attemptResult?.details?.resolutionAdjustment && typeof attemptResult.details.resolutionAdjustment === 'object'
        ? attemptResult.details.resolutionAdjustment
        : null;

    // Snapshot focus state once before the close passes.
    // If the user tabbed away while attemptSetQuality was running we must not
    // dispatch a player-area body click — it would land on the video overlay
    // and toggle play/pause on the VOD (or live stream).
    const windowHasFocus = document.visibilityState === 'visible' && document.hasFocus();
    let closeAfterResult = await closeMenusIfNeeded({
      allowBodyClick: windowHasFocus,
      aggressiveBodyClicks: true,
      waitBeforeMs: 350,
      maxAttempts: 2
    });
    if (!closeAfterResult.ok) {
      debug('executeSetQualityAutomation: close-after first pass failed, retrying with extra settle delay', closeAfterResult);
      const closeAfterRetryResult = await closeMenusIfNeeded({
        allowBodyClick: windowHasFocus,
        aggressiveBodyClicks: true,
        waitBeforeMs: 500,
        maxAttempts: 2
      });
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
      debug('executeSetQualityAutomation: close-after step incomplete', closeAfterResult);
    }

    if (!attemptResult.ok) {
      return makeResponse(false, action, attemptResult.message, {
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

    return makeResponse(true, action, attemptResult.message, {
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
    await hideMenuHider();
  }
}

/** Detects current quality from visible Twitch menu state. */
export async function detectCurrentQualityState() {
  showMenuHider();
  try {
    const closeBeforeResult = await closeMenusIfNeeded({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
    if (!closeBeforeResult.ok) {
      debug('detectCurrentQualityState: close-before step incomplete; continuing', closeBeforeResult);
    }

    const openResult = await openQualitySubmenu();
    if (!openResult.ok) {
      const closeAfterResult = await closeMenusIfNeeded({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
      return createResult(false, 'CURRENT_QUALITY_OPEN_FAILED', 'Could not open quality menu to detect current selection.', {
        quality: 'unknown',
        openResult,
        closeBeforeResult,
        closeAfterResult
      });
    }

    const optionsResult = collectVisibleQualityOptions();
    if (!optionsResult.ok) {
      const closeAfterResult = await closeMenusIfNeeded({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
      return createResult(false, 'CURRENT_QUALITY_OPTIONS_FAILED', optionsResult.message, {
        quality: 'unknown',
        openResult,
        optionsResult,
        closeBeforeResult,
        closeAfterResult
      });
    }

    const detectionResult = detectCurrentSelectedQuality(optionsResult.details.options);
    debug('detectCurrentQualityState: selection inference result', {
      code: detectionResult.code,
      message: detectionResult.message,
      quality: detectionResult.details?.quality,
      method: detectionResult.details?.method,
      reason: detectionResult.details?.reason
    });

    const closeAfterResult = await closeMenusIfNeeded({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
    if (!closeAfterResult.ok) {
      debug('detectCurrentQualityState: close-after step incomplete', closeAfterResult);
    }

    detectionResult.details = {
      ...(detectionResult.details || {}),
      closeBeforeResult,
      closeAfterResult
    };
    return detectionResult;
  } finally {
    await hideMenuHider();
  }
}

/** Handles action=setQuality using validated page state and robust UI automation. */
export async function handleSetQualityRequest(targetQuality, pageSupport) {
  return runQualityRequestExclusive('setQuality', async () => {
    const pluginEnabledResult = await loadPluginEnabledSetting();
    if (!pluginEnabledResult.ok) {
      return makeResponse(false, 'setQuality', pluginEnabledResult.message, pluginEnabledResult.details);
    }
    if (!pluginEnabledResult.details?.pluginEnabled) {
      return makeResponse(false, 'setQuality', 'Plugin logic is disabled. Turn it on in the popup to apply quality changes.', {
        pluginEnabled: false
      });
    }
    return executeSetQualityAutomation(targetQuality, pageSupport, 'setQuality');
  });
}
