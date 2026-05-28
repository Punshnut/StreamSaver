import { ENFORCEMENT_COOLDOWN_MS, ENFORCEMENT_DEBOUNCE_MS, QUALITY_TRUST_TTL_MS, TIMINGS, missionState, MODE_VALUES, ENFORCEMENT_PLAYER_READY_TIMEOUT_MS } from './constants.js';
import { debug, wait, isUserTypingInInput, createResult, awaitSignal } from './utils.js';
import { isSupportedTwitchPage } from './page-support.js';
import { getPlayerRoot } from './player.js';
import { isAdLive } from './ad-detection.js';
import { loadPluginEnabledSetting, loadModeSettingsForEnforcement, aimQualityForMode } from './storage.js';
import { runQualityMission, lockQualityRun, scanQualityState } from './automation.js';
import { sweepMenus } from './menu-close.js';
import { isBrowserInFullscreen, attemptRestoreTwitchFullscreen } from './fullscreen.js';

/** Bridges page-support classification into structured step results. */
function getPageSupportState() {
  const support = isSupportedTwitchPage();
  if (!support.supported) {
    return createResult(false, 'UNSUPPORTED_PAGE', support.reason, support.details);
  }

  return createResult(true, 'SUPPORTED_PAGE', support.reason, {
    support
  });
}

/** Computes remaining cooldown time before the next auto-enforcement run. */
export function strikeCooldownMs() {
  if (!missionState.lastStrikeAtMs) {
    return 0;
  }
  return Math.max(0, ENFORCEMENT_COOLDOWN_MS - (Date.now() - missionState.lastStrikeAtMs));
}

/** Debounces and schedules mode quality enforcement. */
export function queueEnforcementRound(triggerReason, options = {}) {
  const force = options.force === true;
  const baseDelayMs = Number.isFinite(options.delayMs) ? Math.max(0, Math.floor(options.delayMs)) : ENFORCEMENT_DEBOUNCE_MS;
  const cooldownRemainingMs = strikeCooldownMs();
  const delayMs = force ? baseDelayMs : Math.max(baseDelayMs, cooldownRemainingMs);

  if (!force && cooldownRemainingMs > 0) {
    debug('quality enforcement: cooldown prevents immediate execution; deferring', {
      triggerReason,
      cooldownRemainingMs
    });
  }
  if (missionState.inProgress) {
    debug('quality enforcement: lock active while scheduling follow-up run', {
      triggerReason
    });
  }

  if (missionState.scheduledTimerId) {
    clearTimeout(missionState.scheduledTimerId);
    missionState.scheduledTimerId = null;
  }

  missionState.scheduledTimerId = setTimeout(() => {
    missionState.scheduledTimerId = null;
    runEnforcementRound(triggerReason, { force }).catch((error) => {
      debug('quality enforcement: unhandled ensure error', { triggerReason, error: String(error) });
    });
  }, delayMs);

  debug('quality enforcement: scheduled ensure run', {
    triggerReason,
    delayMs,
    force
  });
}

