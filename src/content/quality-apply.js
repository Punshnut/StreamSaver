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

  const waitResult = await awaitSignal(() => {
    const optionsResult = scanQualityOptions();
    if (!optionsResult.ok) {
      return null;
    }

    const matched = optionsResult.details.options.find((option) => {
      return qualityLabelMatchesTarget(option.label, normalizedTarget, matchOptions) && option.selected;
    });

    return matched || null;
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

  const menuState = scanMenuRoots().length;
  if (menuState === 0) {
    return createResult(true, 'QUALITY_CLICKED_UNCONFIRMED', 'Quality option clicked, but menu closed before selection could be verified.');
  }

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
  const openResult = await deployQualityPanel();
  if (!openResult.ok) {
    return createResult(false, openResult.code, openResult.message, { openResult });
  }

  const allowSourceAliasForTargets = inferSourceAliasTargets(
    openResult.details?.qualityEntryLabel,
    openResult.details?.options || []
  );

  let optionsResult = null;
  let matchResult = null;
  let effectiveTargetQuality = normalizedTarget;
  let resolutionAdjustment = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    debug('engageQuality: collecting visible quality options', { attempt });
    const collected = scanQualityOptions();
    if (collected.ok) {
      optionsResult = collected;
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
        break;
      }
    } else if (!optionsResult) {
      optionsResult = collected;
    }

    await wait(120);
  }

  if (!optionsResult || !optionsResult.ok) {
    return createResult(false, optionsResult?.code || 'NO_QUALITY_OPTIONS', optionsResult?.message || 'No quality options found.', {
      openResult,
      optionsResult
    });
  }

  if ((!matchResult || !matchResult.ok) && optionsResult.ok) {
    // Pre-fallback stabilization: give Firefox extra time to render all quality rows
    // before concluding the target is out of range. On Chrome this path is rarely hit,
    // so the added latency is only paid on the slow/incomplete-render path.
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

  if ((!matchResult || !matchResult.ok) && optionsResult.ok) {
    const fallbackTargetResult = snapQualityToRange(normalizedTarget, optionsResult.details.options);
    if (fallbackTargetResult.ok) {
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

      matchResult = aimQualityOption(effectiveTargetQuality, optionsResult.details.options, {
        allowSourceAliasForTargets
      });
    }
  }

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
  if (targetOption.selected) {
    if (resolutionAdjustment?.applied) {
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

  return createResult(true, 'QUALITY_APPLIED', `Applied ${effectiveTargetQuality} successfully.`, {
    requestedQuality: normalizedTarget,
    targetQuality: effectiveTargetQuality,
    appliedQuality: effectiveTargetQuality,
    selectedLabel: targetOption.label,
    verifyResult
  });
}
