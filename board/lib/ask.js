/**
 * ask.js — the assistant flow: describe an outcome, read the plan Foreman
 * proposes, then queue it (or don't).
 *
 * This is carried forward from the old board rather than deferred with the
 * rest of the Build view: it was already working, and "every capability is
 * reachable" has to hold at the end of this phase too. Phase 2's Build view
 * will absorb it alongside the crew-epic planner; the two-call contract it
 * uses (POST /api/ask without `confirm` to preview, with `confirm` to queue)
 * is the same one /api/build follows, so that absorption is a merge, not a
 * rewrite.
 */
import { add, el, post } from './dom.js';
import { icon } from './icons.js';
import { modal, cancelButton } from './modal.js';
import { tip } from './tooltip.js';
import { toast } from './toast.js';
import { store } from './store.js';

export function openAsk() {
  const m = modal({
    title: 'Ask Foreman',
    sub: 'Say what you want done. You see the plan before anything is queued.',
    wide: true,
  });

  const form = el('form', 'form-grid');
  form.id = 'askForm';

  const askIn = el('textarea');
  askIn.name = 'ask';
  askIn.rows = 4;
  askIn.required = true;
  askIn.placeholder = 'Summarise last week’s commits and draft the release note';

  const askField = el('label', 'field');
  const askLabel = el('span', 'label');
  askLabel.appendChild(el('span', null, 'What do you want done?'));
  tip(askField, 'The ask', 'An outcome, not a command. The planner turns it into tasks and decides which runner each one needs.', { place: 'right' });
  add(askField, askLabel, askIn);

  const repoIn = el('input');
  repoIn.name = 'repo';
  repoIn.placeholder = '/Users/you/Projects/thing';
  const repoField = el('label', 'field');
  const repoLabel = el('span', 'label');
  repoLabel.appendChild(el('span', null, 'Repo'));
  repoLabel.appendChild(el('span', 'hint', 'optional'));
  tip(repoField, 'Repo', 'Absolute path to a git repo. Code tasks in the plan get a worktree cut from it.', { place: 'right' });
  add(repoField, repoLabel, repoIn);

  const sensSel = el('select');
  sensSel.name = 'sensitivity';
  for (const [v, label] of [['S1', 'S1 — normal'], ['S0', 'S0 — public'], ['S2', 'S2 — local models only']]) {
    const o = el('option', null, label);
    o.value = v;
    sensSel.appendChild(o);
  }
  const sensField = el('label', 'field');
  const sensLabel = el('span', 'label');
  sensLabel.appendChild(el('span', null, 'Sensitivity'));
  tip(sensField, 'Sensitivity', 'Applied to every task the plan produces. S2 refuses all cloud model calls.', { place: 'right' });
  add(sensField, sensLabel, sensSel);

  const err = el('p', 'err-text');
  err.hidden = true;
  const planWrap = el('div');
  planWrap.hidden = true;

  add(form, askField, add(el('div', 'grid-2'), repoField, sensField), err, planWrap);
  m.body.appendChild(form);

  const planBtn = el('button', 'btn primary');
  planBtn.type = 'submit';
  planBtn.setAttribute('form', 'askForm');
  add(planBtn, icon('bolt'), el('span', null, 'Plan it'));
  tip(planBtn, 'Plan it', 'Asks the planner for a task breakdown. Nothing is queued and nothing runs yet.', { place: 'top' });

  const queueBtn = el('button', 'btn primary');
  queueBtn.type = 'button';
  queueBtn.hidden = true;
  add(queueBtn, icon('plus'), el('span', null, 'Queue this plan'));
  tip(queueBtn, 'Queue this plan', 'Creates every task shown above, wired to each other’s dependencies, and wakes the scheduler.', { place: 'top' });

  m.foot.append(cancelButton(m), planBtn, queueBtn);

  let currentPlan = null;

  function renderPlan(plan) {
    planWrap.textContent = '';
    planWrap.hidden = false;
    const notes = el(
      'p',
      plan.degraded ? 'err-text' : 'faint',
      plan.degraded ? `Planner unavailable — ${plan.notes}` : (plan.notes || plan.ask),
    );
    planWrap.appendChild(notes);
    for (const n of plan.nodes) {
      const node = el('div', 'op');
      node.appendChild(el('h5', null, n.title));
      const why = [n.kind, n.runner, n.after.length ? `after ${n.after.join(', ')}` : null, n.reason].filter(Boolean).join(' · ');
      node.appendChild(el('p', 'faint', why));
      tip(node, n.title, `${n.kind} on ${n.runner}${n.after.length ? `, after ${n.after.join(', ')}` : ''}. ${n.reason ?? ''}`.trim());
      planWrap.appendChild(node);
    }
    if (plan.reusedTools?.length) {
      planWrap.appendChild(el('p', 'faint', `reusing: ${plan.reusedTools.join(', ')}`));
    }
  }

  async function send(confirm, button) {
    err.hidden = true;
    button.disabled = true;
    try {
      const d = await post('/api/ask', {
        ask: askIn.value.trim(),
        repo: repoIn.value.trim() || null,
        sensitivity: sensSel.value,
        confirm,
        // A plan sent back is one we already showed: the daemon reparses it
        // rather than trusting the wire, but it does not re-plan and re-bill.
        plan: confirm ? currentPlan : undefined,
      });
      currentPlan = d.plan;
      renderPlan(d.plan);
      if (confirm) {
        m.close('queued');
        toast.ok(`Queued ${d.queued.length} task${d.queued.length === 1 ? '' : 's'}`);
        await store.refresh();
      } else {
        planBtn.hidden = true;
        queueBtn.hidden = false;
      }
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send(false, planBtn);
  });
  queueBtn.addEventListener('click', () => void send(true, queueBtn));

  m.open();
  askIn.focus();
}
