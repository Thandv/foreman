/**
 * dom.js — the four things every view needs: element construction, the fetch
 * wrapper, formatters, and a couple of DOM chores.
 *
 * Hard rule for the whole board, inherited from the original app.js: nothing
 * that came off the wire is ever assigned to innerHTML. `el()` takes text and
 * sets textContent; there is no HTML-string path in this module at all.
 */

export const $ = (id) => document.getElementById(id);

/** el('div', 'card', 'hello') → <div class="card">hello</div> */
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** Append many children at once; skips null/undefined so callers can inline conditionals. */
export function add(parent, ...kids) {
  for (const k of kids) if (k) parent.appendChild(k);
  return parent;
}

export function clear(node) {
  node.textContent = '';
  return node;
}

/**
 * JSON fetch. Throws Error(body.error) on a non-2xx so every caller can just
 * try/catch and hand the message to a toast.
 */
export async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/** POST helper — the shape nearly every action uses. */
export const post = (path, body) =>
  api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

// ------------------------------------------------------------- formatting

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtDur(a, b) {
  if (!a) return '';
  const s = Math.max(0, Math.round(((b ?? Date.now()) - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export const fmtUsd = (n, digits = 3) => `$${Number(n || 0).toFixed(digits)}`;
export const fmtInt = (n) => Number(n || 0).toLocaleString();
export const fmtTime = (ts) => new Date(Number(ts)).toLocaleTimeString();

/** Trim to `max` characters on a word boundary where one is close enough. */
export function truncate(text, max = 120) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

// ---------------------------------------------------------------- motion

/**
 * True when the user has told the OS they want reduced motion. theme.css
 * already zeroes the --t-* transition tokens and forces `scroll-behavior:
 * auto` under this same media query, but an explicit `behavior: 'smooth'`
 * passed to scrollIntoView() overrides that CSS — only a JS-level check can
 * honour the setting for a scroll driven by an options object, not a class.
 */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** scrollIntoView that asks for 'smooth' only when the user hasn't opted out of motion. */
export function scrollIntoViewSmooth(node, opts = {}) {
  node.scrollIntoView({ ...opts, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// ----------------------------------------------------------- empty states

/**
 * The one empty state. Every view uses it so "nothing here" always looks the
 * same and always says what to do next.
 */
export function emptyState(title, hint, opts = {}) {
  const wrap = el('div', `empty${opts.inline ? ' inline' : ''}`);
  if (opts.icon) wrap.appendChild(opts.icon);
  wrap.appendChild(el('div', 'empty-title', title));
  if (hint) wrap.appendChild(el('div', 'empty-hint', hint));
  return wrap;
}
