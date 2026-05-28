/**
 * content/quality-apply.js
 *
 * Executes the final "click the quality option" step inside an already-open
 * quality submenu and verifies that the selection took effect.
 *
 * engageQuality(targetQuality)
 *   Full attempt pipeline:
 *     1. Opens the quality submenu via deployQualityPanel()
 *     2. Infers which labels are "Source-like" aliases for the stream's native
 *        resolution (e.g. "1080p60 (source)" → counts as both 1080p and Source)
 *     3. Loops up to 5 times collecting options — handles slow-rendering rows
 *        in Firefox where not all options appear on the first paint
 *     4. If strict match fails, calls snapQualityToRange() for a boundary
 *        fallback (nearest available option in the correct direction)
 *     5. Skips the click if the option is already selected
 *     6. Dispatches a stealthClick and then calls confirmQualityLock() to
 *        verify the aria-checked / aria-selected state flipped correctly
 *     7. Returns a rich result with requestedQuality, appliedQuality, and
 *        resolutionAdjustment so the caller can display accurate status text
 *
 * confirmQualityLock(targetQuality, matchOptions)
 *   Polls the open quality submenu for up to 1.2 s waiting for the target
 *   option to show a positive selection signal. If the menu closes before
 *   the check succeeds it still returns ok=true (click was accepted by Twitch
 *   even though confirmation was not possible).
 */

import { debug, createResult, awaitSignal, wait, stealthClick } from './utils.js';
import { parseQualityTag, inferSourceAliasTargets, qualityLabelMatchesTarget } from './quality-matching.js';
import { scanQualityOptions, aimQualityOption, snapQualityToRange, compactSelectionPreview, deployQualityPanel } from './quality-menu.js';
import { scanMenuRoots } from './menu-find.js';

/** Verifies selection state after clicking a quality option. */
export async function confirmQualityLock(targetQuality, matchOptions = {}) {
  const normalizedTarget = parseQualityTag(targetQuality);
  if (!normalizedTarget) {
    return createResult(false, 'INVALID_TARGET_QUALITY', 'Cannot verify unknown target quality.', {
      targetQuality
    });
  }

  // Poll until the target option shows a selected signal, or timeout.
  // The submenu must stay open during this window — Twitch updates aria-checked
  // asynchronously after the click so we can't check synchronously.
  const waitResult = await awaitSignal(() => {
    const optionsResult = scanQualityOptions();
    if (!optionsResult.ok) {
      // Options not readable yet — menu may still be animating.
      return null;
    }

    // Find an option that matches the target AND is marked as selected.
    const matched = optionsResult.details.options.find((option) => {
      return qualityLabelMatchesTarget(option.label, normalizedTarget, matchOptions) && option.selected;
    });

    return matched || null; // null keeps the poll running
  }, {
    timeoutMs: 1200,
    intervalMs: 90,
    description: 'quality selection state'
  });

  if (waitResult.ok) {
    return createResult(true, 'QUALITY_VERIFIED', `Verified ${normalizedTarget} is selected.`, {
      option: waitResult.details.value
    });
  }

  // If the poll timed out, check whether the menu is still open.
  // A closed menu means the click was accepted — Twitch closed it naturally.
  const menuState = scanMenuRoots().length;
  if (menuState === 0) {
    // Menu closed: we can't read selection state, but the click likely succeeded.
    return createResult(true, 'QUALITY_CLICKED_UNCONFIRMED', 'Quality option clicked, but menu closed before selection could be verified.');
  }

  // Menu is still open but no selected signal appeared — click probably didn't register.
  return createResult(false, 'QUALITY_NOT_VERIFIED', `Could not verify ${normalizedTarget} selection.`, {
    waitResult
  });
}