/** Keeps player quality aligned with active mode settings. */
export async function runEnforcementRound(triggerReason = 'unknown', options = {}) {
  const force = options.force === true;

  if (missionState.inProgress) {
    debug('quality enforcement: skipped because another run is still in progress', {
      triggerReason
    });
    return createResult(false, 'ENFORCEMENT_LOCKED', 'Quality enforcement skipped because another run is still in progress.');
  }

  const cooldownRemainingMs = strikeCooldownMs();
  if (!force && cooldownRemainingMs > 0) {
    debug('quality enforcement: skipped due cooldown', {
      triggerReason,
      cooldownRemainingMs
    });
    return createResult(false, 'ENFORCEMENT_COOLDOWN', 'Quality enforcement skipped due cooldown.', {
      cooldownRemainingMs
    });
  }

  if (isBrowserInFullscreen()) {
    debug('quality enforcement: skipped because document is in fullscreen mode', { triggerReason });
    return createResult(false, 'FULLSCREEN_ACTIVE', 'Quality enforcement skipped while in fullscreen mode.');
  }

  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
    debug('quality enforcement: skipped because tab is not visible or window is not focused', { triggerReason });
    // Remember that a force-trigger was blocked so we can replay it as force when
    // focus returns (e.g. popup was open while user changed the resolution setting).
    if (force) {
      missionState.forcePendingAfterFocus = true;
    }
    return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement skipped — tab not visible or window not focused.');
  }

  if (isUserTypingInInput()) {
    debug('quality enforcement: skipped because user is typing in a text input', { triggerReason });
    queueEnforcementRound('typing-resume', { delayMs: TIMINGS.TYPING_RESUME_DELAY_MS });
    return createResult(false, 'USER_TYPING', 'Quality enforcement skipped — user is typing in a text input.');
  }

  missionState.inProgress = true;
  debug('quality enforcement: run started', {
    triggerReason,
    force,
    url: location.href
  });

  try {
    const pluginEnabledResult = await loadPluginEnabledSetting();
    if (!pluginEnabledResult.ok) {
      debug('quality enforcement: plugin-enabled load failed', pluginEnabledResult.details);
      return pluginEnabledResult;
    }

    if (!pluginEnabledResult.details?.pluginEnabled) {
      debug('quality enforcement: skipped because plugin logic is disabled');
      return createResult(true, 'PLUGIN_DISABLED', 'Plugin logic is disabled; skipped mode enforcement.', {
        triggerReason
      });
    }

    const pageSupport = getPageSupportState();
    debug('quality enforcement: page support evaluated', {
      supported: pageSupport.ok,
      reason: pageSupport.message || pageSupport.details?.reason
    });
    if (!pageSupport.ok) {
      return createResult(false, 'UNSUPPORTED_PAGE', pageSupport.message, pageSupport.details);
    }

    const playerReadyResult = await awaitSignal(() => getPlayerRoot().ok, {
      timeoutMs: ENFORCEMENT_PLAYER_READY_TIMEOUT_MS,
      intervalMs: 250,
      description: 'player ready for quality enforcement'
    });
    debug('quality enforcement: player ready check', {
      ready: playerReadyResult.ok,
      code: playerReadyResult.code
    });
    if (!playerReadyResult.ok) {
      return createResult(false, 'PLAYER_NOT_READY', 'Player not ready yet for quality enforcement.', {
        playerReadyResult
      });
    }

    const modeSettingsResult = await loadModeSettingsForEnforcement();
    if (!modeSettingsResult.ok) {
      debug('quality enforcement: active mode load failed', modeSettingsResult.details);
      return modeSettingsResult;
    }
    if (modeSettingsResult.details?.pluginEnabled === false) {
      debug('quality enforcement: plugin disabled during mode-settings load; skipping enforcement');
      return createResult(true, 'PLUGIN_DISABLED', 'Plugin logic is disabled; skipped mode enforcement.', {
        triggerReason
      });
    }

    debug('quality enforcement: active mode loaded', modeSettingsResult.details);

    const resolvedTarget = aimQualityForMode(modeSettingsResult.details);
    debug('quality enforcement: desired target quality resolved', resolvedTarget);

    // Re-check: user may have entered fullscreen during the async setup phase above
    if (isBrowserInFullscreen()) {
      debug('quality enforcement: aborted before DOM manipulation — entered fullscreen during setup', { triggerReason });
      return createResult(false, 'FULLSCREEN_ACTIVE', 'Quality enforcement aborted — entered fullscreen during setup.');
    }

    // Re-check: user may have switched tabs or windows during the async setup phase above.
    // Menu interactions (open/close) are unreliable without focus — skip to avoid
    // accidentally toggling VOD play/pause via the outside-click fallback.
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      debug('quality enforcement: aborted before DOM manipulation — tab lost focus during setup', { triggerReason });
      if (force) {
        missionState.forcePendingAfterFocus = true;
      }
      return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement aborted — tab lost focus during setup.');
    }

    if (isAdLive()) {
      debug('quality enforcement: skipped because a Twitch ad is currently playing', { triggerReason });
      // Poll every 2 s so we automatically enforce quality as soon as the ad ends —
      // Twitch often resets to Auto/Source during an ad break.
      if (!missionState.adScanTimerId) {
        missionState.adScanTimerId = setInterval(() => {
          if (isAdLive()) return; // still in the ad
          clearInterval(missionState.adScanTimerId);
          missionState.adScanTimerId = null;
          debug('quality enforcement: ad ended — scheduling post-ad enforcement');
          queueEnforcementRound('ad-ended', { force: true, delayMs: TIMINGS.AD_CLEAR_DELAY_MS });
        }, TIMINGS.AD_SCAN_INTERVAL_MS);
      }
      return createResult(false, 'AD_PLAYING', 'Quality enforcement skipped — Twitch ad is playing.');
    }

    // Skip detect+set entirely if we recently confirmed this quality on the same URL.
    // Force triggers (storage change, SPA nav, page show) always bypass this.
    const trustAge = Date.now() - missionState.lastConfirmedQualityAtMs;
    const canSkipDetection = (
      !force &&
      missionState.lockedQuality === resolvedTarget.targetQuality &&
      missionState.lastRunUrl === location.href &&
      trustAge < QUALITY_TRUST_TTL_MS
    );
    if (canSkipDetection) {
      debug('quality enforcement: skipping detect+set — trusted quality state matches target', {
        triggerReason, trustAgeMs: trustAge, target: resolvedTarget.targetQuality
      });
      missionState.lastStrikeAtMs = Date.now();
      return createResult(true, 'QUALITY_TRUSTED', 'Quality recently confirmed; skipping menu detection.', {
        triggerReason, targetQuality: resolvedTarget.targetQuality, trustAgeMs: trustAge
      });
    }

    const currentQualityResult = await scanQualityState();

    // Re-check: scanQualityState() opens/closes menus and is async;
    // user may have entered fullscreen during that window.
    if (isBrowserInFullscreen()) {
      debug('quality enforcement: aborted after quality detection — entered fullscreen during detection', { triggerReason });
      return createResult(false, 'FULLSCREEN_ACTIVE', 'Quality enforcement aborted — entered fullscreen during quality detection.');
    }

    // Re-check: tab may have lost focus while menus were open during detection.
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      debug('quality enforcement: aborted after quality detection — tab lost focus during detection', { triggerReason });
      return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement aborted — tab lost focus during detection.');
    }

    if (currentQualityResult.ok) {
      const detectedCurrentQuality = currentQualityResult.details?.quality;
      debug('quality enforcement: current quality detected', {
        quality: detectedCurrentQuality,
        method: currentQualityResult.details?.method
      });
      if (detectedCurrentQuality === resolvedTarget.targetQuality) {
        debug('quality enforcement: skipped because current quality already matches target', {
          targetQuality: resolvedTarget.targetQuality
        });
        missionState.lockedQuality = resolvedTarget.targetQuality;
        missionState.lastConfirmedQualityAtMs = Date.now();
        // Safety net: scanQualityState opens the quality submenu and closes it,
        // but the close can fail when the tab just became visible (e.g. after sleep/wake or
        // tab switch) because escape key events may not be processed reliably at that point.
        // Ensure the menu is closed before returning so the user never sees a stuck-open menu.
        await closeMenusIfNeeded({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
        return createResult(true, 'QUALITY_ALREADY_MATCHES_MODE', 'Current quality already matches active mode.', {
          triggerReason,
          activeMode: resolvedTarget.activeMode,
          targetQuality: resolvedTarget.targetQuality,
          detectedCurrentQuality
        });
      }
    } else {
      debug('quality enforcement: current quality detection uncertain; proceeding with enforcement', {
        code: currentQualityResult.code,
        message: currentQualityResult.message
      });
    }

    const automationResponse = await lockQualityRun('modeEnforce', async () => {
      return runQualityMission(resolvedTarget.targetQuality, pageSupport, 'modeEnforce', {
        triggerReason,
        activeMode: resolvedTarget.activeMode,
        fastToggleLow: resolvedTarget.fastToggleLow,
        fastToggleHigh: resolvedTarget.fastToggleHigh
      });
    });

    if (!automationResponse.ok && automationResponse.details?.code === 'SETQUALITY_BUSY') {
      debug('quality enforcement: manual/other action lock prevented run, retrying soon', {
        triggerReason
      });
      queueEnforcementRound('retry-after-busy', { delayMs: ENFORCEMENT_DEBOUNCE_MS, force: true });
      return createResult(false, 'ENFORCEMENT_BUSY', 'Automation busy; queued retry.');
    }

    if (automationResponse.ok) {
      debug('quality enforcement: executed automation', {
        targetQuality: resolvedTarget.targetQuality,
        resultCode: automationResponse.details?.resultCode
      });
      missionState.lockedQuality = resolvedTarget.targetQuality;
      missionState.lastConfirmedQualityAtMs = Date.now();
    } else {
      debug('quality enforcement: automation failed', {
        message: automationResponse.message,
        details: automationResponse.details
      });
    }

    return createResult(automationResponse.ok, 'ENFORCEMENT_COMPLETED', automationResponse.message, {
      targetQuality: resolvedTarget.targetQuality,
      response: automationResponse
    });
  } finally {
    missionState.inProgress = false;
    missionState.lastStrikeAtMs = Date.now();
    missionState.lastRunUrl = location.href;
  }
}
