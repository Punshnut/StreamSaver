/**
 * content/enforcement.js
 *
 * The core "quality keeper" loop. Its job is to periodically check that the
 * Twitch player is showing the quality the user configured, and fix it if not.
 *
 * queueEnforcementRound(reason, options)
 *   Debounces and schedules runEnforcementRound(). Multiple rapid triggers
 *   (e.g. storage change fires while a SPA nav is in flight) collapse into a
 *   single deferred run. Force-flagged triggers bypass the cooldown window.
 *
 * runEnforcementRound(reason, options)
 *   The main gatekeeper. Before touching the DOM it checks, in order:
 *     1. No other run in progress (missionState.inProgress)
 *     2. Cooldown window not active (unless force=true)
 *     3. Browser not in fullscreen
 *     4. Tab is visible and focused
 *     5. User is not typing in chat
 *     6. Plugin is enabled in storage
 *     7. Page is a supported Twitch live/VOD URL
 *     8. Player root is present in the DOM
 *     9. No Twitch ad is playing
 *    10. Quality trust TTL not still valid (cache hit path)
 *   If all checks pass it calls into automation.js to open menus and click.
 *
 * strikeCooldownMs()
 *   Returns how many ms remain before the next automatic enforcement is allowed.
 *   Prevents hammering the DOM on rapid successive triggers.
 */

import { ENFORCEMENT_COOLDOWN_MS, ENFORCEMENT_DEBOUNCE_MS, QUALITY_TRUST_TTL_MS, TIMINGS, missionState, MODE_VALUES, ENFORCEMENT_PLAYER_READY_TIMEOUT_MS } from './constants.js';
import { debug, wait, isUserTypingInInput, createResult, awaitSignal } from './utils.js';
import { isSupportedTwitchPage } from './page-support.js';
import { getPlayerRoot } from './player.js';
import { isAdLive } from './ad-detection.js';
import { loadPluginEnabledSetting, loadModeSettingsForEnforcement, aimQualityForMode } from './storage.js';
import { runQualityMission, lockQualityRun, scanQualityState } from './automation.js';
import { sweepMenus } from './menu-close.js';
import { isBrowserInFullscreen, attemptRestoreTwitchFullscreen } from './fullscreen.js';
import { scanMenuRoots } from './menu-find.js';

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
  // First ever run has no timestamp yet — no cooldown applies.
  if (!missionState.lastStrikeAtMs) {
    return 0;
  }
  // Clamp to 0 so callers never receive a negative value.
  return Math.max(0, ENFORCEMENT_COOLDOWN_MS - (Date.now() - missionState.lastStrikeAtMs));
}