/** Runs a full quality selection attempt in Twitch player menus. */
export async function engageQuality(targetQuality) {
  const normalizedTarget = parseQualityTag(targetQuality);
  if (!normalizedTarget) {
    return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
      targetQuality
    });
  }

  debug('engageQuality: opening quality submenu', { normalizedTarget });

  // Step 1: open settings → click quality row → wait for options to render.
  const openResult = await deployQualityPanel();
  if (!openResult.ok) {
    return createResult(false, openResult.code, openResult.message, { openResult });
  }

  // Step 2: figure out which labels count as "Source-like" aliases for this
  // stream. E.g. "1080p60 (source)" matches both '1080p' and 'Source'.
  // Built from the quality entry label + visible options so it covers both the
  // static label Twitch shows in the settings row and the actual submenu entries.
  const allowSourceAliasForTargets = inferSourceAliasTargets(
    openResult.details?.qualityEntryLabel,
    openResult.details?.options || []
  );

  // Accumulators for the retry loop below.
  let optionsResult = null;
  let matchResult = null;
  let effectiveTargetQuality = normalizedTarget;
  let resolutionAdjustment = null; // set if we fall back to a boundary quality

  // Step 3: collect visible options and find the target.
  // Loop up to 5 times to handle Firefox rendering all rows in batches.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    debug('engageQuality: collecting visible quality options', { attempt });
    const collected = scanQualityOptions();
    if (collected.ok) {
      optionsResult = collected;

      // Re-infer source aliases from the freshly collected options — they may
      // include rows not present in the initial deployQualityPanel snapshot.
      const inferredFromCurrentOptions = inferSourceAliasTargets(
        openResult.details?.qualityEntryLabel,
        collected.details.options
      );
      for (const aliasTarget of inferredFromCurrentOptions) {
        allowSourceAliasForTargets.add(aliasTarget);
      }

      debug('engageQuality: matching target quality', {
        attempt,
        normalizedTarget: effectiveTargetQuality,
        available: collected.details.options.map((option) => option.label),
        allowSourceAliasForTargets: Array.from(allowSourceAliasForTargets)
      });

      matchResult = aimQualityOption(effectiveTargetQuality, collected.details.options, {
        allowSourceAliasForTargets
      });
      if (matchResult.ok) {
        break; // found a matching option — exit the retry loop
      }
    } else if (!optionsResult) {
      // Keep the first failure so we can report it if the loop exhausts.
      optionsResult = collected;
    }

    await wait(120); // brief pause before re-scanning
  }

  // If options never became available, bail now.
  if (!optionsResult || !optionsResult.ok) {
    return createResult(false, optionsResult?.code || 'NO_QUALITY_OPTIONS', optionsResult?.message || 'No quality options found.', {
      openResult,
      optionsResult
    });
  }

  // Step 4a: pre-fallback stabilization.
  // Firefox sometimes renders quality rows incrementally — give it extra time
  // before concluding the target is genuinely out of range. This path is rarely
  // hit on Chrome (options render synchronously there).
  if ((!matchResult || !matchResult.ok) && optionsResult.ok) {
    await wait(600);
    const lateCollected = scanQualityOptions();
    if (lateCollected.ok) {
      optionsResult = lateCollected;
      const lateMatch = aimQualityOption(effectiveTargetQuality, lateCollected.details.options, {
        allowSourceAliasForTargets
      });
      if (lateMatch.ok) {
        matchResult = lateMatch;
      }
    }
  }

  // Step 4b: boundary fallback.
  // If the exact target is still unavailable, snap to the nearest available
  // quality in the correct direction (e.g. stream max 720p → use 720p when
  // user requested 1080p, direction: 'down').
  if ((!matchResult || !matchResult.ok) && optionsResult.ok) {
    const fallbackTargetResult = snapQualityToRange(normalizedTarget, optionsResult.details.options);
    if (fallbackTargetResult.ok) {
      // Record the adjustment so the popup can show "used highest available: 720p"
      resolutionAdjustment = {
        applied: true,
        direction: fallbackTargetResult.details.direction,
        boundary: fallbackTargetResult.details.boundary,
        requestedQuality: normalizedTarget,
        adjustedQuality: fallbackTargetResult.details.resolvedQuality,
        availableQualities: fallbackTargetResult.details.availableQualities
      };
      effectiveTargetQuality = fallbackTargetResult.details.resolvedQuality;

      debug('engageQuality: strict match failed, applying boundary fallback', {
        requestedQuality: normalizedTarget,
        adjustedQuality: effectiveTargetQuality,
        direction: fallbackTargetResult.details.direction,
        availableQualities: fallbackTargetResult.details.availableQualities
      });

      // Try matching again with the adjusted target.
      matchResult = aimQualityOption(effectiveTargetQuality, optionsResult.details.options, {
        allowSourceAliasForTargets
      });
    }
  }

  // If we still have no match, the quality is genuinely unavailable.
  if (!matchResult || !matchResult.ok) {
    return createResult(false, matchResult?.code || 'QUALITY_MATCH_NOT_FOUND', matchResult?.message || `Requested ${normalizedTarget} is not available.`, {
      openResult,
      requestedQuality: normalizedTarget,
      targetQuality: effectiveTargetQuality,
      appliedQuality: effectiveTargetQuality,
      options: optionsResult.details.options.map((option) => option.label),
      allowSourceAliasForTargets: Array.from(allowSourceAliasForTargets),
      resolutionAdjustment,
      matchResult
    });
  }

  const targetOption = matchResult.details.option;

  // Step 5: skip click if already selected.
  // aimQualityOption() prefers already-selected candidates to avoid redundant clicks.
  if (targetOption.selected) {
    if (resolutionAdjustment?.applied) {
      // Already on the fallback quality — report the adjustment for the popup.
      const boundaryLabel = resolutionAdjustment.direction === 'down' ? 'highest available' : 'lowest available';
      return createResult(
        true,
        'QUALITY_ALREADY_SET_WITH_FALLBACK',
        `Requested ${normalizedTarget} is unavailable; ${boundaryLabel} ${effectiveTargetQuality} is already selected.`,
        {
          requestedQuality: normalizedTarget,
          targetQuality: effectiveTargetQuality,
          appliedQuality: effectiveTargetQuality,
          selectedLabel: targetOption.label,
          options: optionsResult.details.options.map((option) => option.label),
          resolutionAdjustment
        }
      );
    }

    return createResult(true, 'QUALITY_ALREADY_SET', `${effectiveTargetQuality} is already selected.`, {
      requestedQuality: normalizedTarget,
      targetQuality: effectiveTargetQuality,
      appliedQuality: effectiveTargetQuality,
      selectedLabel: targetOption.label,
      options: optionsResult.details.options.map((option) => option.label)
    });
  }

  // Step 6: click the option.
  // skipVisibilityCheck:true because the menu hider's clip-path makes the
  // element invisible to getBoundingClientRect while still being fully interactive.
  debug('engageQuality: clicking quality option', {
    targetQuality: effectiveTargetQuality,
    label: targetOption.label
  });
  const clickResult = stealthClick(targetOption.element, { skipVisibilityCheck: true });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, `Failed to click quality option: ${targetOption.label}.`, {
      targetOption,
      clickResult
    });
  }

  // Step 7: verify the selection took effect.
  debug('engageQuality: verifying selection state', { normalizedTarget: effectiveTargetQuality });
  const verifyResult = await confirmQualityLock(effectiveTargetQuality, { allowSourceAliasForTargets });
  if (!verifyResult.ok) {
    return createResult(false, verifyResult.code, verifyResult.message, {
      requestedQuality: normalizedTarget,
      targetQuality: effectiveTargetQuality,
      appliedQuality: effectiveTargetQuality,
      selectedLabel: targetOption.label,
      resolutionAdjustment,
      verifyResult
    });
  }

  // Unconfirmed: click dispatched but menu closed before selection state was readable.
  // Still treat as success — Twitch almost certainly accepted the click.
  if (verifyResult.code === 'QUALITY_CLICKED_UNCONFIRMED') {
    if (resolutionAdjustment?.applied) {
      const boundaryLabel = resolutionAdjustment.direction === 'down' ? 'highest available' : 'lowest available';
      return createResult(
        true,
        'QUALITY_APPLIED_UNCONFIRMED_WITH_FALLBACK',
        `Requested ${normalizedTarget} is unavailable; applied ${boundaryLabel} ${effectiveTargetQuality}, but verification was limited.`,
        {
          requestedQuality: normalizedTarget,
          targetQuality: effectiveTargetQuality,
          appliedQuality: effectiveTargetQuality,
          selectedLabel: targetOption.label,
          resolutionAdjustment,
          verifyResult
        }
      );
    }

    return createResult(true, 'QUALITY_APPLIED_UNCONFIRMED', `Applied ${effectiveTargetQuality}, but verification was limited.`, {
      requestedQuality: normalizedTarget,
      targetQuality: effectiveTargetQuality,
      appliedQuality: effectiveTargetQuality,
      selectedLabel: targetOption.label,
      verifyResult
    });
  }

  // Success with boundary fallback — include the adjustment details for the popup.
  if (resolutionAdjustment?.applied) {
    const boundaryLabel = resolutionAdjustment.direction === 'down' ? 'highest available' : 'lowest available';
    return createResult(true, 'QUALITY_APPLIED_WITH_FALLBACK', `Requested ${normalizedTarget} is unavailable; applied ${boundaryLabel} ${effectiveTargetQuality}.`, {
      requestedQuality: normalizedTarget,
      targetQuality: effectiveTargetQuality,
      appliedQuality: effectiveTargetQuality,
      selectedLabel: targetOption.label,
      resolutionAdjustment,
      verifyResult
    });
  }

  // Clean success — exact quality applied and verified.
  return createResult(true, 'QUALITY_APPLIED', `Applied ${effectiveTargetQuality} successfully.`, {
    requestedQuality: normalizedTarget,
    targetQuality: effectiveTargetQuality,
    appliedQuality: effectiveTargetQuality,
    selectedLabel: targetOption.label,
    verifyResult
  });
}
