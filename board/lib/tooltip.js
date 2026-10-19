/**
 * tooltip.js — the board's self-documenting hover layer.
 *
 * The requirement it exists for: every actionable control explains itself.
 * `title=` cannot do that — it is unstyled, slow, single-line, invisible to
 * keyboard users and impossible to position — so this is a real component.
 *
 * ## Authoring API (phase 2 reuses exactly this)
 *
 * Declarative, on any element:
 *
 *   <button data-tip="Approve"
 *           data-tip-desc="Accept the staged diff; merges the branch if merge-on-approve is set"
 *           data-tip-place="bottom"
 *           data-tip-keys="⌘,Enter">
 *
 * Or programmatically (identical result, nicer at a call site that is already
 * building the node):
 *
 *   tip(button, 'Approve', 'Accept the staged diff; …', { place: 'bottom', keys: ['⌘', 'Enter'] });
 *
 * `data-tip` is the name, `data-tip-desc` the one-line description of what the
 * control does, `data-tip-place` a preference of top|bottom|left|right that is
 * overridden when the preferred side does not fit, `data-tip-keys` an optional
 * comma-separated shortcut rendered as <kbd>s.
 *
 * ## Behaviour
 *
 * One delegated listener set on document, one reused DOM node, so a view can
 * re-render its whole subtree without registering or leaking anything. Hover
 * and keyboard focus both open it after ~150ms; once a tip is already up,
 * moving to another tipped control swaps instantly (no re-delay). It closes on
 * pointer-out, blur, Escape, any click, scroll, resize, and as soon as its
 * trigger leaves the document. Positioned fixed and clamped into the viewport,
 * so it is never clipped by the lane columns or the drawer, both of which
 * scroll. pointer-events are off — the tip can never swallow a click.
 */
import { el } from './dom.js';

const OPEN_DELAY_MS = 150;
/** Gap between the trigger and the tip, and the minimum margin to any edge. */
const GAP = 8;
const EDGE = 8;

let node = null;
let nameEl = null;
let descEl = null;
let keysEl = null;
let current = null;
let openTimer = 0;
let aliveTimer = 0;
let installed = false;

function ensureNode() {
  if (node) return node;
  node = el('div', null);
  node.id = 'tip';
  node.setAttribute('role', 'tooltip');
  nameEl = el('div', 'tip-name');
  descEl = el('div', 'tip-desc');
  keysEl = el('div', 'tip-key');
  node.append(nameEl, descEl, keysEl);
  document.body.appendChild(node);
  return node;
}

