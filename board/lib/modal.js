/**
 * modal.js — one <dialog> builder, so every modal in the app has the same
 * head/body/foot skeleton, the same Escape and backdrop behaviour, and the
 * same teardown. Views build the body; nothing else.
 *
 *   const m = modal({ title: 'New task', sub: 'Queue work for a worker' });
 *   m.body.append(…);
 *   m.foot.append(cancelButton, submitButton);
 *   m.open();
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { tip, hide as hideTip } from './tooltip.js';

export function modal({ title, sub, wide = false, onClose } = {}) {
  const dialog = el('dialog', `modal${wide ? ' wide' : ''}`);

  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.appendChild(el('h2', null, title ?? ''));
  if (sub) heading.appendChild(el('div', 'sub', sub));
  head.appendChild(heading);

  const closeBtn = el('button', 'icon-btn');
  closeBtn.type = 'button';
  closeBtn.appendChild(icon('close'));
  tip(closeBtn, 'Close', 'Dismiss this dialog without saving anything', { keys: ['Esc'] });
  closeBtn.addEventListener('click', () => dialog.close('cancel'));
  head.appendChild(closeBtn);

  const body = el('div', 'modal-body');
  const foot = el('div', 'modal-foot');
  dialog.append(head, body, foot);
  document.body.appendChild(dialog);

  // Clicking the backdrop closes: the click lands on the dialog element
  // itself only when it is outside the padded content box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close('cancel');
  });

  dialog.addEventListener('close', () => {
    hideTip();
    onClose?.(dialog.returnValue);
    dialog.remove();
  });

  return {
    dialog,
    body,
    foot,
    open: () => { dialog.showModal(); },
    close: (value) => dialog.close(value ?? 'cancel'),
  };
}

/** The cancel button every modal foot starts with. */
export function cancelButton(m, label = 'Cancel') {
  const b = el('button', 'btn ghost', label);
  b.type = 'button';
  tip(b, label, 'Close without queueing anything', { keys: ['Esc'] });
  b.addEventListener('click', () => m.close('cancel'));
  return b;
}
