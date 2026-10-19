/**
 * nav.js — the one way a view moves the operator to another view.
 *
 * Views must not assign `location.hash` themselves: main.js's `navigate()`
 * carries the same-hash guard that makes a wedged view remountable from its own
 * nav item, and a second copy of that rule is how the two drift apart. But a
 * view also cannot import main.js — main.js imports every view, and that cycle
 * is a real hazard rather than a stylistic one.
 *
 * So the router injects itself here at boot, and views ask this module. The
 * hash is still driven from exactly one function, in exactly one file.
 */
let navigator_ = null;

/** Called once by main.js with its own navigate(). */
export function setNavigator(fn) {
  navigator_ = fn;
}

/**
 * Go to a view, optionally with route params. A no-op before the router has
 * registered — which can only happen during module evaluation, before any view
 * is mounted, and is better than throwing inside a click handler.
 */
export function goTo(id, ...params) {
  navigator_?.(id, ...params);
}
