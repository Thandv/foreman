/**
 * palette.js — ⌘K / Ctrl-K command palette.
 *
 * Everything reachable from the sidebar or the topbar is reachable from here,
 * plus the per-task actions, which need a second step to pick their target.
 * An item either runs (`run`) or opens a sub-list (`children`); that one rule
 * is the whole navigation model, so "Approve task…" is not a special case.
 *
 *   registerCommands(() => [
 *     { id, name, desc, kind, icon, run },
 *     { id, name, desc, kind, icon, children: () => [ …more items… ] },
 *   ]);
 */
import { add, el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { hide as hideTip } from './tooltip.js';

let providers = [];
let dialog = null;
let queryIn = null;
let listEl = null;
let level = null; // { items, title } — a sub-list, or null at the root
let matches = [];
let cursor = 0;

/** Register a source of commands. Returns an unregister function. */
export function registerCommands(fn) {
  providers.push(fn);
  return () => { providers = providers.filter((p) => p !== fn); };
}

function rootItems() {
  return providers.flatMap((fn) => {
    try {
      return fn() ?? [];
    } catch {
      return []; // a broken provider must not take the palette down
    }
  });
}

/**
 * Subsequence fuzzy match. Returns a score (higher is better) or -1 for no
 * match. Consecutive characters and word-start hits score more, so typing
 * "apt" finds "Approve task" ahead of "Adapt prompt".
 */
function score(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    streak = found === ti && ti > 0 ? streak + 1 : 0;
    const wordStart = found === 0 || /[\s\-_/·:]/.test(t[found - 1]);
    total += 1 + streak * 2 + (wordStart ? 3 : 0);
    ti = found + 1;
  }
  // A shorter label matching the same query is the more likely target.
  return total - text.length * 0.01;
}

function ranked(query) {
  const items = level ? level.items : rootItems();
  if (!query) return items.slice(0, 60);
  return items
    .map((item) => ({ item, s: Math.max(score(query, item.name), score(query, `${item.name} ${item.desc ?? ''}`) - 2) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((r) => r.item);
}

function paint() {
  matches = ranked(queryIn.value.trim());
  cursor = Math.min(cursor, Math.max(0, matches.length - 1));
  listEl.textContent = '';

  if (!matches.length) {
    listEl.appendChild(el('div', 'empty inline', 'Nothing matches that.'));
    return;
  }
  matches.forEach((item, i) => {
    const row = el('div', 'palette-item');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === cursor));
    row.appendChild(icon(item.icon ?? (item.children ? 'arrow' : 'bolt')));
    const text = el('div', 'pi-text');
    text.appendChild(el('div', 'pi-name', item.children ? `${item.name}…` : item.name));
    if (item.desc) text.appendChild(el('div', 'pi-desc', item.desc));
    row.appendChild(text);
    if (item.kind) row.appendChild(el('div', 'pi-kind', item.kind));
    row.addEventListener('pointermove', () => {
      if (cursor === i) return;
      cursor = i;
      for (const [j, node] of [...listEl.children].entries()) node.setAttribute?.('aria-selected', String(j === cursor));
    });
    row.addEventListener('click', () => void choose(matches[i]));
    listEl.appendChild(row);
  });
  listEl.children[cursor]?.scrollIntoView({ block: 'nearest' });
}

async function choose(item) {
  if (!item) return;
  if (item.children) {
    let kids = [];
    try {
      kids = (await item.children()) ?? [];
    } catch (err) {
      toast.err(err);
      return;
    }
    if (!kids.length) {
      toast.info(item.emptyMessage ?? 'Nothing to pick from.');
      return;
    }
    level = { items: kids, title: item.name };
    queryIn.value = '';
    queryIn.placeholder = `${item.name}…`;
    cursor = 0;
    paint();
    return;
  }
  close();
  try {
    await item.run?.();
  } catch (err) {
    toast.err(err);
  }
}

function close() {
  dialog?.close('cancel');
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el('dialog', 'palette');

  const head = el('div', 'palette-input');
  head.appendChild(icon('search'));
  queryIn = el('input');
  queryIn.type = 'text';
  queryIn.placeholder = 'Go to a view, or run an action…';
  queryIn.setAttribute('aria-label', 'Command palette');
  queryIn.autocomplete = 'off';
  queryIn.spellcheck = false;
  head.appendChild(queryIn);

  listEl = el('div', 'palette-list');
  listEl.setAttribute('role', 'listbox');

  const foot = el('div', 'palette-foot');
  for (const [keys, label] of [[['↑', '↓'], 'navigate'], [['↵'], 'run'], [['esc'], 'back']]) {
    const span = el('span');
    for (const k of keys) span.appendChild(el('kbd', null, k));
    span.appendChild(el('span', null, label));
    foot.appendChild(span);
  }

  add(dialog, head, listEl, foot);
  document.body.appendChild(dialog);

  queryIn.addEventListener('input', () => { cursor = 0; paint(); });
  dialog.addEventListener('close', () => { level = null; queryIn.value = ''; });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      cursor = matches.length ? (cursor + 1) % matches.length : 0;
      paint();
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      cursor = matches.length ? (cursor - 1 + matches.length) % matches.length : 0;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void choose(matches[cursor]);
    } else if (e.key === 'Escape' && level) {
      // Escape backs out of a sub-list first; a second one closes.
      e.preventDefault();
      level = null;
      queryIn.value = '';
      queryIn.placeholder = 'Go to a view, or run an action…';
      cursor = 0;
      paint();
    }
  });
  return dialog;
}

export function openPalette() {
  const d = ensureDialog();
  if (d.open) return;
  hideTip();
  level = null;
  cursor = 0;
  queryIn.value = '';
  queryIn.placeholder = 'Go to a view, or run an action…';
  d.showModal();
  paint();
  queryIn.focus();
}

/** Bind ⌘K / Ctrl-K. Call once from main.js. */
export function installPalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (dialog?.open) close();
      else openPalette();
    }
  });
}
