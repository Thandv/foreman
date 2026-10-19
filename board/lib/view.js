/**
 * view.js — the furniture the eight phase-2 views are built out of.
 *
 * board.js predates this and builds its lanes by hand; everything after it
 * shares one vocabulary instead, because eight views hand-rolling their own
 * headers, sections, tables and buttons is eight chances for the tips to go
 * missing and for two views to disagree about what a table looks like.
 *
 * The one rule every helper here enforces: an actionable control is built with
 * `button()`, which cannot be constructed without a name and a description, and
 * which routes its click through runAction() so the outcome is reported exactly
 * once. Nothing here ever touches innerHTML — same as the rest of the board.
 */
import { add, clear, el, emptyState, truncate } from './dom.js';
import { icon } from './icons.js';
import { tip } from './tooltip.js';
import { runAction, toast } from './toast.js';

// ------------------------------------------------------------------ chrome

/** The header every view opens with: title, lede, and the view's own actions. */
export function viewHead(title, lede, actions = []) {
  const head = el('div', 'view-head');
  const heading = el('div');
  heading.appendChild(el('h1', null, title));
  if (lede) heading.appendChild(el('p', 'lede', lede));
  head.appendChild(heading);
  if (actions.filter(Boolean).length) head.appendChild(actionBar(actions));
  return head;
}

export function actionBar(actions) {
  const bar = el('div', 'view-actions');
  for (const a of actions) if (a) bar.appendChild(a instanceof Node ? a : button(a));
  return bar;
}

/**
 * A titled block. Returns the node plus its body, so a caller can re-render the
 * contents without rebuilding the heading (which is what a refresh does).
 */
export function section(title, desc, opts = {}) {
  const node = el('section', 'vsec');
  const head = el('div', 'vsec-head');
  const h = el('h2', 'vsec-title', title);
  if (desc) tip(h, title, desc, { place: 'bottom' });
  head.appendChild(h);
  if (opts.note) head.appendChild(el('div', 'vsec-note', opts.note));
  if (opts.actions?.length) head.appendChild(actionBar(opts.actions));
  const body = el('div', 'vsec-body');
  add(node, head, body);
  return { node, body, head };
}

// ----------------------------------------------------------------- controls

/**
 * button({ label, icon, desc, variant, keys, place, run, ok }) — the only way
 * this codebase makes a clickable thing. `desc` is mandatory in spirit: a
 * control that cannot say what it does has no business being on screen.
 */
export function button({ label, icon: iconName, desc, variant = '', keys, place, run, ok, disabled }) {
  const b = el('button', `btn ${variant}`.trim());
  b.type = 'button';
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(el('span', null, label));
  tip(b, label, desc, { keys, place });
  if (disabled) b.disabled = true;
  if (run) b.addEventListener('click', () => void runAction(b, run, ok));
  return b;
}

/** Labelled control, tip on the whole field so label and input both explain it. */
export function field(label, desc, control, opts = {}) {
  const wrap = el('label', 'field');
  const head = el('span', 'label');
  head.appendChild(el('span', null, label));
  if (opts.hint) head.appendChild(el('span', 'hint', opts.hint));
  tip(wrap, label, desc, { place: opts.place ?? 'right' });
  add(wrap, head, control);
  return wrap;
}

export function input(opts = {}) {
  const i = el('input');
  if (opts.name) i.name = opts.name;
  if (opts.type) i.type = opts.type;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  if (opts.value !== undefined) i.value = opts.value;
  if (opts.required) i.required = true;
  if (opts.list) i.setAttribute('list', opts.list);
  return i;
}

export function textarea(opts = {}) {
  const t = el('textarea');
  if (opts.name) t.name = opts.name;
  t.rows = opts.rows ?? 4;
  if (opts.placeholder) t.placeholder = opts.placeholder;
  if (opts.value !== undefined) t.value = opts.value;
  if (opts.required) t.required = true;
  return t;
}

/** select([[value, label], …], selected) */
export function select(options, value) {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option', null, label);
    o.value = v;
    s.appendChild(o);
  }
  if (value !== undefined && value !== null) s.value = value;
  return s;
}

/**
 * A row of filter chips acting as one radio group. Chips rather than <input
 * type=radio> because every one of these picks a *view* of something (today vs
 * all, prompt vs ask vs improve) and needs its own tip — which a bare radio
 * cannot carry without a wrapper anyway.
 */
