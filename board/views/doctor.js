/**
 * views/doctor.js — is the machine actually healthy?
 *
 * GET /api/doctor is a probe: it pings every configured model alias and
 * preflights every runner, which is exactly what "are you well?" has to mean if
 * the answer is going to be trusted. It is cheap (a one-token ping per alias)
 * so it runs on mount.
 *
 * The improvement proposal is the opposite: POST /api/improve spends a real
 * model call reasoning over the daemon's own evidence. That is behind a button,
 * never a mount — a health page that quietly costs money every time you open it
 * is a page nobody opens.
 */
import { add, api, clear, el, emptyState, fmtInt, fmtUsd, post } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { tip } from '../lib/tooltip.js';
import { toast } from '../lib/toast.js';
import {
  actionBar, banner, button, chip, commandBlock, kvs, loadInto, section, table, viewHead,
} from '../lib/view.js';

export const meta = {
  id: 'doctor',
  title: 'Doctor',
  icon: 'doctor',
  desc: 'Whether the machine is actually healthy: models reachable, runners usable, agents admitted, workers free.',
};

const BENCH_COMMAND = 'foreman doctor --bench';

let wantImprove = false;
export function requestImprove() { wantImprove = true; }

const okChip = (ok, okText, badText, okDesc, badDesc) => (ok
  ? chip(okText, 'ok', okText, okDesc)
  : chip(badText, 'bad', badText, badDesc));

