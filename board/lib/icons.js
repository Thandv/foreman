/**
 * icons.js — inline SVG, built with createElementNS rather than innerHTML so
 * the board's no-HTML-strings rule holds even for chrome.
 *
 * One geometry for everything: 24×24 box, 1.6 stroke, round caps and joins,
 * no fills. Colour comes from `currentColor`, so an icon always matches the
 * text next to it and needs no per-icon theming.
 */
const NS = 'http://www.w3.org/2000/svg';

/** name → list of [tagName, attributes] parts. */
const ICONS = {
  // --- navigation -------------------------------------------------------
  board: [
    ['rect', { x: 3, y: 4, width: 5, height: 16, rx: 1.5 }],
    ['rect', { x: 9.5, y: 4, width: 5, height: 11, rx: 1.5 }],
    ['rect', { x: 16, y: 4, width: 5, height: 7, rx: 1.5 }],
  ],
  build: [
    ['path', { d: 'M12 3 3 7.5l9 4.5 9-4.5z' }],
    ['path', { d: 'M3 12.5 12 17l9-4.5' }],
    ['path', { d: 'M3 17 12 21.5 21 17' }],
  ],
  playbooks: [
    ['path', { d: 'M20 3.5v17H6.5A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5z' }],
    ['path', { d: 'M4 18a2.5 2.5 0 0 1 2.5-2.5H20' }],
  ],
  tools: [
    ['path', { d: 'M14.5 3.6a5.5 5.5 0 0 1 6 8.9 5.5 5.5 0 0 1-6.1 1.2l-6.6 6.6a2.3 2.3 0 0 1-3.2-3.2l6.6-6.6a5.5 5.5 0 0 1 1.2-6.1z' }],
    ['path', { d: 'M14.6 3.7 17.9 7l2.6-2.6' }],
  ],
  memory: [
    ['ellipse', { cx: 12, cy: 5.5, rx: 7.5, ry: 2.8 }],
    ['path', { d: 'M4.5 5.5v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-6' }],
    ['path', { d: 'M4.5 11.5v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-6' }],
  ],
  schedules: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 6.8V12l3.4 2.1' }],
  ],
  receipts: [
    ['path', { d: 'M6 2.8h12v18.4l-3-2-3 2-3-2-3 2z' }],
    ['path', { d: 'M9.2 8.2h5.6' }],
    ['path', { d: 'M9.2 12.2h5.6' }],
  ],
  doctor: [['path', { d: 'M2.5 12H7l2.6-7.2 4.2 14.4L16.6 12h4.9' }]],
  prose: [
    ['path', { d: 'M20.2 12.3a6 6 0 0 0-8.5-8.5L5 10.5V19h8.5z' }],
    ['path', { d: 'M16 8 2.8 21.2' }],
    ['path', { d: 'M17.4 15H9' }],
  ],

  // --- brand + chrome ---------------------------------------------------
  hardhat: [
    ['path', { d: 'M3.5 17.5a8.5 8.5 0 0 1 17 0z' }],
    ['path', { d: 'M9 17.5V8.4A3 3 0 0 1 12 5.4a3 3 0 0 1 3 3v9.1' }],
    ['path', { d: 'M2.5 17.5h19' }],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.8 }],
    ['path', { d: 'M20.5 20.5 16 16' }],
  ],
  plus: [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]],
  close: [['path', { d: 'M6.5 6.5 17.5 17.5' }], ['path', { d: 'M17.5 6.5 6.5 17.5' }]],
  check: [['path', { d: 'M4.5 12.5 9.5 17.5 19.5 6.5' }]],
  alert: [
    ['path', { d: 'M12 3.4 22 20H2z' }],
    ['path', { d: 'M12 9.6v4.6' }],
    ['path', { d: 'M12 17.3h.01' }],
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 11.2v5' }],
    ['path', { d: 'M12 7.9h.01' }],
  ],
  collapse: [['path', { d: 'M11 6 5 12l6 6' }], ['path', { d: 'M19 6l-6 6 6 6' }]],
  expand: [['path', { d: 'M13 6l6 6-6 6' }], ['path', { d: 'M5 6l6 6-6 6' }]],
  command: [
    ['path', { d: 'M9 6.5a2.5 2.5 0 1 0-2.5 2.5H9zM9 9h6M9 9v6M15 9h2.5A2.5 2.5 0 1 0 15 6.5V9zM15 15v2.5A2.5 2.5 0 1 0 17.5 15H15zM9 15H6.5A2.5 2.5 0 1 0 9 17.5V15z' }],
  ],

  // --- actions ----------------------------------------------------------
  refresh: [['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }], ['path', { d: 'M20 4v5h-5' }]],
  ban: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M6 6l12 12' }]],
  trash: [
    ['path', { d: 'M4 6.8h16' }],
    ['path', { d: 'M9.5 6.8V4.6h5v2.2' }],
    ['path', { d: 'M6.4 6.8 7.4 20h9.2l1-13.2' }],
  ],
  eye: [
    ['path', { d: 'M2.2 12S6 5.6 12 5.6 21.8 12 21.8 12 18 18.4 12 18.4 2.2 12 2.2 12z' }],
    ['circle', { cx: 12, cy: 12, r: 2.8 }],
  ],
  bolt: [['path', { d: 'M13.2 2.4 4.4 14h6.1l-1 7.6L19.6 10h-6.4z' }]],
  arrow: [['path', { d: 'M5 12h14' }], ['path', { d: 'M13 6l6 6-6 6' }]],
  role: [['circle', { cx: 12, cy: 8, r: 3.4 }], ['path', { d: 'M5.2 20a6.8 6.8 0 0 1 13.6 0' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 6.8V12l3.4 2.1' }]],
  inbox: [
    ['path', { d: 'M3.5 13.5 6 5h12l2.5 8.5v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z' }],
    ['path', { d: 'M3.5 13.5h4l1.2 2.4h6.6l1.2-2.4h4' }],
  ],
  // A person and a machine: who is going to do the work. `role` is already a
  // bust for "which crew role", so `user` is drawn head-and-shoulders to read
  // as *you* rather than as another role chip.
  user: [
    ['circle', { cx: 12, cy: 7.5, r: 3.6 }],
    ['path', { d: 'M4.5 20.5a7.5 7.5 0 0 1 15 0' }],
  ],
  bot: [
    ['rect', { x: 4, y: 8, width: 16, height: 11, rx: 2.5 }],
    ['path', { d: 'M12 8V4.5' }],
    ['circle', { cx: 9, cy: 13, r: 1.2 }],
    ['circle', { cx: 15, cy: 13, r: 1.2 }],
  ],
  archive: [
    ['rect', { x: 3, y: 4, width: 18, height: 4.5, rx: 1.2 }],
    ['path', { d: 'M5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-10' }],
    ['path', { d: 'M9.8 12.5h4.4' }],
  ],
};

/**
 * icon('board') → an <svg class="ico"> ready to append. Unknown names return
 * an empty box rather than throwing: a missing glyph must never take a view
 * down with it.
 */
export function icon(name, cls) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls ? `ico ${cls}` : 'ico');
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.appendChild(node);
  }
  return svg;
}

export const iconNames = () => Object.keys(ICONS);