export function chipGroup(options, value, onChange) {
  const node = el('div', 'chip-group');
  node.setAttribute('role', 'radiogroup');
  let current = value;
  const buttons = new Map();
  for (const [v, label, desc, name] of options) {
    const b = el('button', `fchip${v === current ? ' on' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === current));
    tip(b, name ?? label, desc);
    b.addEventListener('click', () => {
      if (current === v) return;
      current = v;
      for (const [val, node2] of buttons) {
        node2.classList.toggle('on', val === current);
        node2.setAttribute('aria-checked', String(val === current));
      }
      onChange?.(current);
    });
    buttons.set(v, b);
    node.appendChild(b);
  }
  return { node, get value() { return current; } };
}

// ------------------------------------------------------------------- atoms

export function chip(text, cls, name, desc) {
  const c = el('span', `chip ${cls ?? ''}`.trim(), text);
  if (name) tip(c, name, desc);
  return c;
}

export function chipRow(...kids) {
  return add(el('div', 'chips'), ...kids);
}

/** Definition list: label on the left, value on the right, both selectable. */
export function kvs(rows) {
  const dl = el('dl', 'kvs');
  for (const [label, value, desc] of rows) {
    if (value === null || value === undefined || value === '') continue;
    const dt = el('dt', null, label);
    if (desc) tip(dt, label, desc);
    dl.appendChild(dt);
    dl.appendChild(value instanceof Node ? add(el('dd'), value) : el('dd', null, String(value)));
  }
  return dl;
}

/**
 * table([{ label, desc, cls }], [[cell, …]]) — cells are strings or nodes.
 * Column headers carry the tip, which is where a jargon term ('p90', 'gate')
 * gets explained without stealing a row of the table to do it.
 */
export function table(cols, rows) {
  const wrap = el('div', 'tblwrap');
  const t = el('table', 'tbl');
  const thead = el('thead');
  const hr = el('tr');
  for (const c of cols) {
    const th = el('th', c.headCls ?? null, c.label);
    if (c.desc) tip(th, c.label, c.desc, { place: 'bottom' });
    hr.appendChild(th);
  }
  add(thead, hr);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      const td = el('td', cols[i]?.cls ?? null);
      if (cell instanceof Node) td.appendChild(cell);
      else if (cell !== null && cell !== undefined) td.textContent = String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  add(t, thead, tbody);
  wrap.appendChild(t);
  return wrap;
}

/** A cell that shows the first `max` characters and expands in place on click. */
export function expandable(text, max = 90) {
  const full = String(text ?? '');
  if (full.length <= max) return el('span', null, full);
  const wrap = el('span', 'expandable');
  const body = el('span', null, truncate(full, max));
  const more = el('button', 'linkish', 'more');
  more.type = 'button';
  let open = false;
  tip(more, 'Expand', 'Show the whole value instead of the first line of it.');
  more.addEventListener('click', () => {
    open = !open;
    body.textContent = open ? full : truncate(full, max);
    more.textContent = open ? 'less' : 'more';
  });
  return add(wrap, body, more);
}

/** A shell command the operator is meant to run, with a button that copies it. */
export function commandBlock(command, desc) {
  const row = el('div', 'cmd');
  row.appendChild(el('code', null, command));
  row.appendChild(copyButton(command, desc));
  return row;
}

export function copyButton(text, desc) {
  return button({
    label: 'Copy',
    icon: 'inbox',
    variant: 'sm',
    desc: desc ?? 'Copy this command to the clipboard so you can paste it into a terminal.',
    run: async () => {
      // clipboard.writeText is unavailable on a non-secure origin; the daemon
      // is http://127.0.0.1, which browsers do treat as secure, but a user
      // reaching the board over a tunnel would not have it.
      if (!navigator.clipboard?.writeText) throw new Error('this browser will not allow copying from an insecure origin');
      await navigator.clipboard.writeText(text);
    },
    ok: 'Copied to the clipboard',
  });
}

/** Full-width notice: the one-line verdict a view puts above its detail. */
export function banner(kind, title, detail) {
  const node = el('div', `banner ${kind}`);
  node.appendChild(icon(kind === 'bad' ? 'alert' : kind === 'ok' ? 'check' : 'info'));
  const body = el('div');
  body.appendChild(el('div', 'banner-title', title));
  if (detail) body.appendChild(el('div', 'banner-detail', detail));
  node.appendChild(body);
  return node;
}

/** An <a> that looks like a button. Used only for in-app hash links. */
export function linkButton(href, label, desc, iconName) {
  const a = el('a', 'btn');
  a.href = href;
  if (iconName) a.appendChild(icon(iconName));
  a.appendChild(el('span', null, label));
  tip(a, label, desc);
  return a;
}

// ------------------------------------------------------------------ loading

/**
 * Fill `node` from an async loader, with the three states every view needs:
 * loading, failed (with the daemon's own message), and rendered. `render`
 * returns a node — or nothing, if it appended to `node` itself.
 */
export async function loadInto(node, loader, render, opts = {}) {
  clear(node).appendChild(el('p', 'faint', opts.loading ?? 'Loading…'));
  let data;
  try {
    data = await loader();
  } catch (err) {
    clear(node).appendChild(emptyState(
      opts.errorTitle ?? 'Could not load this',
      err.message,
      { icon: icon('alert'), inline: true },
    ));
    return null;
  }
  clear(node);
  try {
    const out = render(data);
    if (out) node.appendChild(out);
  } catch (err) {
    node.appendChild(emptyState('Could not render this', err.message, { icon: icon('alert'), inline: true }));
    toast.err(err);
  }
  return data;
}
