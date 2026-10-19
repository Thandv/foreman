/**
 * toast.js — the single place an action result is reported.
 *
 * The old board used alert() for failures and nothing at all for successes,
 * so a click that worked looked identical to a click that did nothing. Every
 * action in the app now ends in exactly one of these three calls.
 *
 *   toast.ok('Approved — merged onto main');
 *   toast.err(e.message);
 *   toast.info('Audit running…');
 *
 * Returns a dismiss function so a long-running caller can replace its own
 * notice rather than stacking a second one.
 */
import { el } from './dom.js';
import { icon } from './icons.js';

const LIFETIME_MS = 4500;
const ERROR_LIFETIME_MS = 9000; // a failure has to survive long enough to read
const MAX_VISIBLE = 4;

let host = null;

function ensureHost() {
  if (host) return host;
  host = el('div');
  host.id = 'toasts';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

function dismiss(node) {
  if (!node.isConnected || node.classList.contains('leaving')) return;
  node.classList.add('leaving');
  // Match the CSS exit; a reduced-motion user has zeroed it, so fall back to a
  // timer rather than waiting for an animationend that may never fire.
  setTimeout(() => node.remove(), 260);
}

function push(kind, message) {
  const wrap = ensureHost();
  const node = el('div', `toast ${kind}`);
  node.appendChild(icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info'));
  node.appendChild(el('div', 'toast-body', message));
  node.addEventListener('click', () => dismiss(node));
  wrap.appendChild(node);

  // Oldest first out, so a burst of events cannot cover the whole screen.
  while (wrap.children.length > MAX_VISIBLE) dismiss(wrap.firstElementChild);

  const timer = setTimeout(() => dismiss(node), kind === 'err' ? ERROR_LIFETIME_MS : LIFETIME_MS);
  return () => { clearTimeout(timer); dismiss(node); };
}

export const toast = {
  ok: (message) => push('ok', String(message)),
  err: (message) => push('err', String(message?.message ?? message)),
  info: (message) => push('info', String(message)),
};

/**
 * Run an async action, reporting the outcome exactly once. The shape every
 * button in the app uses, so no caller has to remember the try/catch/toast
 * dance or to re-enable itself on failure.
 *
 * `okMessage` may be a string, or a function of the result returning either a
 * string or `{ ok, message }`. The second form exists for the daemon routes
 * that answer 200 for a request that only *half* succeeded — approve lands a
 * gate decision but can still come back with an aborted merge — so a partial
 * outcome reports as an error toast without every caller re-implementing the
 * try/catch it just avoided. See approvalOutcome() in lib/store.js.
 */
export async function runAction(button, fn, okMessage) {
  const was = button?.disabled;
  if (button) button.disabled = true;
  try {
    const result = await fn();
    if (okMessage) {
      const outcome = typeof okMessage === 'function' ? okMessage(result) : okMessage;
      const message = typeof outcome === 'string' ? outcome : outcome?.message;
      if (message) (outcome?.ok === false ? toast.err : toast.ok)(message);
    }
    return result;
  } catch (err) {
    toast.err(err);
    return null;
  } finally {
    if (button?.isConnected) button.disabled = was ?? false;
  }
}
