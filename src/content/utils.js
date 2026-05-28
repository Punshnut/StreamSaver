/**
 * content/utils.js
 *
 * Pure utility functions used across the entire content script.
 * Nothing in this file imports from other local modules except constants.js,
 * which keeps it importable everywhere without creating circular deps.
 *
 * Exports:
 *   debug()               — conditional console logging behind the DEBUG flag
 *   createResult()        — standard { ok, code, message, details } envelope
 *   serializeForMessage() — safe deep-clone for cross-context messaging
 *   wait()                — Promise-based sleep for async retry loops
 *   jitter()              — random offset to de-mechanize synthetic events
 *   isElementVisible()    — full visibility check for general UI probing
 *   isMenuEntryUsable()   — lighter visibility check for menu entries
 *   getVisibleText()      — readable text with ARIA fallbacks
 *   getMenuEntryText()    — like getVisibleText but bypasses BCR visibility gate
 *   isUserTypingInInput() — detects focused text inputs (prevents chat disruption)
 *   stealthClick()        — defensive click with pre-checks
 *   awaitSignal()         — poll-until-condition with timeout
 */

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

/**
 * Serializes values into message-safe JSON data.
 * Strips DOM elements, functions, and circular references that would cause
 * chrome.runtime.sendMessage to throw or silently drop the payload.
 */
export function serializeForMessage(value, depth = 0, seen = new WeakSet()) {
  // Hard cap on recursion depth to prevent stack overflows on deeply nested objects.
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
  // Functions can't be serialized across extension contexts.
  if (valueType === 'function') {
    return '[Function]';
  }

  // DOM nodes would serialize as {} — replace with a readable tag string instead.
  if (value instanceof Element) {
    const tagName = value.tagName ? value.tagName.toLowerCase() : 'element';
    return `[DOM:${tagName}]`;
  }
  // Preserve the useful parts of Error objects (name + message).
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

  // Symbol, BigInt, etc. — stringify as a last resort.
  return String(value);
}

/** Promise-based sleep helper for retry loops. */
export function wait(ms) {
  const delay = Number.isFinite(ms) ? Math.max(0, ms) : 0; // NaN / Infinity / negative → 0
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Returns a small random offset in [-px, +px] to de-mechanize synthetic coordinates.
 *  Applied to hover and click points so they don't land on the exact same pixel every run. */
export function jitter(px = 8) {
  return (Math.random() - 0.5) * px * 2;
}

/** Visibility guard used before reading/clicking Twitch UI elements. */
export function isElementVisible(element) {
  // Must be a connected Element — detached nodes are invisible by definition.
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
  // An element with opacity:0 is invisible even if it has layout.
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
 *  Always uses offsetWidth/Height (immune to the filter:opacity BCR bug — see isElementVisible). */
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

  // Prefer explicit ARIA label, then inner text (which strips hidden elements),
  // then title attribute, then raw textContent as a last resort.
  const ariaLabel = element.getAttribute('aria-label');
  const title = element.getAttribute('title');
  const rawText = ariaLabel || element.innerText || title || element.textContent || '';

  // Collapse whitespace and trim — Twitch labels sometimes have extra newlines.
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

/** Returns true when a text-input element currently has focus (e.g. Twitch chat box).
 *  Used to prevent enforcement from dispatching Escape or clicks while the user types. */
export function isUserTypingInInput() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // contenteditable covers Twitch's rich-text chat input.
  if (el.isContentEditable) return true;
  return false;
}

/** Performs a defensive click with pre-checks and safe focus/scroll attempts. */
export function stealthClick(element, options = {}) {
  // Reject non-HTML elements — SVG and generic Element nodes can't be reliably clicked.
  if (!(element instanceof HTMLElement)) {
    return createResult(false, 'INVALID_ELEMENT', 'Click target is not an HTML element.');
  }
  // skipVisibilityCheck is used when the menu hider's clip-path makes the element
  // technically invisible but still fully interactive (layout box is intact).
  if (!options.skipVisibilityCheck && !isElementVisible(element)) {
    return createResult(false, 'ELEMENT_HIDDEN', 'Click target is not visible.');
  }
  // Clicking a disabled element would have no effect and could confuse state tracking.
  if (element.matches('[disabled], [aria-disabled="true"]')) {
    return createResult(false, 'ELEMENT_DISABLED', 'Click target is disabled.');
  }

  if (options.prepare !== false) {
    // Scroll the element into view so synthetic events hit the right position,
    // then focus it so keyboard shortcuts don't fire on the wrong element.
    try {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (error) {
      debug('scrollIntoView failed but continuing', String(error));
    }

    try {
      element.focus({ preventScroll: true }); // preventScroll so we don't undo the scrollIntoView
    } catch (error) {
      debug('focus failed but continuing', String(error));
    }
  }

  // Refuse to click links — they'd navigate the page instead of toggling a menu.
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

/** Waits until a condition succeeds or times out.
 *  fn() is called repeatedly at intervalMs; the loop exits as soon as fn()
 *  returns a truthy value or the timeoutMs wall time is exceeded. */
export async function awaitSignal(fn, options = {}) {
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
      // Don't abort on errors from fn() — treat them as "not ready yet" and keep polling.
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