/** Debounces and schedules mode quality enforcement. */
export function queueEnforcementRound(triggerReason, options = {}) {
  const force = options.force === true;
  // Clamp to 0 — negative delays would fire synchronously and skip the event loop.
  const baseDelayMs = Number.isFinite(options.delayMs) ? Math.max(0, Math.floor(options.delayMs)) : ENFORCEMENT_DEBOUNCE_MS;
  const cooldownRemainingMs = strikeCooldownMs();

  // Force triggers use only their own delay; soft triggers also wait out any remaining cooldown.
  const delayMs = force ? baseDelayMs : Math.max(baseDelayMs, cooldownRemainingMs);

  if (!force && cooldownRemainingMs > 0) {
    debug('quality enforcement: cooldown prevents immediate execution; deferring', {
      triggerReason,
      cooldownRemainingMs
    });
  }
  if (missionState.inProgress) {
    // Another run is active — the new timer will follow up once it finishes.
    debug('quality enforcement: lock active while scheduling follow-up run', {
      triggerReason
    });
  }

  // Cancel the previous pending timer so back-to-back triggers collapse into one run.
  if (missionState.scheduledTimerId) {
    clearTimeout(missionState.scheduledTimerId);
    missionState.scheduledTimerId = null;
  }

  missionState.scheduledTimerId = setTimeout(() => {
    missionState.scheduledTimerId = null;
    // Errors inside runEnforcementRound are caught here so they never become
    // unhandled promise rejections that would surface in the browser console.
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

  // --- Guard 1: no concurrent run ---
  // inProgress is set synchronously below; this check prevents two async chains
  // from executing the DOM-touching code at the same time.
  if (missionState.inProgress) {
    debug('quality enforcement: skipped because another run is still in progress', {
      triggerReason
    });
    return createResult(false, 'ENFORCEMENT_LOCKED', 'Quality enforcement skipped because another run is still in progress.');
  }

  // --- Guard 2: cooldown ---
  // Prevents rapid re-triggers (e.g. focus → visibility → storage all fire within
  // seconds) from hammering the Twitch DOM. Force triggers (user action, SPA nav)
  // bypass this so changes take effect immediately.
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

  // --- Guard 3: fullscreen ---
  // Opening the settings menu while the player is in fullscreen causes Twitch to
  // exit fullscreen. We detect that case in setup.js and restore it, but skipping
  // enforcement while already fullscreen avoids the interruption entirely.
  if (isBrowserInFullscreen()) {
    debug('quality enforcement: skipped because document is in fullscreen mode', { triggerReason });
    return createResult(false, 'FULLSCREEN_ACTIVE', 'Quality enforcement skipped while in fullscreen mode.');
  }

  // --- Guard 4: tab visible and focused ---
  // Escape-key and body-click based menu closing is unreliable when the window
  // doesn't have focus. We record force triggers so they can be replayed as force
  // on the next focus event (see setup.js window 'focus' handler).
  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
    debug('quality enforcement: skipped because tab is not visible or window is not focused', { triggerReason });
    // Remember that a force-trigger was blocked so we can replay it as force when
    // focus returns (e.g. popup was open while user changed the resolution setting).
    if (force) {
      missionState.forcePendingAfterFocus = true;
    }
    return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement skipped — tab not visible or window not focused.');
  }

  // --- Guard 5: user not typing ---
  // Opening the settings menu or dispatching Escape while the user types in
  // Twitch chat would interrupt their message. Reschedule so we try again soon.
  if (isUserTypingInInput()) {
    debug('quality enforcement: skipped because user is typing in a text input', { triggerReason });
    queueEnforcementRound('typing-resume', { delayMs: TIMINGS.TYPING_RESUME_DELAY_MS });
    return createResult(false, 'USER_TYPING', 'Quality enforcement skipped — user is typing in a text input.');
  }

  // --- Guard 5.5: user-opened player menu ---
  // If a player menu is visible but we are not running automation (inProgress is still
  // false here, checked in Guard 1), the user opened it themselves. Hold enforcement
  // until the menu closes; setup.js watches for removal and re-queues us automatically.
  const userMenuVisible = scanMenuRoots().some(el => el.offsetParent !== null);
  if (userMenuVisible) {
    missionState.userMenuOpen = true;
    if (force) missionState.userMenuForcePending = true;
    debug('quality enforcement: user has a player menu open — pausing automation', { triggerReason });
    return createResult(false, 'USER_MENU_OPEN', 'Quality enforcement paused — user has a player menu open.');
  }
  missionState.userMenuOpen = false;

  missionState.inProgress = true;
  debug('quality enforcement: run started', {
    triggerReason,
    force,
    url: location.href
  });

  try {
    // --- Guard 6: plugin enabled ---
    // Read from storage rather than caching so a popup toggle takes effect on the
    // very next enforcement run without needing a full re-injection.
    const pluginEnabledResult = await loadPluginEnabledSetting();
    if (!pluginEnabledResult.ok) {
      debug('quality enforcement: plugin-enabled load failed', pluginEnabledResult.details);
      return pluginEnabledResult;
    }

    if (!pluginEnabledResult.details?.pluginEnabled) {
      // Plugin is off — exit cleanly without touching the DOM.
      debug('quality enforcement: skipped because plugin logic is disabled');
      return createResult(true, 'PLUGIN_DISABLED', 'Plugin logic is disabled; skipped mode enforcement.', {
        triggerReason
      });
    }

    // --- Guard 7: supported Twitch page ---
    // Must be a channel or VOD page with a visible player — not /directory, /clips, etc.
    const pageSupport = getPageSupportState();
    debug('quality enforcement: page support evaluated', {
      supported: pageSupport.ok,
      reason: pageSupport.message || pageSupport.details?.reason
    });
    if (!pageSupport.ok) {
      return createResult(false, 'UNSUPPORTED_PAGE', pageSupport.message, pageSupport.details);
    }

    // --- Guard 8: player present in DOM ---
    // The player may still be initializing on a fresh page load. Poll with timeout
    // so we wait up to ENFORCEMENT_PLAYER_READY_TIMEOUT_MS before giving up.
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
    // Plugin may have been disabled between the two storage reads above — handle it.
    if (modeSettingsResult.details?.pluginEnabled === false) {
      debug('quality enforcement: plugin disabled during mode-settings load; skipping enforcement');
      return createResult(true, 'PLUGIN_DISABLED', 'Plugin logic is disabled; skipped mode enforcement.', {
        triggerReason
      });
    }

    debug('quality enforcement: active mode loaded', modeSettingsResult.details);

    const resolvedTarget = aimQualityForMode(modeSettingsResult.details);
    debug('quality enforcement: desired target quality resolved', resolvedTarget);

    // Re-check fullscreen: the user may have entered fullscreen during the async
    // storage reads above. Opening menus in fullscreen would kick them out of it.
    if (isBrowserInFullscreen()) {
      debug('quality enforcement: aborted before DOM manipulation — entered fullscreen during setup', { triggerReason });
      return createResult(false, 'FULLSCREEN_ACTIVE', 'Quality enforcement aborted — entered fullscreen during setup.');
    }

    // Re-check focus: menu interactions (especially the outside-click fallback) are
    // unreliable without focus and can accidentally toggle VOD play/pause.
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      debug('quality enforcement: aborted before DOM manipulation — tab lost focus during setup', { triggerReason });
      if (force) {
        missionState.forcePendingAfterFocus = true;
      }
      return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement aborted — tab lost focus during setup.');
    }

    // --- Guard 9: no ad playing ---
    // Twitch resets quality to Auto/Source mid-stream during ad breaks.
    // Don't try to change it while the ad plays — start a polling interval instead
    // so we apply quality immediately once the ad ends.
    if (isAdLive()) {
      debug('quality enforcement: skipped because a Twitch ad is currently playing', { triggerReason });
      if (!missionState.adScanTimerId) {
        // Only register one interval — duplicate registrations would fire multiple
        // enforcement rounds simultaneously when the ad finally ends.
        missionState.adScanTimerId = setInterval(() => {
          if (isAdLive()) return; // still in the ad, keep waiting
          clearInterval(missionState.adScanTimerId);
          missionState.adScanTimerId = null;
          debug('quality enforcement: ad ended — scheduling post-ad enforcement');
          queueEnforcementRound('ad-ended', { force: true, delayMs: TIMINGS.AD_CLEAR_DELAY_MS });
        }, TIMINGS.AD_SCAN_INTERVAL_MS);
      }
      return createResult(false, 'AD_PLAYING', 'Quality enforcement skipped — Twitch ad is playing.');
    }

    // --- Guard 10: quality trust TTL cache ---
    // If we successfully confirmed this exact quality on this exact URL within the
    // last QUALITY_TRUST_TTL_MS, skip the menu open/detect/close cycle entirely.
    // Force triggers always bypass this so manual changes take effect immediately.
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
      // Still update lastStrikeAtMs so the cooldown is refreshed.
      missionState.lastStrikeAtMs = Date.now();
      return createResult(true, 'QUALITY_TRUSTED', 'Quality recently confirmed; skipping menu detection.', {
        triggerReason, targetQuality: resolvedTarget.targetQuality, trustAgeMs: trustAge
      });
    }

    // First DOM-touching operation: opens the quality submenu, reads selection, closes it.
    const currentQualityResult = await scanQualityState();

    // Re-check fullscreen: scanQualityState opens and closes menus — Twitch can
    // exit fullscreen as a side effect of those DOM interactions.
    if (isBrowserInFullscreen()) {
      debug('quality enforcement: aborted after quality detection — entered fullscreen during detection', { triggerReason });
      return createResult(false, 'FULLSCREEN_ACTIVE', 'Quality enforcement aborted — entered fullscreen during quality detection.');
    }

    // Re-check focus: menus may have been left open and focus lost while they were open.
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
        // Update the trust cache so subsequent soft-trigger runs can skip detection.
        missionState.lockedQuality = resolvedTarget.targetQuality;
        missionState.lastConfirmedQualityAtMs = Date.now();
        // Safety net: scanQualityState opens the quality submenu and closes it,
        // but the close can fail when the tab just became visible (e.g. after sleep/wake or
        // tab switch) because escape key events may not be processed reliably at that point.
        // Ensure the menu is closed before returning so the user never sees a stuck-open menu.
        await sweepMenus({ allowBodyClick: false, aggressiveBodyClicks: true, maxAttempts: 2 });
        return createResult(true, 'QUALITY_ALREADY_MATCHES_MODE', 'Current quality already matches active mode.', {
          triggerReason,
          activeMode: resolvedTarget.activeMode,
          targetQuality: resolvedTarget.targetQuality,
          detectedCurrentQuality
        });
      }
    } else {
      // Detection was inconclusive (ambiguous signals, menu failed to open, etc.).
      // Proceed with enforcement anyway — better to apply a redundant click than
      // to silently leave quality wrong.
      debug('quality enforcement: current quality detection uncertain; proceeding with enforcement', {
        code: currentQualityResult.code,
        message: currentQualityResult.message
      });
    }

    // Run the full click-quality automation. lockQualityRun() serializes this
    // against any concurrent popup-initiated setQuality request.
    const automationResponse = await lockQualityRun('modeEnforce', async () => {
      return runQualityMission(resolvedTarget.targetQuality, pageSupport, 'modeEnforce', {
        triggerReason,
        activeMode: resolvedTarget.activeMode,
        fastToggleLow: resolvedTarget.fastToggleLow,
        fastToggleHigh: resolvedTarget.fastToggleHigh
      });
    });

    // If a concurrent popup request held the lock, retry soon rather than dropping
    // this enforcement round silently.
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
      // Record what we just confirmed so the trust TTL cache is primed.
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
    // Always release the lock and record the timestamp, even if we return early
    // via an error path. This ensures the cooldown timer resets correctly and
    // the next trigger can proceed after the window expires.
    missionState.inProgress = false;
    missionState.lastStrikeAtMs = Date.now();
    missionState.lastRunUrl = location.href;
  }
}
