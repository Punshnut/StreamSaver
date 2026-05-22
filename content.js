(() => {
  const DEBUG = false;
  const DEBUG_PREFIX = '[StreamSaver][content]';
  const SETTINGS_MENU_DEBUG_MODE = false;
  const QUALITY_VALUES = ['160p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'Source'];
  const QUALITY_SET = new Set(QUALITY_VALUES);
  const QUALITY_ORDER_MAP = QUALITY_VALUES.reduce((acc, quality, index) => {
    acc[quality] = index;
    return acc;
  }, {});
  const QUALITY_ENTRY_TERMS = ['quality', 'qualität', 'video quality', 'resolution', 'auflösung'];
  const SETTINGS_TRIGGER_TERMS = ['settings', 'einstellungen'];
  const SETTINGS_MENU_LABEL_GROUPS = {
    quality: ['qualität', 'quality', 'auflösung', 'resolution'],
    subtitles: ['untertitel', 'subtitles'],
    advanced: ['erweitert', 'advanced']
  };
  const SETTINGS_MENU_CLOSE_TERMS = ['schließen', 'schliessen', 'close'];
  const SETTINGS_MENU_BACK_TERMS = ['zurück', 'zurueck', 'back', 'go back'];
  const SOURCE_TERMS = ['source', 'quelle', 'chunked'];
  const RESOLUTION_PATTERN = /\b(160|360|480|720|1080|1440|2160)\s*p?\d*\b/i;
  const AD_INDICATOR_SELECTORS = [
    '[data-test-selector="ad-banner-default-text"]',
    '[data-test-selector="ad-banner"]',
    '[data-a-target="ad-countdown"]',
    '.video-ad-label',
    // Mid-stream ad break: Twitch shows the real stream as a PiP mini-player.
    // These elements only exist during commercial breaks.
    '[data-a-target="picture-by-picture-player"]',
    '[class*="picture-by-picture"]',
  ];
  const MODE_VALUES = {
    LOW: 'low',
    HIGH: 'high'
  };
  const MODE_SET = new Set(Object.values(MODE_VALUES));
  const STORAGE_KEYS = {
    FAST_TOGGLE_LOW: 'fastToggleLow',
    FAST_TOGGLE_HIGH: 'fastToggleHigh',
    ACTIVE_MODE: 'activeMode',
    PLUGIN_ENABLED: 'pluginEnabled'
  };
  const DEFAULT_MODE_SETTINGS = {
    [STORAGE_KEYS.FAST_TOGGLE_LOW]: '480p',
    [STORAGE_KEYS.FAST_TOGGLE_HIGH]: 'Source',
    [STORAGE_KEYS.ACTIVE_MODE]: MODE_VALUES.HIGH,
    [STORAGE_KEYS.PLUGIN_ENABLED]: true
  };
  const ENFORCEMENT_COOLDOWN_MS = 6000;
  const ENFORCEMENT_DEBOUNCE_MS = 600;
  const ENFORCEMENT_PLAYER_READY_TIMEOUT_MS = 6000;
  const QUALITY_TRUST_TTL_MS = 25_000; // skip detect+set when quality was recently confirmed
  let activeSetQualityRun = null;
  const enforcementState = {
    inProgress: false,
    scheduledTimerId: null,
    lastRunAtMs: 0,
    lastRunUrl: '',
    lastResolvedTargetQuality: '',
    lastConfirmedQualityAtMs: 0, // when quality was last successfully confirmed (detect or set)
    urlWatchTimerId: null
  };
  const fullscreenState = {
    userIntended: false,       // user explicitly entered fullscreen
    restorationAttempts: 0,
    restorationInProgress: false
  };

  // Guard: run only on twitch.tv hosts.
  if (!location.hostname.endsWith('twitch.tv')) {
    return;
  }

  /** Lightweight debug logger that can be disabled from one flag. */
  function debug(message, details) {
    if (!DEBUG) return;
    if (details !== undefined) {
      console.log(`${DEBUG_PREFIX} ${message}`, details);
      return;
    }
    console.log(`${DEBUG_PREFIX} ${message}`);
  }

  /** Standard result envelope for internal automation steps. */
  function createResult(ok, code, message, details = null) {
    return { ok, code, message, details };
  }

  /** Serializes values into message-safe JSON data. */
  function serializeForMessage(value, depth = 0, seen = new WeakSet()) {
    if (depth > 8) {
      return '[MaxDepth]';
    }
    if (value === null || value === undefined) {
      return value;
    }

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
      return value;
    }
    if (valueType === 'function') {
      return '[Function]';
    }

    if (value instanceof Element) {
      const tagName = value.tagName ? value.tagName.toLowerCase() : 'element';
      return `[DOM:${tagName}]`;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message
      };
    }
    if (Array.isArray(value)) {
      return value.map((item) => serializeForMessage(item, depth + 1, seen));
    }

    if (valueType === 'object') {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);

      const output = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        output[key] = serializeForMessage(nestedValue, depth + 1, seen);
      }
      return output;
    }

    return String(value);
  }

  /** Promise-based sleep helper for retry loops. */
  function wait(ms) {
    const delay = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** Returns a small random offset in [-px, +px] to de-mechanize synthetic coordinates. */
  function jitter(px = 8) {
    return (Math.random() - 0.5) * px * 2;
  }

  /** Visibility guard used before reading/clicking Twitch UI elements. */
  function isElementVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // Firefox: filter:opacity() applied to self or an ancestor can cause getBoundingClientRect
    // to return a 0×0 rect even for layout-present elements. Fall back to offsetWidth/Height
    // which are unaffected by CSS filter and reflect actual layout dimensions.
    return element.offsetWidth > 0 && element.offsetHeight > 0;
  }

  /** Lighter visibility check for entries already inside a validated menu root.
   *  Uses offsetWidth/offsetHeight instead of getBoundingClientRect to avoid
   *  false-negatives in Firefox when a parent has filter:opacity(0) applied
   *  (the menu hider), which can cause child rects to be misreported as 0×0. */
  function isMenuEntryUsable(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    return element.offsetWidth > 0 && element.offsetHeight > 0;
  }

  /** Returns readable text with ARIA/title fallbacks for menu matching. */
  function getVisibleText(element) {
    if (!(element instanceof Element) || !isElementVisible(element)) {
      return '';
    }

    const ariaLabel = element.getAttribute('aria-label');
    const title = element.getAttribute('title');
    const rawText = ariaLabel || element.innerText || title || element.textContent || '';

    return rawText.replace(/\s+/g, ' ').trim();
  }

  /** Like getVisibleText but skips the isElementVisible gate.
   *  For entries already vetted by isMenuEntryUsable() — they are layout-present
   *  but may appear invisible to getBoundingClientRect due to the menu hider CSS. */
  function getMenuEntryText(element) {
    if (!(element instanceof Element)) return '';
    const ariaLabel = element.getAttribute('aria-label');
    const title = element.getAttribute('title');
    return (ariaLabel || element.innerText || title || element.textContent || '')
      .replace(/\s+/g, ' ').trim();
  }

  /** Performs a defensive click with pre-checks and safe focus/scroll attempts. */
  function clickElementSafely(element, options = {}) {
    if (!(element instanceof HTMLElement)) {
      return createResult(false, 'INVALID_ELEMENT', 'Click target is not an HTML element.');
    }
    if (!options.skipVisibilityCheck && !isElementVisible(element)) {
      return createResult(false, 'ELEMENT_HIDDEN', 'Click target is not visible.');
    }
    if (element.matches('[disabled], [aria-disabled="true"]')) {
      return createResult(false, 'ELEMENT_DISABLED', 'Click target is disabled.');
    }

    if (options.prepare !== false) {
      try {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (error) {
        debug('scrollIntoView failed but continuing', String(error));
      }

      try {
        element.focus({ preventScroll: true });
      } catch (error) {
        debug('focus failed but continuing', String(error));
      }
    }

    if (element.tagName === 'A' && element.hasAttribute('href')) {
      return createResult(false, 'NAVIGATION_LINK', 'Refusing to click anchor with href — would cause page navigation.');
    }

    try {
      element.click();
      return createResult(true, 'CLICKED', 'Element clicked successfully.');
    } catch (error) {
      return createResult(false, 'CLICK_FAILED', 'Element click threw an error.', {
        error: String(error)
      });
    }
  }

  /** Waits until a condition succeeds or times out. */
  async function waitForCondition(fn, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 100;
    const description = typeof options.description === 'string' ? options.description : 'condition';

    const startedAt = Date.now();
    let attempts = 0;
    let lastError = null;

    while (Date.now() - startedAt < timeoutMs) {
      attempts += 1;

      try {
        const value = await fn();
        if (value) {
          return createResult(true, 'CONDITION_MET', `${description} satisfied.`, {
            value,
            attempts,
            elapsedMs: Date.now() - startedAt
          });
        }
      } catch (error) {
        lastError = String(error);
      }

      await wait(intervalMs);
    }

    return createResult(false, 'TIMEOUT', `Timed out waiting for ${description}.`, {
      attempts,
      elapsedMs: Date.now() - startedAt,
      lastError
    });
  }

  /** Normalizes Twitch quality labels into extension-level quality keys. */
  function normalizeQualityLabel(label) {
    const raw = String(label || '').replace(/\s+/g, ' ').trim();
    if (!raw) {
      return '';
    }

    const lower = raw.toLowerCase();
    if (SOURCE_TERMS.some((term) => lower.includes(term))) return 'Source';
    if (hasResolutionValue(lower, '2160')) return '2160p';
    if (hasResolutionValue(lower, '1440')) return '1440p';
    if (hasResolutionValue(lower, '1080')) return '1080p';
    if (hasResolutionValue(lower, '720')) return '720p';
    if (hasResolutionValue(lower, '480')) return '480p';
    if (hasResolutionValue(lower, '360')) return '360p';
    if (hasResolutionValue(lower, '160')) return '160p';
    return '';
  }

  /** Matches one numeric resolution token while avoiding partial number collisions. */
  function hasResolutionValue(text, value) {
    const lower = String(text || '').toLowerCase();
    const pattern = new RegExp(`(^|[^0-9])${value}(?:\\s*p\\d*)?(?=$|[^0-9])`, 'i');
    return pattern.test(lower);
  }

  /** Extracts a normalized resolution key from option text. */
  function extractResolutionQuality(label) {
    const lower = String(label || '').toLowerCase();
    if (!lower) {
      return '';
    }
    if (hasResolutionValue(lower, '2160')) return '2160p';
    if (hasResolutionValue(lower, '1440')) return '1440p';
    if (hasResolutionValue(lower, '1080')) return '1080p';
    if (hasResolutionValue(lower, '720')) return '720p';
    if (hasResolutionValue(lower, '480')) return '480p';
    if (hasResolutionValue(lower, '360')) return '360p';
    if (hasResolutionValue(lower, '160')) return '160p';
    return '';
  }

  /** Detects whether a label uses any source-level alias terms. */
  function labelHasSourceAlias(label) {
    const lower = String(label || '').toLowerCase();
    return SOURCE_TERMS.some((term) => lower.includes(term));
  }

  /** Infers which concrete resolutions are represented by source-like menu labels. */
  function inferSourceAliasTargets(qualityEntryLabel, options = []) {
    const inferred = new Set();
    // Add source-like labels only when they include a concrete resolution.
    const maybeAdd = (label) => {
      if (!labelHasSourceAlias(label)) {
        return;
      }
      const resolution = extractResolutionQuality(label);
      if (resolution && QUALITY_SET.has(resolution)) {
        inferred.add(resolution);
      }
    };

    maybeAdd(qualityEntryLabel);
    for (const option of Array.isArray(options) ? options : []) {
      if (option && typeof option.label === 'string') {
        maybeAdd(option.label);
      }
    }

    return inferred;
  }

  /** Checks whether a settings row looks like quality. */
  function analyzeQualityEntryText(label) {
    const text = String(label || '').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const matchedBy = [];

    if (QUALITY_ENTRY_TERMS.some((term) => lower.includes(term))) {
      matchedBy.push('qualityLabel');
    }
    if (RESOLUTION_PATTERN.test(lower)) {
      matchedBy.push('resolutionValue');
    }
    if (SOURCE_TERMS.some((term) => lower.includes(term))) {
      matchedBy.push('sourceLabel');
    }

    // Prefer explicit quality terms, but allow resolution+source hints.
    const isQualityEntry =
      matchedBy.includes('qualityLabel') ||
      (matchedBy.includes('resolutionValue') && matchedBy.includes('sourceLabel'));

    return { isQualityEntry, matchedBy };
  }

  /** Matches a requested quality against option text. */
  function qualityLabelMatchesTarget(label, normalizedTarget, options = {}) {
    const lower = String(label || '').toLowerCase();
    if (!lower || !QUALITY_SET.has(normalizedTarget)) {
      return false;
    }

    if (normalizedTarget === 'Source') {
      // Source can appear as Source, Quelle, or Chunked.
      return labelHasSourceAlias(lower);
    }

    const resolution = extractResolutionQuality(lower);
    if (resolution === normalizedTarget) {
      return true;
    }

    const allowSourceAliasForTargets = options?.allowSourceAliasForTargets;
    const canUseSourceAlias =
      allowSourceAliasForTargets instanceof Set && allowSourceAliasForTargets.has(normalizedTarget);

    if (canUseSourceAlias && labelHasSourceAlias(lower)) {
      return true;
    }

    return false;
  }

  /** Finds the best visible root for the Twitch player. */
  function getPlayerRoot() {
    const selectors = [
      '[data-a-target="video-player"]',
      '[role="application"][aria-label*="player" i]',
      '[role="region"][aria-label*="player" i]',
      '[role="region"][aria-label*="video" i]',
      'video'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const candidate of candidates) {
        const root = selector === 'video' ? candidate.closest('section, div, main, article') || candidate : candidate;
        if (isElementVisible(root)) {
          return createResult(true, 'PLAYER_FOUND', 'Found likely Twitch player root.', {
            selector,
            element: root
          });
        }
      }
    }

    return createResult(false, 'PLAYER_NOT_FOUND', 'No visible Twitch player root was found.');
  }

  // Ref-count for the menu hider. showMenuHider increments, hideMenuHider decrements.
  // The style is only removed when the count reaches zero AND menus are confirmed closed,
  // so back-to-back automation calls (detect → set) share one continuous hider lifetime.
  let _menuHiderCount = 0;

  /** Injects a CSS rule that makes Twitch player menus visually invisible while the
   *  extension interacts with them.
   *  - clip-path:inset(100%) — clips painted area to zero (invisible, non-hittable) while
   *                            preserving the full CSS layout box. getBoundingClientRect()
   *                            and offsetWidth/offsetHeight return real values, so all
   *                            JS-driven visibility and geometry checks still work correctly
   *                            in every browser including Firefox.
   *  - pointer-events:none  — belt-and-suspenders: lets document.elementFromPoint() see
   *                            through to the player below, required for closeMenusIfNeeded's
   *                            player-area click fallback to find a valid click target. */
  function showMenuHider() {
    _menuHiderCount++;
    debug('menuHider: show', { count: _menuHiderCount, t: Date.now() });
    if (document.getElementById('streamsaver-menu-hider')) return;
    const style = document.createElement('style');
    style.id = 'streamsaver-menu-hider';
    style.textContent =
      '[role="menu"],[role="listbox"],' +
      '[data-a-target*="settings-menu" i],' +
      '[data-a-target*="dropdown-menu" i],[data-test-selector*="menu" i],' +
      '[class*="settings-menu" i]{clip-path:inset(100%)!important;pointer-events:none!important;}';
    document.head.appendChild(style);
  }

  /** Decrements the hider ref-count and, once it reaches zero, polls until menus are
   *  confirmed gone before removing the style. This ensures a lingering or stuck menu is
   *  never revealed to the user when the hider lifts. Hard timeout: 800 ms. */
  async function hideMenuHider() {
    _menuHiderCount = Math.max(0, _menuHiderCount - 1);
    if (_menuHiderCount > 0) return;
    // If menus are still open, make one extra close attempt. pointer-events:none is still
    // active here, so document.elementFromPoint() sees through the invisible menu to the
    // player — this is the path that was failing at channel-join time.
    if (findVisibleMenuRoots().length > 0) {
      await closeMenusIfNeeded({ allowBodyClick: true, aggressiveBodyClicks: true, maxAttempts: 2 });
    }
    // Poll briefly to confirm menus are gone before lifting the hider.
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      if (_menuHiderCount > 0) return;
      if (findVisibleMenuRoots().length === 0) break;
      await wait(60);
    }
    if (_menuHiderCount > 0) return;
    debug('menuHider: hide (lock lifted)', { t: Date.now() });
    document.getElementById('streamsaver-menu-hider')?.remove();
  }

  /** Collects visible menu-like overlay roots. */
  function findVisibleMenuRoots() {
    const selectors = [
      '[role="menu"]',
      '[role="listbox"]',
      '[role="dialog"]',
      '[aria-label*="settings" i][role="dialog"]',
      '[data-a-target*="player-settings" i]',
      '[data-a-target*="settings-menu" i]',
      '[data-a-target*="dropdown-menu" i]',
      '[data-test-selector*="menu" i]',
      '[class*="settings-menu" i]'
    ];

    const seen = new Set();
    const roots = [];

    for (const selector of selectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (!isElementVisible(element)) {
          continue;
        }
        if (seen.has(element)) {
          continue;
        }
        seen.add(element);
        roots.push(element);
      }
    }

    return roots;
  }

  /** Fallback finder for settings-like containers by visible text. */
  function findSettingsMenuRootsByText() {
    const selector = 'div, section, [role="dialog"], [data-a-target], [class*="menu" i]';
    const raw = [];

    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!isMenuEntryUsable(element)) {
        continue;
      }

      const ow = element.offsetWidth;
      const oh = element.offsetHeight;
      if (ow < 180 || oh < 120) {
        continue;
      }
      if (ow > window.innerWidth * 0.96 || oh > window.innerHeight * 0.96) {
        continue;
      }

      const lower = String(element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!lower) {
        continue;
      }

      const hasQuality = SETTINGS_MENU_LABEL_GROUPS.quality.some((term) => lower.includes(term));
      const hasSubtitles = SETTINGS_MENU_LABEL_GROUPS.subtitles.some((term) => lower.includes(term));
      const hasAdvanced = SETTINGS_MENU_LABEL_GROUPS.advanced.some((term) => lower.includes(term));
      const hasClose = SETTINGS_MENU_CLOSE_TERMS.some((term) => lower.includes(term));
      const matchedGroupCount = Number(hasQuality) + Number(hasSubtitles) + Number(hasAdvanced);

      if (!(matchedGroupCount >= 2 || (hasQuality && hasClose))) {
        continue;
      }

      raw.push(element);
    }

    // Keep smallest matching containers to avoid huge wrapper nodes.
    // Use offsetWidth/offsetHeight instead of getBoundingClientRect so this works
    // even when filter:opacity(0) from the menu hider causes BCR to return 0×0.
    raw.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));

    const kept = [];
    for (const element of raw) {
      if (kept.some((existing) => element.contains(existing))) {
        continue;
      }
      kept.push(element);
      if (kept.length >= 3) {
        break;
      }
    }

    return kept;
  }

  /** Fallback probe: player-near panel with visible quality text. */
  function findPlayerNearQualityPanel(playerRoot) {
    if (!(playerRoot instanceof Element) || !isElementVisible(playerRoot)) {
      return null;
    }

    const roots = findVisibleMenuRoots();
    const seen = new Set(roots);
    for (const root of findSettingsMenuRootsByText()) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }

    const playerRect = playerRoot.getBoundingClientRect();
    for (const root of roots) {
      if (!isMenuEntryUsable(root)) {
        continue;
      }
      const rect = root.getBoundingClientRect();
      // Firefox: filter:opacity(0) causes getBoundingClientRect to return 0×0 for menu roots.
      // When that happens, skip the proximity check and rely on text content alone.
      if (rect.width > 0 && rect.height > 0 && !isRectNear(playerRect, rect, 120)) {
        continue;
      }

      const text = String(root.innerText || root.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!text) {
        continue;
      }

      const hasQuality = SETTINGS_MENU_LABEL_GROUPS.quality.some((term) => text.includes(term));
      if (!hasQuality) {
        continue;
      }

      return {
        rect: serializeRect(rect),
        hasQuality,
        hasClose: SETTINGS_MENU_CLOSE_TERMS.some((term) => text.includes(term)),
        textPreview: text.slice(0, 220)
      };
    }

    return null;
  }

  /** Shows player controls by dispatching hover events. */
  function triggerPlayerHover(playerRoot) {
    if (!(playerRoot instanceof Element)) {
      return;
    }

    const rect = playerRoot.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const hoverPoints = [
      { x: rect.left + rect.width * 0.5 + jitter(), y: rect.top + rect.height * 0.5 + jitter() },
      { x: rect.left + rect.width * 0.85 + jitter(), y: rect.top + rect.height * 0.9 + jitter() }
    ];

    for (const point of hoverPoints) {
      playerRoot.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: point.x, clientY: point.y }));
      playerRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: point.x, clientY: point.y }));
      playerRoot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: point.x, clientY: point.y }));
    }
  }

  /** Serializes DOMRect values into compact integer coordinates for debug payloads. */
  function serializeRect(rect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  /** Checks whether `innerRect` is inside `outerRect`. */
  function isRectInside(outerRect, innerRect, tolerance = 0) {
    return (
      innerRect.left >= outerRect.left - tolerance &&
      innerRect.right <= outerRect.right + tolerance &&
      innerRect.top >= outerRect.top - tolerance &&
      innerRect.bottom <= outerRect.bottom + tolerance
    );
  }

  /** Checks whether two rectangles overlap or are nearby. */
  function isRectNear(rectA, rectB, threshold = 40) {
    return !(
      rectA.right < rectB.left - threshold ||
      rectA.left > rectB.right + threshold ||
      rectA.bottom < rectB.top - threshold ||
      rectA.top > rectB.bottom + threshold
    );
  }

  /** Finds visible player control containers inside the active player root. */
  function findPlayerControlScopes(playerRoot) {
    if (!(playerRoot instanceof Element)) {
      return [];
    }

    const selectors = [
      '[data-a-target*="player-controls" i]',
      '[data-a-target*="player-control" i]',
      '[data-a-target*="player-overlay" i]',
      '[aria-label*="player controls" i]',
      '[class*="player-controls" i]',
      '[role="toolbar"]'
    ];
    const seen = new Set();
    const scopes = [];

    for (const selector of selectors) {
      for (const element of Array.from(playerRoot.querySelectorAll(selector))) {
        if (!isElementVisible(element) || seen.has(element)) {
          continue;
        }
        seen.add(element);
        scopes.push({
          selector,
          element,
          rect: serializeRect(element.getBoundingClientRect())
        });
      }
    }

    return scopes;
  }

  /** Finds settings-button candidates only inside the player controls region. */
  function collectSettingsButtonCandidates(playerRoot, controlScopes) {
    if (!(playerRoot instanceof Element)) {
      return [];
    }
    if (controlScopes.length === 0) {
      return [];
    }

    const playerRect = playerRoot.getBoundingClientRect();
    const scopeElements = controlScopes.map((scope) => scope.element);
    const triggerSelectors = [
      '[aria-label]',
      '[title]',
      '[data-a-target]',
      'button',
      '[role="button"]'
    ];
    const seen = new Set();
    const candidates = [];

    for (const selector of triggerSelectors) {
      for (const scopeElement of scopeElements) {
        for (const node of Array.from(scopeElement.querySelectorAll(selector))) {
          if (!(node instanceof HTMLElement) || !isElementVisible(node) || seen.has(node)) {
            continue;
          }
          seen.add(node);
          if (!playerRoot.contains(node)) {
            continue;
          }
          if (node.matches('a, [role="link"]')) {
            continue;
          }
          if (!node.matches('button, [role="button"], [data-a-target]')) {
            continue;
          }

          const rect = node.getBoundingClientRect();
          if (!isRectInside(playerRect, rect, 8)) {
            continue;
          }

          const text = getVisibleText(node);
          const ariaLabel = String(node.getAttribute('aria-label') || '');
          const title = String(node.getAttribute('title') || '');
          const dataTarget = String(node.getAttribute('data-a-target') || '');
          const textLower = text.toLowerCase();
          const ariaLower = ariaLabel.toLowerCase();
          const titleLower = title.toLowerCase();
          const dataTargetLower = dataTarget.toLowerCase();
          const matchedBy = [];

          if (SETTINGS_TRIGGER_TERMS.some((term) => textLower.includes(term))) matchedBy.push('visibleText');
          if (SETTINGS_TRIGGER_TERMS.some((term) => ariaLower.includes(term))) matchedBy.push('ariaLabel');
          if (SETTINGS_TRIGGER_TERMS.some((term) => titleLower.includes(term))) matchedBy.push('title');
          if (SETTINGS_TRIGGER_TERMS.some((term) => dataTargetLower.includes(term))) matchedBy.push('dataATarget');

          if (matchedBy.length === 0) {
            continue;
          }

          const inControlScope = controlScopes.some((scope) => scope.element.contains(node));
          if (!inControlScope) {
            continue;
          }

          const score = matchedBy.length + 2 + (dataTargetLower.includes('player') ? 1 : 0);
          candidates.push({
            element: node,
            selector,
            text,
            ariaLabel,
            title,
            dataTarget,
            matchedBy,
            inControlScope,
            score,
            rect: serializeRect(rect)
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || b.rect.x - a.rect.x);
    return candidates;
  }

  /** Collects visible menu labels with dedupe and fallback parsing. */
  function getVisibleMenuEntryTexts(menuRoot) {
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
  function isLikelyPlayerSettingsMenu(menuRoot, playerRoot) {
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
  function findOpenPlayerSettingsMenu(playerRoot, options = {}) {
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
  async function openSettingsMenu() {
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

  /** Finds the quality/resolution entry inside the currently open settings menu. */
  function findQualityMenuEntry() {
    const menuRoots = findVisibleMenuRoots();
    const seenRoots = new Set(menuRoots);
    for (const root of findSettingsMenuRootsByText()) {
      if (!seenRoots.has(root)) {
        seenRoots.add(root);
        menuRoots.push(root);
      }
    }

    if (menuRoots.length === 0) {
      return createResult(false, 'MENU_NOT_VISIBLE', 'No visible menu to search for quality entry.');
    }

    const selector = 'button, [role="menuitem"], [role="option"], [role="button"], a, [data-a-target], div, span';
    const qualityLabels = ['quality', 'qualität', 'video quality', 'resolution', 'auflösung'];
    const candidates = [];

    for (const menuRoot of menuRoots) {
      const entries = Array.from(menuRoot.querySelectorAll(selector)).filter((entry) => isMenuEntryUsable(entry));
      for (const entry of entries) {
        const entryText = getMenuEntryText(entry) || String(entry.textContent || '').replace(/\s+/g, ' ').trim();
        if (!entryText) {
          continue;
        }
        const analysis = analyzeQualityEntryText(entryText);

        const text = entryText.toLowerCase();
        const labelMatch = qualityLabels.some((label) => text.includes(label));
        if (!labelMatch && !analysis.isQualityEntry) {
          continue;
        }

        const score =
          (labelMatch ? 4 : 0) +
          (analysis.matchedBy.includes('qualityLabel') ? 3 : 0) +
          (entry.matches('button, [role="button"], [role="menuitem"]') ? 2 : 0) +
          (text.includes('qualität') || text.includes('quality') ? 2 : 0) +
          (text.includes('resolution') || text.includes('auflösung') ? 1 : 0);

        candidates.push({
          element: entry,
          label: entryText,
          score,
          matchedVariant: labelMatch ? 'localizedLabel' : analysis.matchedBy.join('+'),
          rect: serializeRect(entry.getBoundingClientRect())
        });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
      debug('findQualityMenuEntry: quality candidates', candidates.slice(0, 8).map((candidate) => ({
        label: candidate.label,
        score: candidate.score,
        matchedVariant: candidate.matchedVariant,
        rect: candidate.rect
      })));
      const best = candidates[0];
      debug('findQualityMenuEntry: matched quality entry', {
        text: best.label,
        matchedVariant: best.matchedVariant,
        score: best.score
      });
      return createResult(true, 'QUALITY_ENTRY_FOUND', 'Found quality menu entry.', {
        element: best.element,
        label: best.label,
        matchedVariant: best.matchedVariant
      });
    }

    return createResult(false, 'QUALITY_ENTRY_NOT_FOUND', 'Quality entry was not found in visible menus.');
  }

  /** Allows continuing when settings state is recoverable. */
  function canProceedAfterSettingsResult(settingsResult) {
    if (settingsResult?.ok) {
      return true;
    }

    const recoverableCodes = new Set([
      'SETTINGS_MENU_ALREADY_OPEN_AMBIGUOUS',
      'SETTINGS_MENU_NOT_EXACTLY_ONE',
      'MULTIPLE_MENUS_OPEN'
    ]);
    if (recoverableCodes.has(settingsResult?.code)) {
      return true;
    }

    const acceptedCount =
      settingsResult?.details?.menuState?.acceptedCount ??
      settingsResult?.details?.acceptedCount ??
      0;
    return Number(acceptedCount) > 0;
  }

  /** Opens the quality submenu and waits for options. */
  async function openQualitySubmenu() {
    debug('openQualitySubmenu: opening settings first');

    const settingsResult = await openSettingsMenu();
    if (!canProceedAfterSettingsResult(settingsResult)) {
      return createResult(false, settingsResult.code, settingsResult.message, settingsResult.details);
    }
    if (!settingsResult.ok) {
      debug('openQualitySubmenu: proceeding with already-open/ambiguous settings state', settingsResult);
    }

    let qualityEntryResult = findQualityMenuEntry();
    if (!qualityEntryResult.ok) {
      const waitQualityResult = await waitForCondition(() => {
        const maybeEntry = findQualityMenuEntry();
        return maybeEntry.ok ? maybeEntry : null;
      }, {
        timeoutMs: 1200,
        intervalMs: 80,
        description: 'quality menu entry'
      });

      if (!waitQualityResult.ok) {
        return createResult(false, 'QUALITY_ENTRY_NOT_FOUND', 'Could not find quality entry after opening settings.', {
          settingsResult,
          waitQualityResult
        });
      }

      qualityEntryResult = waitQualityResult.details.value;
    }

    debug('openQualitySubmenu: clicking quality entry', qualityEntryResult.details.label);
    const clickResult = clickElementSafely(qualityEntryResult.details.element, { prepare: false });
    if (!clickResult.ok) {
      return createResult(false, clickResult.code, 'Failed to click quality entry.', clickResult.details);
    }

    const optionsWaitResult = await waitForCondition(() => {
      const optionsResult = collectVisibleQualityOptions();
      return optionsResult.ok ? optionsResult : null;
    }, {
      timeoutMs: 1400,
      intervalMs: 90,
      description: 'visible quality options'
    });

    if (!optionsWaitResult.ok) {
      return createResult(false, 'QUALITY_OPTIONS_NOT_FOUND', 'Quality submenu did not render visible options in time.', {
        qualityEntryLabel: qualityEntryResult.details.label,
        optionsWaitResult
      });
    }

    // Small stability window: Firefox renders quality rows slower than Chrome.
    // Waiting briefly after the first options appear gives remaining rows time to render
    // before the caller begins matching, reducing reliance on the pre-fallback retry.
    await wait(150);

    const optionsResult = optionsWaitResult.details.value;
    debug('openQualitySubmenu: quality options visible', { count: optionsResult.details.options.length });

    return createResult(true, 'QUALITY_SUBMENU_OPEN', 'Quality submenu opened successfully.', {
      qualityEntryLabel: qualityEntryResult.details.label,
      options: optionsResult.details.options
    });
  }

  /** Keeps option diagnostics compact before shipping them through extension messaging. */
  function compactSelectionPreview(option) {
    return {
      label: option.label,
      normalized: option.normalized,
      selected: option.selected,
      selectedConfidence: option.selectedConfidence,
      selectedScore: option.selectedScore,
      selectionSignals: option.selectionSignals,
      deselectionSignals: option.deselectionSignals
    };
  }

  /** Maps raw quality options to compact diagnostic previews. */
  function toSelectionPreviews(options) {
    return Array.isArray(options) ? options.map((option) => compactSelectionPreview(option)) : [];
  }

  /** Creates a consistent unknown-quality result payload. */
  function createUnknownCurrentQualityResult(message, reason, options, extraDetails = {}) {
    return createResult(false, 'CURRENT_QUALITY_UNKNOWN', message, {
      quality: 'unknown',
      reason,
      options: toSelectionPreviews(options),
      ...extraDetails
    });
  }

  /** Returns the configured order index for one normalized quality value. */
  function getQualityOrder(quality) {
    if (!QUALITY_SET.has(quality)) {
      return -1;
    }
    return QUALITY_ORDER_MAP[quality];
  }

  /** Extracts numeric quality value from normalized key (e.g. "1080p" -> 1080). */
  function parseNumericQualityValue(quality) {
    if (!QUALITY_SET.has(quality) || quality === 'Source') {
      return null;
    }
    const numeric = Number.parseInt(String(quality), 10);
    return Number.isFinite(numeric) ? numeric : null;
  }

  /** Deduplicates and sorts visible quality levels from low to high. */
  function collectSortedAvailableQualityLevels(options) {
    const available = new Set();
    for (const option of Array.isArray(options) ? options : []) {
      const normalized = normalizeQualityLabel(option?.normalized || option?.label || '');
      if (QUALITY_SET.has(normalized)) {
        available.add(normalized);
      }

      // Source-like labels can still contain a concrete resolution (e.g. 1080p60).
      const extracted = extractResolutionQuality(option?.label || '');
      if (QUALITY_SET.has(extracted)) {
        available.add(extracted);
      }
    }

    return Array.from(available).sort((a, b) => getQualityOrder(a) - getQualityOrder(b));
  }

  /** Resolves boundary fallback when requested quality is outside available range. */
  function resolveOutOfRangeQualityTarget(targetQuality, options) {
    const normalizedTarget = normalizeQualityLabel(targetQuality);
    if (!normalizedTarget) {
      return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
        targetQuality
      });
    }

    const availableQualities = collectSortedAvailableQualityLevels(options);
    if (availableQualities.length === 0) {
      return createResult(false, 'NO_QUALITY_OPTIONS', 'No quality options are available for fallback resolution.', {
        requestedQuality: normalizedTarget
      });
    }

    const numericAvailableQualities = availableQualities
      .map((quality) => ({ quality, value: parseNumericQualityValue(quality) }))
      .filter((entry) => Number.isFinite(entry.value))
      .sort((a, b) => a.value - b.value);
    const targetNumeric = parseNumericQualityValue(normalizedTarget);

    if (Number.isFinite(targetNumeric) && numericAvailableQualities.length > 0) {
      const lowestNumeric = numericAvailableQualities[0];
      const highestNumeric = numericAvailableQualities[numericAvailableQualities.length - 1];

      if (targetNumeric > highestNumeric.value) {
        return createResult(true, 'QUALITY_FALLBACK_TO_HIGHEST', 'Requested quality is above available range.', {
          requestedQuality: normalizedTarget,
          resolvedQuality: highestNumeric.quality,
          direction: 'down',
          boundary: 'highest',
          availableQualities
        });
      }

      if (targetNumeric < lowestNumeric.value) {
        return createResult(true, 'QUALITY_FALLBACK_TO_LOWEST', 'Requested quality is below available range.', {
          requestedQuality: normalizedTarget,
          resolvedQuality: lowestNumeric.quality,
          direction: 'up',
          boundary: 'lowest',
          availableQualities
        });
      }
    } else if (Number.isFinite(targetNumeric) && availableQualities.includes('Source')) {
      // Fallback when only source-like entries are available.
      return createResult(true, 'QUALITY_FALLBACK_TO_HIGHEST', 'Requested quality is above available range.', {
        requestedQuality: normalizedTarget,
        resolvedQuality: 'Source',
        direction: 'down',
        boundary: 'highest',
        availableQualities
      });
    }

    if (normalizedTarget === 'Source' && !availableQualities.includes('Source') && numericAvailableQualities.length > 0) {
      const highestNumeric = numericAvailableQualities[numericAvailableQualities.length - 1];
      return createResult(true, 'QUALITY_FALLBACK_TO_HIGHEST', 'Source is unavailable; using highest available resolution.', {
        requestedQuality: normalizedTarget,
        resolvedQuality: highestNumeric.quality,
        direction: 'down',
        boundary: 'highest',
        availableQualities
      });
    }

    return createResult(false, 'QUALITY_TARGET_WITHIN_RANGE', 'Requested quality is within available range.', {
      requestedQuality: normalizedTarget,
      availableQualities
    });
  }

  /** Collects practical selection indicators from one quality menu option element. */
  function analyzeQualityOptionSelectionState(entry, label) {
    const positiveSignals = [];
    const negativeSignals = [];
    let score = 0;

    // Use weighted signals to resolve conflicting selection indicators.
    const addPositive = (signal, weight) => {
      positiveSignals.push(signal);
      score += weight;
    };
    // Negative signals lower confidence for this option.
    const addNegative = (signal, weight) => {
      negativeSignals.push(signal);
      score -= weight;
    };

    const ariaChecked = String(entry.getAttribute('aria-checked') || '').toLowerCase();
    if (ariaChecked === 'true') addPositive('aria-checked=true', 8);
    if (ariaChecked === 'false') addNegative('aria-checked=false', 8);

    const ariaSelected = String(entry.getAttribute('aria-selected') || '').toLowerCase();
    if (ariaSelected === 'true') addPositive('aria-selected=true', 8);
    if (ariaSelected === 'false') addNegative('aria-selected=false', 8);

    const ariaCurrentRaw = String(entry.getAttribute('aria-current') || '').toLowerCase();
    if (ariaCurrentRaw && ariaCurrentRaw !== 'false') {
      addPositive(`aria-current=${ariaCurrentRaw}`, 5);
    }

    const checkedInput = entry.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    if (checkedInput) {
      addPositive('checked-input', 8);
    }

    const classDataText = [
      String(entry.className || ''),
      String(entry.getAttribute('data-a-target') || ''),
      String(entry.getAttribute('data-test-selector') || ''),
      String(entry.getAttribute('data-state') || '')
    ].join(' ').toLowerCase();

    if (/\b(selected|is-selected|active|is-active|checked|current)\b/.test(classDataText)) {
      addPositive('active-class-or-data', 3);
    }

    const entryLabelText = String(label || '').toLowerCase();
    if (/\b(current|aktuell|selected)\b/.test(entryLabelText)) {
      addPositive('label-current-marker', 2);
    }

    const indicatorSelector =
      '[aria-label*="check" i], [aria-label*="selected" i], [data-a-target*="check" i], [class*="checkmark" i], [class*="selected" i], svg';
    const indicatorNodes = Array.from(entry.querySelectorAll(indicatorSelector)).filter((node) => {
      if (!(node instanceof Element) || !node.isConnected) return false;
      if (node.getAttribute('aria-hidden') === 'true') return false;
      const s = window.getComputedStyle(node);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse';
    });
    const hasCheckIndicator = indicatorNodes.some((node) => {
      const visibleText = getMenuEntryText(node);
      if (/[✓✔☑]/.test(visibleText)) {
        return true;
      }
      const aria = String(node.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('check') || aria.includes('selected')) {
        return true;
      }
      const classData = [
        String(node.className || ''),
        String(node.getAttribute('data-a-target') || '')
      ].join(' ').toLowerCase();
      return /\b(check|checkmark|selected|active)\b/.test(classData);
    });
    if (hasCheckIndicator) {
      addPositive('visible-check-indicator', 4);
    }

    const hasStrongPositiveSignal =
      positiveSignals.includes('aria-checked=true') ||
      positiveSignals.includes('aria-selected=true') ||
      positiveSignals.includes('checked-input');
    const hasStrongNegativeSignal =
      negativeSignals.includes('aria-checked=false') ||
      negativeSignals.includes('aria-selected=false');

    let selected = false;
    let selectedConfidence = 'low';

    if (hasStrongPositiveSignal && !hasStrongNegativeSignal) {
      selected = true;
      selectedConfidence = 'high';
    } else if (!hasStrongNegativeSignal && score >= 7) {
      selected = true;
      selectedConfidence = 'medium';
    }

    if (hasStrongNegativeSignal && !hasStrongPositiveSignal) {
      selected = false;
      selectedConfidence = 'low';
    }

    return {
      selected,
      selectedScore: score,
      selectedConfidence,
      selectionSignals: positiveSignals,
      deselectionSignals: negativeSignals
    };
  }

  /** Captures visible quality options and marks which one appears selected. */
  function collectVisibleQualityOptions() {
    const menuRoots = findVisibleMenuRoots();
    if (menuRoots.length === 0) {
      return createResult(false, 'MENU_NOT_VISIBLE', 'No visible menu to collect quality options from.');
    }

    const selector =
      'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [data-a-target], label';
    const optionsByKey = new Map();

    for (const menuRoot of menuRoots) {
      const entries = Array.from(menuRoot.querySelectorAll(selector))
        .filter((entry) => isMenuEntryUsable(entry))
        .filter((entry) => !entry.matches('a[href]'));
      for (const entry of entries) {
        const label = getMenuEntryText(entry);
        if (!label) {
          continue;
        }

        const normalized = normalizeQualityLabel(label);
        if (!normalized) {
          continue;
        }

        const key = `${normalized}:${label.toLowerCase()}`;
        const selectionState = analyzeQualityOptionSelectionState(entry, label);
        const option = {
          element: entry,
          label,
          normalized,
          selected: selectionState.selected,
          selectedConfidence: selectionState.selectedConfidence,
          selectedScore: selectionState.selectedScore,
          selectionSignals: selectionState.selectionSignals,
          deselectionSignals: selectionState.deselectionSignals
        };

        const existing = optionsByKey.get(key);
        if (!existing) {
          optionsByKey.set(key, option);
          continue;
        }

        const isHigherSignal =
          option.selectedScore > existing.selectedScore ||
          (option.selected && !existing.selected) ||
          (option.selected === existing.selected && option.selectedConfidence === 'high' && existing.selectedConfidence !== 'high');

        if (isHigherSignal) {
          optionsByKey.set(key, option);
        }
      }
    }

    const options = Array.from(optionsByKey.values());

    if (options.length === 0) {
      return createResult(false, 'NO_QUALITY_OPTIONS', 'No visible quality options were detected.');
    }

    debug('collectVisibleQualityOptions: parsed options', options.map((option) => compactSelectionPreview(option)));

    return createResult(true, 'QUALITY_OPTIONS_COLLECTED', 'Collected visible quality options.', {
      options
    });
  }

  /** Infers selected quality from option state, else unknown. */
  function detectCurrentSelectedQuality(existingOptions = null) {
    let options = existingOptions;
    if (!Array.isArray(options)) {
      const optionsResult = collectVisibleQualityOptions();
      if (!optionsResult.ok) {
        return createResult(false, optionsResult.code, optionsResult.message, {
          quality: 'unknown',
          options: [],
          optionsResult
        });
      }
      options = optionsResult.details.options;
    }

    const selectedCandidates = options
      .filter((option) => option.selected)
      .sort((a, b) => b.selectedScore - a.selectedScore);

    if (selectedCandidates.length === 1) {
      const selected = selectedCandidates[0];
      debug('detectCurrentSelectedQuality: inferred from single selected candidate', compactSelectionPreview(selected));
      return createResult(true, 'CURRENT_QUALITY_DETECTED', `Detected current quality: ${selected.normalized}.`, {
        quality: selected.normalized,
        method: selected.selectedConfidence === 'high' ? 'selection-signals-high' : 'selection-signals-medium',
        selectedOption: compactSelectionPreview(selected),
        options: toSelectionPreviews(options)
      });
    }

    if (selectedCandidates.length > 1) {
      const top = selectedCandidates[0];
      const runnerUp = selectedCandidates[1];
      const topLead = top.selectedScore - runnerUp.selectedScore;

      if (top.selectedConfidence === 'high' && topLead >= 4) {
        debug('detectCurrentSelectedQuality: multiple selected candidates; top candidate chosen by score lead', {
          top: compactSelectionPreview(top),
          runnerUp: compactSelectionPreview(runnerUp),
          topLead
        });
        return createResult(true, 'CURRENT_QUALITY_DETECTED_BY_SCORE', `Detected current quality: ${top.normalized}.`, {
          quality: top.normalized,
          method: 'score-lead-disambiguation',
          topLead,
          selectedOption: compactSelectionPreview(top),
          selectedCandidates: toSelectionPreviews(selectedCandidates),
          options: toSelectionPreviews(options)
        });
      }

      debug('detectCurrentSelectedQuality: ambiguous selected candidates', {
        selectedCandidates: toSelectionPreviews(selectedCandidates)
      });
      return createUnknownCurrentQualityResult('Current quality is ambiguous in submenu state.', 'multiple-selected-candidates', options, {
        selectedCandidates: toSelectionPreviews(selectedCandidates)
      });
    }

    debug('detectCurrentSelectedQuality: no selected indicators found in submenu options', {
      options: toSelectionPreviews(options)
    });
    return createUnknownCurrentQualityResult(
      'No reliable selected quality indicator found in submenu state.',
      'no-selection-indicator',
      options
    );
  }

  /** Selects the best strict match for target quality. */
  function findBestMatchingQualityOption(targetQuality, existingOptions = null, matchOptions = {}) {
    const normalizedTarget = normalizeQualityLabel(targetQuality);
    if (!normalizedTarget) {
      return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
        targetQuality
      });
    }

    let options = existingOptions;
    if (!Array.isArray(options)) {
      const optionsResult = collectVisibleQualityOptions();
      if (!optionsResult.ok) {
        return createResult(false, optionsResult.code, optionsResult.message, optionsResult.details);
      }
      options = optionsResult.details.options;
    }

    const candidates = options.filter((option) => qualityLabelMatchesTarget(option.label, normalizedTarget, matchOptions));
    if (candidates.length === 0) {
      return createResult(false, 'QUALITY_MATCH_NOT_FOUND', `Requested ${normalizedTarget} is not available.`, {
        normalizedTarget,
        available: options.map((option) => option.label),
        allowSourceAliasForTargets:
          matchOptions.allowSourceAliasForTargets instanceof Set
            ? Array.from(matchOptions.allowSourceAliasForTargets)
            : []
      });
    }

    let chosen = candidates[0];
    if (normalizedTarget === 'Source') {
      // Prefer explicit "source" labels over aliases like "chunked".
      const explicitSource = candidates.find((option) => option.label.toLowerCase().includes('source'));
      if (explicitSource) {
        chosen = explicitSource;
      }
    }

    if (normalizedTarget !== 'Source') {
      const explicitResolutionCandidates = candidates.filter((option) => {
        return extractResolutionQuality(option.label) === normalizedTarget;
      });
      const preferred = explicitResolutionCandidates.length > 0 ? explicitResolutionCandidates : candidates;
      const alreadySelected = preferred.find((option) => option.selected);
      chosen = alreadySelected || preferred[0];
    } else {
      // Return already-selected target first to avoid extra clicks.
      const alreadySelected = candidates.find((option) => option.selected);
      if (alreadySelected) {
        chosen = alreadySelected;
      }
    }

    return createResult(true, 'QUALITY_MATCH_FOUND', 'Found best matching quality option.', {
      option: chosen,
      normalizedTarget,
      available: options.map((option) => option.label),
      alreadySelected: Boolean(chosen.selected)
    });
  }

  /** Verifies selection state after clicking a quality option. */
  async function verifyQualitySelection(targetQuality, matchOptions = {}) {
    const normalizedTarget = normalizeQualityLabel(targetQuality);
    if (!normalizedTarget) {
      return createResult(false, 'INVALID_TARGET_QUALITY', 'Cannot verify unknown target quality.', {
        targetQuality
      });
    }

    const waitResult = await waitForCondition(() => {
      const optionsResult = collectVisibleQualityOptions();
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

    const menuState = findVisibleMenuRoots().length;
    if (menuState === 0) {
      return createResult(true, 'QUALITY_CLICKED_UNCONFIRMED', 'Quality option clicked, but menu closed before selection could be verified.');
    }

    return createResult(false, 'QUALITY_NOT_VERIFIED', `Could not verify ${normalizedTarget} selection.`, {
      waitResult
    });
  }

  /** Runs a full quality selection attempt in Twitch player menus. */
  async function attemptSetQuality(targetQuality) {
    const normalizedTarget = normalizeQualityLabel(targetQuality);
    if (!normalizedTarget) {
      return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
        targetQuality
      });
    }

    debug('attemptSetQuality: opening quality submenu', { normalizedTarget });
    const openResult = await openQualitySubmenu();
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
      debug('attemptSetQuality: collecting visible quality options', { attempt });
      const collected = collectVisibleQualityOptions();
      if (collected.ok) {
        optionsResult = collected;
        const inferredFromCurrentOptions = inferSourceAliasTargets(
          openResult.details?.qualityEntryLabel,
          collected.details.options
        );
        for (const aliasTarget of inferredFromCurrentOptions) {
          allowSourceAliasForTargets.add(aliasTarget);
        }

        debug('attemptSetQuality: matching target quality', {
          attempt,
          normalizedTarget: effectiveTargetQuality,
          available: collected.details.options.map((option) => option.label),
          allowSourceAliasForTargets: Array.from(allowSourceAliasForTargets)
        });

        matchResult = findBestMatchingQualityOption(effectiveTargetQuality, collected.details.options, {
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
      const lateCollected = collectVisibleQualityOptions();
      if (lateCollected.ok) {
        optionsResult = lateCollected;
        const lateMatch = findBestMatchingQualityOption(effectiveTargetQuality, lateCollected.details.options, {
          allowSourceAliasForTargets
        });
        if (lateMatch.ok) {
          matchResult = lateMatch;
        }
      }
    }

    if ((!matchResult || !matchResult.ok) && optionsResult.ok) {
      const fallbackTargetResult = resolveOutOfRangeQualityTarget(normalizedTarget, optionsResult.details.options);
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

        debug('attemptSetQuality: strict match failed, applying boundary fallback', {
          requestedQuality: normalizedTarget,
          adjustedQuality: effectiveTargetQuality,
          direction: fallbackTargetResult.details.direction,
          availableQualities: fallbackTargetResult.details.availableQualities
        });

        matchResult = findBestMatchingQualityOption(effectiveTargetQuality, optionsResult.details.options, {
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

    debug('attemptSetQuality: clicking quality option', {
      targetQuality: effectiveTargetQuality,
      label: targetOption.label
    });

    const clickResult = clickElementSafely(targetOption.element, { skipVisibilityCheck: true });
    if (!clickResult.ok) {
      return createResult(false, clickResult.code, `Failed to click quality option: ${targetOption.label}.`, {
        targetOption,
        clickResult
      });
    }

    debug('attemptSetQuality: verifying selection state', { normalizedTarget: effectiveTargetQuality });
    const verifyResult = await verifyQualitySelection(effectiveTargetQuality, { allowSourceAliasForTargets });
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

  /** Attempts closing via visible "Close/Schließen" entries inside menu overlays. */
  function tryCloseViaVisibleMenuCloseEntry() {
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
  function tryCloseViaSettingsToggle() {
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
      ariaLabel: target.ariaLabel,
      text: target.text
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
  async function tryStepBackFromQualitySubmenu() {
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
  async function closeMenusIfNeeded(options = {}) {
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

  /** Classifies current Twitch URL as supported/unsupported with a clear reason. */
  function isSupportedTwitchPage() {
    if (!location.hostname.endsWith('twitch.tv')) {
      const result = {
        supported: false,
        reason: 'Unsupported host: not a twitch.tv page.',
        details: { hostname: location.hostname }
      };
      debug('Page rejected', result);
      return result;
    }

    const rawPath = location.pathname || '/';
    const normalizedPath = rawPath.replace(/\/+$/, '') || '/';
    const lowerPath = normalizedPath.toLowerCase();
    const segments = lowerPath.split('/').filter(Boolean);

    if (normalizedPath === '/') {
      const result = {
        supported: false,
        reason: 'Homepage is not a supported stream player page.',
        details: { path: normalizedPath }
      };
      debug('Page rejected', result);
      return result;
    }

    if (lowerPath.startsWith('/directory')) {
      const result = {
        supported: false,
        reason: 'Directory/category pages are not supported.',
        details: { path: normalizedPath }
      };
      debug('Page rejected', result);
      return result;
    }

    if (lowerPath.startsWith('/clips') || lowerPath.includes('/clip/')) {
      const result = {
        supported: false,
        reason: 'Clips pages are not supported.',
        details: { path: normalizedPath }
      };
      debug('Page rejected', result);
      return result;
    }

    const unsupportedRootPaths = new Set([
      'downloads',
      'jobs',
      'settings',
      'search',
      'p',
      'wallet',
      'friends',
      'messages',
      'subscriptions'
    ]);
    if (segments.length > 0 && unsupportedRootPaths.has(segments[0])) {
      const result = {
        supported: false,
        reason: 'This Twitch page type does not support stream quality automation.',
        details: { path: normalizedPath, rootSegment: segments[0] }
      };
      debug('Page rejected', result);
      return result;
    }

    const unsupportedChannelSubpages = new Set(['about', 'schedule', 'videos', 'clips', 'collections']);
    if (segments.length >= 2 && unsupportedChannelSubpages.has(segments[1])) {
      const result = {
        supported: false,
        reason: 'Channel subpage is not a live player view.',
        details: { path: normalizedPath, subpage: segments[1] }
      };
      debug('Page rejected', result);
      return result;
    }

    const playerRootResult = getPlayerRoot();
    if (!playerRootResult.ok) {
      const result = {
        supported: false,
        reason: 'No visible player detected. This is likely not a live stream page.',
        details: { path: normalizedPath, playerCode: playerRootResult.code }
      };
      debug('Page rejected', result);
      return result;
    }

    const accepted = {
      supported: true,
      reason: 'Supported Twitch live stream page detected.',
      details: {
        path: normalizedPath,
        playerSelector: playerRootResult.details.selector
      }
    };
    debug('Page accepted', accepted);
    return accepted;
  }

  /** Standard response envelope returned to popup message callers. */
  function makeResponse(ok, action, message, details = null) {
    return {
      ok,
      action,
      message: String(message || ''),
      details: serializeForMessage(details)
    };
  }

  /** Validates and normalizes inbound quality values from popup messages. */
  function validateQuality(value) {
    const normalized = normalizeQualityLabel(value);
    return QUALITY_SET.has(normalized) ? normalized : '';
  }

  /** Validates mode keys and defaults unknown values to HIGH mode. */
  function validateMode(value) {
    return MODE_SET.has(value) ? value : MODE_VALUES.HIGH;
  }

  /** Validates plugin-enabled state and defaults unknown values to enabled. */
  function validatePluginEnabled(value) {
    return value !== false;
  }

  /** Reads plugin-enabled state from storage with safe fallback. */
  async function loadPluginEnabledSetting() {
    try {
      const stored = await chrome.storage.local.get({ [STORAGE_KEYS.PLUGIN_ENABLED]: DEFAULT_MODE_SETTINGS[STORAGE_KEYS.PLUGIN_ENABLED] });
      return createResult(true, 'PLUGIN_ENABLED_READY', 'Loaded plugin-enabled setting from storage.', {
        pluginEnabled: validatePluginEnabled(stored[STORAGE_KEYS.PLUGIN_ENABLED])
      });
    } catch (error) {
      return createResult(false, 'PLUGIN_ENABLED_READ_FAILED', 'Failed to read plugin-enabled setting from storage.', {
        error: String(error),
        pluginEnabled: DEFAULT_MODE_SETTINGS[STORAGE_KEYS.PLUGIN_ENABLED]
      });
    }
  }

  /** Loads and sanitizes active-mode quality settings from extension storage. */
  async function loadModeSettingsForEnforcement() {
    try {
      const stored = await chrome.storage.local.get(DEFAULT_MODE_SETTINGS);
      const pluginEnabled = validatePluginEnabled(stored[STORAGE_KEYS.PLUGIN_ENABLED]);
      const activeMode = validateMode(stored[STORAGE_KEYS.ACTIVE_MODE]);
      const fastToggleLow = validateQuality(stored[STORAGE_KEYS.FAST_TOGGLE_LOW]) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_LOW];
      const fastToggleHigh =
        validateQuality(stored[STORAGE_KEYS.FAST_TOGGLE_HIGH]) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_HIGH];

      return createResult(true, 'MODE_SETTINGS_READY', 'Loaded mode settings from storage.', {
        pluginEnabled,
        activeMode,
        fastToggleLow,
        fastToggleHigh
      });
    } catch (error) {
      return createResult(false, 'MODE_SETTINGS_READ_FAILED', 'Failed to read mode settings from storage.', {
        error: String(error)
      });
    }
  }

  /** Resolves target quality from current mode settings. */
  function resolveTargetQualityForMode(modeSettings) {
    const pluginEnabled = validatePluginEnabled(modeSettings?.pluginEnabled);
    const activeMode = validateMode(modeSettings?.activeMode);
    const fastToggleLow = validateQuality(modeSettings?.fastToggleLow) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_LOW];
    const fastToggleHigh = validateQuality(modeSettings?.fastToggleHigh) || DEFAULT_MODE_SETTINGS[STORAGE_KEYS.FAST_TOGGLE_HIGH];
    const targetQuality = activeMode === MODE_VALUES.LOW ? fastToggleLow : fastToggleHigh;

    return {
      pluginEnabled,
      activeMode,
      fastToggleLow,
      fastToggleHigh,
      targetQuality
    };
  }

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

  /** Serializes quality requests to avoid UI races. */
  async function runQualityRequestExclusive(action, runFn) {
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
  async function executeSetQualityAutomation(targetQuality, pageSupport, action = 'setQuality', extraDetails = {}) {
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

      let closeAfterResult = await closeMenusIfNeeded({
        allowBodyClick: true,
        aggressiveBodyClicks: true,
        waitBeforeMs: 350,
        maxAttempts: 2
      });
      if (!closeAfterResult.ok) {
        debug('executeSetQualityAutomation: close-after first pass failed, retrying with extra settle delay', closeAfterResult);
        const closeAfterRetryResult = await closeMenusIfNeeded({
          allowBodyClick: true,
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
  async function detectCurrentQualityState() {
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
  async function handleSetQualityRequest(targetQuality, pageSupport) {
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

  /** Computes remaining cooldown time before the next auto-enforcement run. */
  function getEnforcementCooldownRemainingMs() {
    if (!enforcementState.lastRunAtMs) {
      return 0;
    }
    return Math.max(0, ENFORCEMENT_COOLDOWN_MS - (Date.now() - enforcementState.lastRunAtMs));
  }

  /** Debounces and schedules mode quality enforcement. */
  function scheduleEnsureDesiredQualityForCurrentMode(triggerReason, options = {}) {
    const force = options.force === true;
    const baseDelayMs = Number.isFinite(options.delayMs) ? Math.max(0, Math.floor(options.delayMs)) : ENFORCEMENT_DEBOUNCE_MS;
    const cooldownRemainingMs = getEnforcementCooldownRemainingMs();
    const delayMs = force ? baseDelayMs : Math.max(baseDelayMs, cooldownRemainingMs);

    if (!force && cooldownRemainingMs > 0) {
      debug('quality enforcement: cooldown prevents immediate execution; deferring', {
        triggerReason,
        cooldownRemainingMs
      });
    }
    if (enforcementState.inProgress) {
      debug('quality enforcement: lock active while scheduling follow-up run', {
        triggerReason
      });
    }

    if (enforcementState.scheduledTimerId) {
      clearTimeout(enforcementState.scheduledTimerId);
      enforcementState.scheduledTimerId = null;
    }

    enforcementState.scheduledTimerId = setTimeout(() => {
      enforcementState.scheduledTimerId = null;
      ensureDesiredQualityForCurrentMode(triggerReason, { force }).catch((error) => {
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
  async function ensureDesiredQualityForCurrentMode(triggerReason = 'unknown', options = {}) {
    const force = options.force === true;

    if (enforcementState.inProgress) {
      debug('quality enforcement: skipped because another run is still in progress', {
        triggerReason
      });
      return createResult(false, 'ENFORCEMENT_LOCKED', 'Quality enforcement skipped because another run is still in progress.');
    }

    const cooldownRemainingMs = getEnforcementCooldownRemainingMs();
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
      return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement skipped — tab not visible or window not focused.');
    }

    enforcementState.inProgress = true;
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

      const playerReadyResult = await waitForCondition(() => getPlayerRoot().ok, {
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

      const resolvedTarget = resolveTargetQualityForMode(modeSettingsResult.details);
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
        return createResult(false, 'TAB_NOT_FOCUSED', 'Quality enforcement aborted — tab lost focus during setup.');
      }

      if (isAdCurrentlyPlaying()) {
        debug('quality enforcement: skipped because a Twitch ad is currently playing', { triggerReason });
        return createResult(false, 'AD_PLAYING', 'Quality enforcement skipped — Twitch ad is playing.');
      }

      // Skip detect+set entirely if we recently confirmed this quality on the same URL.
      // Force triggers (storage change, SPA nav, page show) always bypass this.
      const trustAge = Date.now() - enforcementState.lastConfirmedQualityAtMs;
      const canSkipDetection = (
        !force &&
        enforcementState.lastResolvedTargetQuality === resolvedTarget.targetQuality &&
        enforcementState.lastRunUrl === location.href &&
        trustAge < QUALITY_TRUST_TTL_MS
      );
      if (canSkipDetection) {
        debug('quality enforcement: skipping detect+set — trusted quality state matches target', {
          triggerReason, trustAgeMs: trustAge, target: resolvedTarget.targetQuality
        });
        enforcementState.lastRunAtMs = Date.now();
        return createResult(true, 'QUALITY_TRUSTED', 'Quality recently confirmed; skipping menu detection.', {
          triggerReason, targetQuality: resolvedTarget.targetQuality, trustAgeMs: trustAge
        });
      }

      const currentQualityResult = await detectCurrentQualityState();

      // Re-check: detectCurrentQualityState() opens/closes menus and is async;
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
          enforcementState.lastResolvedTargetQuality = resolvedTarget.targetQuality;
          enforcementState.lastConfirmedQualityAtMs = Date.now();
          // Safety net: detectCurrentQualityState opens the quality submenu and closes it,
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

      const automationResponse = await runQualityRequestExclusive('modeEnforce', async () => {
        return executeSetQualityAutomation(resolvedTarget.targetQuality, pageSupport, 'modeEnforce', {
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
        scheduleEnsureDesiredQualityForCurrentMode('retry-after-busy', { delayMs: ENFORCEMENT_DEBOUNCE_MS, force: true });
        return createResult(false, 'ENFORCEMENT_BUSY', 'Automation busy; queued retry.');
      }

      if (automationResponse.ok) {
        debug('quality enforcement: executed automation', {
          targetQuality: resolvedTarget.targetQuality,
          resultCode: automationResponse.details?.resultCode
        });
        enforcementState.lastResolvedTargetQuality = resolvedTarget.targetQuality;
        enforcementState.lastConfirmedQualityAtMs = Date.now();
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
      enforcementState.inProgress = false;
      enforcementState.lastRunAtMs = Date.now();
      enforcementState.lastRunUrl = location.href;
    }
  }

  /** Returns true when the browser's fullscreen API has an active element. */
  function isBrowserInFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /** Returns true when a Twitch ad is currently visible in the player. */
  function isAdCurrentlyPlaying() {
    return AD_INDICATOR_SELECTORS.some((sel) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      if (el.offsetParent !== null) return true;
      // position:fixed elements always have offsetParent===null; check their painted size instead.
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  /**
   * Finds the Twitch fullscreen toggle button inside the player.
   * Returns the element or null if not found.
   */
  function findTwitchFullscreenButton() {
    const result = getPlayerRoot();
    if (!result.ok || !result.details?.element) {
      return null;
    }
    const playerRoot = result.details.element;
    for (const btn of Array.from(playerRoot.querySelectorAll('button, [role="button"]'))) {
      if (!isElementVisible(btn)) {
        continue;
      }
      const combined = [
        btn.getAttribute('aria-label') || '',
        btn.getAttribute('title') || '',
        btn.getAttribute('data-a-target') || ''
      ].join(' ').toLowerCase();
      if (combined.includes('fullscreen') || combined.includes('vollbild')) {
        return btn;
      }
    }
    return null;
  }

  /**
   * Attempts to restore browser fullscreen after the extension accidentally
   * caused Twitch to drop from fullscreen to cinema/theater mode.
   * Tries requestFullscreen() on the player directly first; falls back to
   * clicking Twitch's "Enter Fullscreen" button.
   */
  async function attemptRestoreTwitchFullscreen() {
    if (isBrowserInFullscreen()) {
      debug('fullscreen restore: already in fullscreen, nothing to do');
      return;
    }

    const playerRootResult = getPlayerRoot();
    if (!playerRootResult.ok || !playerRootResult.details?.element) {
      debug('fullscreen restore: player not found');
      return;
    }
    const playerRoot = playerRootResult.details.element;

    // Hover to reveal controls, then click Twitch's own fullscreen button.
    // Letting Twitch handle the requestFullscreen() call internally ensures it uses
    // the right element and applies the correct layout — direct API calls cause a
    // partial layout glitch (bottom ~20% dark, player shifted up).
    triggerPlayerHover(playerRoot);
    await wait(600);

    const btn = findTwitchFullscreenButton();
    if (!btn) {
      debug('fullscreen restore: fullscreen button not found, falling back to requestFullscreen()');
      try {
        const requestFn = playerRoot.requestFullscreen?.bind(playerRoot)
          || playerRoot.webkitRequestFullscreen?.bind(playerRoot);
        if (requestFn) {
          await requestFn();
          debug('fullscreen restore: requestFullscreen() fallback succeeded');
        }
      } catch (err) {
        debug('fullscreen restore: requestFullscreen() fallback also failed', String(err));
      }
      return;
    }

    const combined = [
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || ''
    ].join(' ').toLowerCase();

    // 'exit' / 'beenden' means Twitch already considers itself in fullscreen — skip.
    if (combined.includes('exit') || combined.includes('beenden')) {
      debug('fullscreen restore: button is in exit-fullscreen state, skipping');
      return;
    }

    debug('fullscreen restore: clicking button to restore', { label: btn.getAttribute('aria-label') });
    clickElementSafely(btn, { prepare: false });
  }

  /** Registers storage/navigation/focus hooks that keep mode quality enforced. */
  function setupAutomaticModeEnforcement() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const relevantKeys = [STORAGE_KEYS.ACTIVE_MODE, STORAGE_KEYS.FAST_TOGGLE_LOW, STORAGE_KEYS.FAST_TOGGLE_HIGH, STORAGE_KEYS.PLUGIN_ENABLED].filter((key) => {
        return Object.prototype.hasOwnProperty.call(changes, key);
      });
      if (relevantKeys.length === 0) {
        return;
      }

      debug('quality enforcement: storage change detected', {
        keys: relevantKeys
      });
      scheduleEnsureDesiredQualityForCurrentMode('storage-change', {
        force: true,
        delayMs: 160
      });
    });

    // Compare only origin+pathname so query-param-only changes (e.g. Twitch VOD ?t= timestamp
    // updates that fire every ~10 s during playback) are not treated as SPA navigations.
    const getUrlKey = () => location.origin + location.pathname;
    let previousUrl = getUrlKey();
    enforcementState.urlWatchTimerId = setInterval(() => {
      const currentUrl = getUrlKey();
      if (currentUrl === previousUrl) {
        return;
      }

      const fromUrl = previousUrl;
      previousUrl = currentUrl;
      debug('quality enforcement: twitch SPA navigation detected', {
        fromUrl,
        toUrl: previousUrl
      });
      scheduleEnsureDesiredQualityForCurrentMode('spa-navigation', {
        force: true,
        delayMs: 900
      });
    }, 1000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      debug('quality enforcement: tab became visible');
      scheduleEnsureDesiredQualityForCurrentMode('visibility-visible', {
        delayMs: 250
      });
    });

    window.addEventListener('focus', () => {
      debug('quality enforcement: window focused');
      scheduleEnsureDesiredQualityForCurrentMode('window-focus', {
        delayMs: 300
      });
    });

    function onFullscreenChange() {
      const isFullscreen = isBrowserInFullscreen();
      debug('quality enforcement: fullscreenchange', { isFullscreen });
      if (isFullscreen) {
        // User entered fullscreen — remember intent and reset restoration counter.
        fullscreenState.userIntended = true;
        fullscreenState.restorationAttempts = 0;
        return;
      }

      // Fullscreen was lost. Decide: did our enforcement cause this, or did the user exit?
      // Signal: enforcement was running at the moment fullscreen exited, or completed very
      // recently (≤3 s) — Twitch reacts to our DOM clicks with a slight delay.
      const msSinceEnforcement = Date.now() - enforcementState.lastRunAtMs;
      const likelyCausedByUs = fullscreenState.userIntended
        && (enforcementState.inProgress || msSinceEnforcement < 2000);

      if (likelyCausedByUs && fullscreenState.restorationAttempts < 3) {
        fullscreenState.restorationAttempts += 1;
        debug('fullscreen restore: fullscreen lost during/after enforcement, scheduling restore', {
          attempt: fullscreenState.restorationAttempts,
          enforcementInProgress: enforcementState.inProgress,
          msSinceEnforcement
        });
        // Give Twitch time to fully settle into cinema mode before re-entering fullscreen.
        setTimeout(() => {
          if (isBrowserInFullscreen()) {
            return; // already back in fullscreen somehow
          }
          if (fullscreenState.restorationInProgress) {
            return;
          }
          fullscreenState.restorationInProgress = true;
          attemptRestoreTwitchFullscreen().catch((err) => {
            debug('fullscreen restore: error', String(err));
          }).finally(() => {
            fullscreenState.restorationInProgress = false;
          });
        }, 800);
      } else {
        // User intentionally exited fullscreen — clear intent, apply quality.
        fullscreenState.userIntended = false;
        fullscreenState.restorationAttempts = 0;
        scheduleEnsureDesiredQualityForCurrentMode('fullscreen-exit', { delayMs: 500 });
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    window.addEventListener('pageshow', () => {
      debug('quality enforcement: pageshow event');
      scheduleEnsureDesiredQualityForCurrentMode('pageshow', {
        force: true,
        delayMs: 700
      });
    });
  }

  /** Main popup/content bridge that validates requests before entering automation flow. */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
        return makeResponse(false, 'unknown', 'Invalid message payload.');
      }

      const { action } = message;
      debug('Received message', { action, message, sender });

      const pluginEnabledResult = await loadPluginEnabledSetting();
      if (!pluginEnabledResult.ok) {
        return makeResponse(false, action, pluginEnabledResult.message, pluginEnabledResult.details);
      }
      if (!pluginEnabledResult.details?.pluginEnabled) {
        return makeResponse(false, action, 'Plugin logic is disabled. Turn it on in the popup to apply quality changes.', {
          pluginEnabled: false
        });
      }

      const pageSupport = getPageSupportState();
      if (!pageSupport.ok) {
        return makeResponse(false, action, pageSupport.message, pageSupport);
      }

      if (action === 'setQuality') {
        return handleSetQualityRequest(message.targetQuality, pageSupport);
      }

      return makeResponse(false, action, `Unknown action: ${action}`);
    })()
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        debug('Unhandled message error', String(error));
        sendResponse(makeResponse(false, 'unknown', 'Unhandled content script error.', { error: String(error) }));
      });

    return true;
  });

  debug('Loaded on Twitch page', location.href);

  setupAutomaticModeEnforcement();
  scheduleEnsureDesiredQualityForCurrentMode('initial-load', {
    force: true,
    delayMs: 900
  });

  // Startup probe for visible player readiness.
  waitForCondition(() => getPlayerRoot().ok, {
    timeoutMs: 3000,
    intervalMs: 150,
    description: 'visible player root'
  }).then((result) => {
    if (result.ok) {
      debug('Startup check passed', result.details);
    } else {
      debug('Startup check pending/no player yet', result.details);
    }
  });
})();
