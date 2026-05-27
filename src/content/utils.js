import { DEBUG, DEBUG_PREFIX } from './constants.js';

/** Lightweight debug logger that can be disabled from one flag. */
export function debug(message, details) {
  if (!DEBUG) return;
  if (details !== undefined) {
    console.log(`${DEBUG_PREFIX} ${message}`, details);
    return;
  }
  console.log(`${DEBUG_PREFIX} ${message}`);
}

/** Standard result envelope for internal automation steps. */
export function createResult(ok, code, message, details = null) {
  return { ok, code, message, details };
}

/** Serializes values into message-safe JSON data. */
export function serializeForMessage(value, depth = 0, seen = new WeakSet()) {
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
export function wait(ms) {
  const delay = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Returns a small random offset in [-px, +px] to de-mechanize synthetic coordinates. */
export function jitter(px = 8) {
  return (Math.random() - 0.5) * px * 2;
}

/** Visibility guard used before reading/clicking Twitch UI elements. */
export function isElementVisible(element) {
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
export function isMenuEntryUsable(element) {
  if (!(element instanceof Element) || !element.isConnected) return false;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  return element.offsetWidth > 0 && element.offsetHeight > 0;
}

/** Returns readable text with ARIA/title fallbacks for menu matching. */
export function getVisibleText(element) {
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
export function getMenuEntryText(element) {
  if (!(element instanceof Element)) return '';
  const ariaLabel = element.getAttribute('aria-label');
  const title = element.getAttribute('title');
  return (ariaLabel || element.innerText || title || element.textContent || '')
    .replace(/\s+/g, ' ').trim();
}

/** Returns true when a text-input element currently has focus (e.g. Twitch chat box). */
export function isUserTypingInInput() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/** Performs a defensive click with pre-checks and safe focus/scroll attempts. */
export function clickElementSafely(element, options = {}) {
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
export async function waitForCondition(fn, options = {}) {
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