export function mount(root) {
  root.className = 'view';

  const health = section('Health', 'A live probe, run just now: every model alias pinged, every runner preflighted.');
  const latency = section('Where the time goes', 'Stage durations over the last runs, from the events the scheduler already writes. No extra instrumentation.');
  const bench = section('Model bench', 'Measured speed and accuracy per model, and the roster those measurements chose.');
  const improve = section('Self-improvement', 'Foreman reading its own evidence — failures, rejections, quarantines, slow kinds — and proposing one change to itself.');

  add(root, viewHead(meta.title, meta.desc), health.node, latency.node, bench.node, improve.node);

  // ---------------------------------------------------------------- health

  const refreshHealth = () => loadInto(
    health.body,
    () => api('/api/doctor'),
    (d) => {
      const wrap = el('div', 'stack');

      const modelsOk = d.models.filter((m) => m.ok).length;
      const runnersOk = d.runners.filter((r) => r.ok).length;
      wrap.appendChild(d.models.length && !modelsOk
        ? banner('bad', 'No model answered', 'Every configured alias failed its ping. Planning, review and gate decisions all need a model — start ollama, or set an API key.')
        : banner('ok', `${modelsOk}/${d.models.length} models answering · ${runnersOk}/${d.runners.length} runners usable`, `Home ${d.home} · ${d.workers.active}/${d.workers.max} workers busy, ${d.workers.verifying} verifying · ${fmtUsd(d.budget.spentToday)} of ${fmtUsd(d.budget.dailyCapUsd, 2)} spent today`));

      const mTitle = el('div', 'section-title', 'Models');
      tip(mTitle, 'Models', 'Each configured alias, pinged just now with a one-token request. An alias that fails here fails for real work too.');
      wrap.appendChild(mTitle);
      wrap.appendChild(table(
        [
          { label: 'alias', desc: 'The name roles and tiers resolve to. Configuration refers to this, not to the model name.' },
          { label: 'model', desc: 'The actual model behind the alias.' },
          { label: 'where', desc: 'Local means inference never leaves this machine — the only thing an S2 task may use.' },
          { label: 'state', desc: 'Whether it answered the ping.' },
          { label: 'ms', desc: 'How long the ping took. Cold local models are slow on the first call and fast afterwards.', cls: 'num' },
          { label: 'error', desc: 'Why it failed, straight from the provider.' },
        ],
        d.models.map((m) => [
          m.alias,
          m.model,
          m.local
            ? chip('local', 'ok', 'Local', 'Runs on this machine. Free, and S2-safe.')
            : chip('cloud', 'split', 'Cloud', 'Leaves this machine. Billed per token, and refused for S2 work.'),
          okChip(m.ok, 'ok', 'fail', 'Answered the ping.', 'Did not answer. Anything routed here will fail.'),
          fmtInt(m.latencyMs),
          m.error ?? '',
        ]),
      ));

      const rTitle = el('div', 'section-title', 'Runners');
      tip(rTitle, 'Runners', 'The engines that execute a task. Preflight is the same check the scheduler runs before it admits work to one.');
      wrap.appendChild(rTitle);
      wrap.appendChild(table(
        [
          { label: 'runner', desc: 'The engine a task names to be executed by.' },
          { label: 'state', desc: 'Whether a task could run on it right now.' },
          { label: 'reason', desc: 'Exactly why it is unusable, and usually what to install to fix it.' },
        ],
        d.runners.map((r) => [
          r.id,
          okChip(r.ok, 'usable', 'unusable', 'A task can run on this engine now.', 'A task naming this runner would fail at admission.'),
          r.reason ?? '',
        ]),
      ));

      const aTitle = el('div', 'section-title', `Agents — ${d.agents.length} admitted, ${d.refusedAgents.length} refused`);
      tip(aTitle, 'Agents', 'Named personas a task can be pinned to. Each is admission-scanned before it is allowed into the catalog, because an agent definition becomes part of a worker’s prompt.');
      wrap.appendChild(aTitle);
      if (!d.agents.length && !d.refusedAgents.length) {
        wrap.appendChild(emptyState('No agents defined', 'Agents are optional: without one, a task’s role and playbook decide the model. Drop a definition in the agents directory to add one.', { inline: true }));
      } else {
        wrap.appendChild(table(
          [
            { label: 'agent', desc: 'The id a task pins itself to.' },
            { label: 'description', desc: 'What the agent is for.' },
            { label: 'model', desc: 'A model this agent pins. It overrides the role tier, which is why a pinned agent can be more expensive than its role suggests.' },
            { label: 'findings', desc: 'What the admission scanner flagged in the definition. Admitted anyway, but worth reading.' },
          ],
          [
            ...d.agents.map((a) => [a.id, a.description, a.model ?? '—', a.findings?.length ? String(a.findings.length) : '—']),
            ...d.refusedAgents.map((r) => [
              chip(r.id, 'bad', `Refused: ${r.id}`, 'This definition was rejected by the scanner and is not in the catalog. No task can pin it.'),
              r.reason,
              '—',
              'refused',
            ]),
          ],
        ));
      }

      wrap.appendChild(kvs([
        ['home', d.home, 'Where the database, jails, artifacts and playbooks live.'],
        ['workers', `${d.workers.active} of ${d.workers.max} busy`, 'How many tasks are executing right now, out of the pool this daemon runs at once.'],
        ['verify lane', `${d.workers.verifying} verifying · ${d.workers.verifyLane} waiting`, 'Finished runs being checked by the review council. They do not hold a worker slot.'],
        ['spent today', `${fmtUsd(d.budget.spentToday)} of ${fmtUsd(d.budget.dailyCapUsd, 2)}`, 'Model spend billed today against the daily cap.'],
      ]));
      return wrap;
    },
    { loading: 'Probing every model and runner…' },
  );

  // --------------------------------------------------------------- latency

  const refreshLatency = () => loadInto(latency.body, () => api('/api/latency'), (d) => {
    if (!d.sampleRuns) {
      return emptyState('No runs to measure yet', 'This reads the stage events of recent runs. Once tasks have run, it says which stage actually costs the wall clock.', { icon: icon('clock') });
    }
    const wrap = el('div', 'stack');
    wrap.appendChild(el('div', 'vsec-note', `${d.sampleRuns} run(s) sampled`));
    wrap.appendChild(table(
      [
        { label: 'stage', desc: 'A step of the pipeline. gate-wait is not the machine at all — it is how long the finished work sat waiting for a human.' },
        { label: 'samples', desc: 'How many runs contributed a measurement for this stage. A run that skips a stage contributes nothing to it.', cls: 'num' },
        { label: 'median', desc: 'The typical duration: half the runs were faster than this.', cls: 'num' },
        { label: 'p90', desc: 'The slow tail: nine runs in ten finished this stage faster than this.', cls: 'num' },
        { label: 'share', desc: 'This stage’s share of a typical end-to-end run, computed from the medians.', cls: 'num' },
      ],
      d.stages.map((s) => [
        s.stage,
        fmtInt(s.count),
        `${fmtInt(s.medianMs)} ms`,
        `${fmtInt(s.p90Ms)} ms`,
        `${s.shareOfTotalPct.toFixed(1)}%`,
      ]),
    ));
    return wrap;
  });

  // ----------------------------------------------------------------- bench

  function renderNoBench(reason) {
    const wrap = el('div', 'stack');
    wrap.appendChild(emptyState(
      'No bench yet',
      'Benchmarking is a command-line job, not a button: it runs a dozen probes against every configured model and takes minutes. Run it once and this fills in.',
      { icon: icon('doctor') },
    ));
    wrap.appendChild(commandBlock(BENCH_COMMAND, 'Copy the benchmark command so you can run it in a terminal.'));
    if (reason) wrap.appendChild(el('p', 'faint', reason));
    return wrap;
  }

  async function refreshBench() {
    clear(bench.body).appendChild(el('p', 'faint', 'Reading the bench…'));
    let report;
    try {
      report = await api('/api/bench');
    } catch (err) {
      clear(bench.body).appendChild(renderNoBench(err.message));
      return;
    }
    const wrap = clear(bench.body);
    const roster = Object.entries(report.roster ?? {});
    const rosterRow = el('div', 'row');
    const label = el('span', 'faint', 'roster:');
    tip(label, 'Roster', 'Which model won each job, chosen from the measurements rather than by reputation: reason and code weigh correctness, fast weighs speed with a floor on instruction-following.');
    rosterRow.appendChild(label);
    for (const [role, alias] of roster) rosterRow.appendChild(chip(`${role}: ${alias}`, 'chip-model', `Roster — ${role}`, `The alias measured best for ${role} work on this machine.`));
    if (!roster.length) rosterRow.appendChild(el('span', 'faint', 'no model scored above zero'));
    wrap.appendChild(rosterRow);

    wrap.appendChild(table(
      [
        { label: 'alias', desc: 'The configured alias that was measured.' },
        { label: 'model', desc: 'The model behind it.' },
        { label: 'score', desc: 'Share of the probe set answered correctly. Deterministic scoring — no model judges another.', cls: 'num' },
        { label: 'reasoning', desc: 'Score on the reasoning probes: syllogism, arithmetic, ordering, negation.', cls: 'num' },
        { label: 'code', desc: 'Score on the code probes: spotting an off-by-one, reading a diff, catching a swallowed error, refusing scope creep.', cls: 'num' },
        { label: 'fidelity', desc: 'Score on instruction-following: does it answer in the shape it was asked to.', cls: 'num' },
        { label: 'tok/s', desc: 'Generation speed, measured over the probe set.', cls: 'num' },
        { label: 'cold start', desc: 'The first call, which includes loading the model from disk.', cls: 'num' },
      ],
      report.models.map((m) => [
        m.alias,
        m.model,
        m.ok ? m.score.toFixed(2) : chip('failed', 'bad', 'Unmeasurable', m.error ?? 'This model could not answer the probes at all.'),
        m.byCategory.reasoning.toFixed(2),
        m.byCategory.code.toFixed(2),
        m.byCategory.fidelity.toFixed(2),
        m.tokensPerSec.toFixed(1),
        `${fmtInt(m.coldStartMs)} ms`,
      ]),
    ));
    wrap.appendChild(el('p', 'faint', `Measured ${new Date(report.measuredAt).toLocaleString()} · re-run with: ${BENCH_COMMAND}`));
  }

  // --------------------------------------------------------------- improve

  const proposalBox = el('div', 'stack');

  function renderProposal(proposal, queued) {
    const wrap = clear(proposalBox);
    if (proposal.degraded) {
      wrap.appendChild(banner('warn', 'The proposing model was unavailable', 'This is the fallback proposal, assembled from the documented limitations rather than reasoned from the evidence.'));
    }
    const card = el('div', 'card');
    card.appendChild(el('h3', null, proposal.title));
    card.appendChild(kvs([
      ['area', proposal.area, 'Which part of the system this change touches.'],
      ['rationale', proposal.rationale, 'Why the evidence says this is the highest-value fix right now.'],
    ]));
    const briefTitle = el('div', 'section-title', 'Worker brief');
    tip(briefTitle, 'Worker brief', 'The exact prompt the worker would be handed. It is written to be verifiable by the project’s own test suite.');
    card.appendChild(briefTitle);
    card.appendChild(el('div', 'brief', proposal.prompt));
    wrap.appendChild(card);

    if (queued) {
      wrap.appendChild(banner('ok', `Queued "${queued.title}"`, 'It is in the queue now and lands at your gate like any other task — self-improvement gets no shortcut past the approval step.'));
      return;
    }
    wrap.appendChild(actionBar([button({
      label: 'Queue it',
      icon: 'plus',
      variant: 'primary',
      desc: 'Queues a self-improvement task. The daemon re-reads its evidence as it queues, so the brief shown after this click — not the one above — is what the worker was actually given.',
      run: async () => {
        const r = await post('/api/improve', { confirm: true });
        renderProposal(r.proposal, r.queued);
        return r;
      },
      ok: (r) => `Queued "${r.queued?.title ?? 'improvement'}"`,
    })]));
  }

  const proposeBtn = button({
    label: 'Propose improvement',
    icon: 'bolt',
    variant: 'primary',
    desc: 'Spends one model call reading the daemon’s own failure evidence and proposing a single change to itself. Nothing is queued until you say so.',
    run: async () => {
      clear(proposalBox).appendChild(el('p', 'faint', 'Reading the evidence — failures, rejections, quarantines, slow kinds…'));
      const r = await post('/api/improve', {});
      renderProposal(r.proposal, null);
      return r;
    },
  });

  improve.head.appendChild(actionBar([proposeBtn]));
  proposalBox.appendChild(emptyState(
    'No proposal yet',
    'This costs a model call, so it only runs when you ask. It reads what has actually gone wrong here — not a generic best-practices list.',
    { icon: icon('bolt') },
  ));
  improve.body.appendChild(proposalBox);

  void refreshHealth();
  void refreshLatency();
  void refreshBench();

  if (wantImprove) {
    wantImprove = false;
    improve.node.scrollIntoView({ block: 'nearest' });
    proposeBtn.focus();
    // Every other palette intent is free to fire on mount; this one spends a
    // real model call, so it stops short of the click and leaves the actual
    // spend to a second, deliberate press of the button.
    toast.info('Press "Propose improvement" to spend one model call and read the evidence.');
  }
  return undefined;
}