/** Read the whole tip spec off an element's data attributes. */
function specFor(target) {
  const name = target.getAttribute('data-tip');
  if (!name) return null;
  return {
    name,
    desc: target.getAttribute('data-tip-desc') ?? '',
    place: target.getAttribute('data-tip-place') ?? 'auto',
    keys: (target.getAttribute('data-tip-keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  };
}

/**
 * Place the tip against `rect`. Tries the preferred side, falls back to the
 * opposite one when there is no room, then clamps along the free axis — the
 * clamp is what keeps a tip on a control at the very edge of the window fully
 * on screen instead of half-painted past the boundary.
 */
function place(rect, preferred) {
  const t = ensureNode();
  // Measure at full opacity-0 but laid out; the node is always in the DOM.
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const fits = {
    top: rect.top - h - GAP >= EDGE,
    bottom: rect.bottom + h + GAP <= vh - EDGE,
    left: rect.left - w - GAP >= EDGE,
    right: rect.right + w + GAP <= vw - EDGE,
  };
  const order = preferred === 'auto'
    ? ['bottom', 'top', 'right', 'left']
    : [preferred, { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[preferred], 'bottom', 'top'];
  const side = order.find((s) => s && fits[s]) ?? 'bottom';

  let x;
  let y;
  if (side === 'top' || side === 'bottom') {
    x = rect.left + rect.width / 2 - w / 2;
    y = side === 'top' ? rect.top - h - GAP : rect.bottom + GAP;
  } else {
    x = side === 'left' ? rect.left - w - GAP : rect.right + GAP;
    y = rect.top + rect.height / 2 - h / 2;
  }
  t.style.left = `${Math.round(Math.min(Math.max(x, EDGE), Math.max(EDGE, vw - w - EDGE)))}px`;
  t.style.top = `${Math.round(Math.min(Math.max(y, EDGE), Math.max(EDGE, vh - h - EDGE)))}px`;
}

function show(target) {
  const spec = specFor(target);
  if (!spec) return;
  const t = ensureNode();
  nameEl.textContent = spec.name;
  descEl.textContent = spec.desc;
  descEl.hidden = !spec.desc;
  keysEl.textContent = '';
  keysEl.hidden = spec.keys.length === 0;
  for (const k of spec.keys) keysEl.appendChild(el('kbd', null, k));

  current = target;
  // Lay out before measuring, then position, then reveal — otherwise the
  // first frame paints at the previous tip's coordinates.
  t.dataset.open = '0';
  place(target.getBoundingClientRect(), spec.place);
  t.dataset.open = '1';

  // A view can re-render out from under a hovered control (SSE refresh); when
  // that happens the trigger leaves the document and the tip must go with it.
  clearInterval(aliveTimer);
  aliveTimer = setInterval(() => {
    if (!current || !current.isConnected) hide();
  }, 400);
}

export function hide() {
  clearTimeout(openTimer);
  clearInterval(aliveTimer);
  openTimer = 0;
  aliveTimer = 0;
  current = null;
  if (node) node.dataset.open = '0';
}

function requestShow(target) {
  if (target === current) return;
  clearTimeout(openTimer);
  // Warm handoff: if a tip is already up, moving to the next control shows it
  // straight away rather than making the user wait out the delay again.
  if (node?.dataset.open === '1') {
    show(target);
    return;
  }
  openTimer = setTimeout(() => show(target), OPEN_DELAY_MS);
}

/**
 * Set (or clear, with a null name) an element's tip. Returns the element so it
 * can be used inline: `add(row, tip(el('button', 'btn', 'Retry'), 'Retry', '…'))`.
 */
export function tip(target, name, desc, opts = {}) {
  if (!target) return target;
  if (name == null) {
    target.removeAttribute('data-tip');
    target.removeAttribute('data-tip-desc');
    target.removeAttribute('data-tip-place');
    target.removeAttribute('data-tip-keys');
    return target;
  }
  target.setAttribute('data-tip', name);
  if (desc) target.setAttribute('data-tip-desc', desc);
  if (opts.place) target.setAttribute('data-tip-place', opts.place);
  if (opts.keys?.length) target.setAttribute('data-tip-keys', opts.keys.join(','));
  // An icon-only control has no accessible name of its own; the tip is it.
  if (!target.getAttribute('aria-label') && !target.textContent.trim()) target.setAttribute('aria-label', name);
  return target;
}

/** Call once, from main.js. Idempotent. */
export function installTooltips() {
  if (installed) return;
  installed = true;
  ensureNode();

  document.addEventListener('pointerover', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) {
      if (current && !current.contains(e.target)) hide();
      return;
    }
    requestShow(target);
  });
  document.addEventListener('pointerout', (e) => {
    if (!current) return;
    // Leaving for a child of the same trigger is not leaving.
    if (e.relatedTarget && current.contains(e.relatedTarget)) return;
    hide();
  });

  // Keyboard parity: tabbing to a control documents it exactly as hovering does.
  document.addEventListener('focusin', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target) requestShow(target);
    else hide();
  });
  document.addEventListener('focusout', hide);

  // Anything that moves the page or takes an action closes the tip: a stale
  // tip floating over a modal is worse than no tip at all.
  document.addEventListener('pointerdown', hide, true);
  // A field's tip opens on focus, which is right — but leaving it hovering
  // beside the input for as long as someone types in it is not.
  document.addEventListener('input', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}
