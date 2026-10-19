#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, daemonUrl } from './config.ts';
import { humanDuration, sweepJails } from './archive.ts';
import {
  backupIfDue, backupMb, backupNow, backupSettings, requireNoInterruptedRestore, restoreFrom, sameDiskWarning,
} from './backup.ts';
import { approvals, pruneStaleMainWorktrees } from './gate.ts';
import { runDrill } from './drill.ts';
import { localOnly, modeSummary } from './localOnly.ts';
import { sandboxMode, sandboxSummary, selfTest } from './security/sandbox.ts';
import { probeCloud } from './models.ts';
import { skillVariantFor, tierModel } from './roles.ts';
import { workerSuiteInJail } from './doctorJail.ts';
import { formatSkillList, skillBlock, skillsDoctorLine, skillsFor } from './skills.ts';
import { acquireDaemonLock } from './lock.ts';
import { Store } from './queue.ts';
import { Scheduler } from './scheduler.ts';
import { listen } from './server.ts';
import { Tracer } from './trace.ts';
import { benchModels, benchPath } from './bench.ts';
import { Broker } from './budget.ts';
import { checkOllamaParallelism, prewarmRoster, warmTargets } from './warm.ts';
import { computeLatencyReport, formatDuration } from './latency.ts';
import { formatPlaybookWarning, getPlaybook, playbooksDir } from './playbooks.ts';
import { planNoteHome } from './assistant/crewPlan.ts';
import { crewAdvisories, formatDroppedIssues } from './verify/crewReview.ts';
import { chairRuled } from './verify/council.ts';
import { auditDir, auditHasBans, formatAuditReport } from './prose/audit.ts';
import { bookTitleFrom, docxToText, splitChapters } from './prose/ingest.ts';
import type { Decision, Task } from './types.ts';
import { carriedSkills } from './skills.ts';
import { openLedgerForReceipt, openLedgerReadOnly, runDebrief, renderShort } from './debrief.ts';

const USAGE = `foreman — parallel agent mission control

  foreman serve                          start the daemon + board
  foreman stop                            stop the daemon and wait for it to exit (${daemonUrl(config.host, config.port)})
  foreman add <title> --prompt <text>     queue a task
        [--kind code|writing|research|general] [--runner echo|shell|claude-code|codex-cli|api]
        [--repo <path>] [--priority N] [--after <id>[,<id>]] [--sensitivity S0|S1|S2]
        [--budget <usd>] [--test-cmd <cmd>] [--no-merge] [--repairs N] [--agent <alias>]
        [--role <r>] [--playbook <p>] [--assignee ai|human]
        [--skills <a>[,<b>]]              skills for this ticket in place of its role's default: at most 2,
                                          from the role's list (foreman skills); needs --playbook and --role
  foreman ls [--all]                      list tasks (default hides closed ones)
  foreman assign <taskId> ai|human        who does the work (default ai; human parks it on your desk)
  foreman gate <taskId>|--waiting|--house owner|human
                                          who DECIDES at the gate. --waiting hands the current
                                          backlog to the owner model; --house does it for new work
                                          too. Green work only — see the note it prints.
  foreman archive [<query>]               closed work older than a week, with what it actually cost
        archive sweep [--days N]          fold closed tasks in now instead of waiting for the hourly sweep
        archive estimate "<ask>" [--role <r>] [--playbook <p>]
                                          how long work of this shape really took, from measurements
        archive unarchive <taskId>        put one back in the Closed lane
  foreman show <taskId>                   task detail, its skills, artifacts, the decisions recorded on it, recent activity
  foreman approve <taskId> [--note <text>] accept the staged artifacts (waits for the merge and its check)
                                          --as-is <tree sha> lands work that changed after its review, by naming
                                          the tree to land (the refusal prints it)
        [--corrected | --clean]           for the record only: the work needed a fix beyond the reviewed diff (say, a
                                          patch you landed by hand right after), or it did not. Neither = not stated.
                                          An --as-is landing of a tree other than the reviewed one is recorded as
                                          corrected whatever is said here.
        [--review-source <text>]          for the record only: who verified it, at most 200 characters
                                          (e.g. "independent reviewer, verify 3040/0/1")
  foreman reject <taskId> [--note <text>] reject them
  foreman cancel <taskId> [--note <text>] stop a queued or running task; the note says why, for the record
                                          Every approve, reject, cancel, retry and reopen is one row in the ledger's
                                          \`decisions\` table (never changed afterwards); each prints what was recorded.
  foreman retry <taskId> [--note <text>]  requeue an ended task; the note is binding on the worker and every reviewer
        [--skills <a>[,<b>]|default]      requeue it with other skills, or back on its role's default
  foreman reopen <taskId> [--note <text>] put a task that FAILED review back at the human gate, work intact, for you
                                          to decide (e.g. you ran the live checks yourself)
  foreman reverify <taskId>... | --split  re-run the REVIEW on work already done, keeping the work.
                                          --split takes every task parked on a split verdict
  foreman rm <taskId>                     delete a task
  foreman watch                           live table in the terminal
  foreman tools ls|show|rm|quarantine|release [<name>]   the forged-tool catalog
  foreman prune [--days N] [--keep-deps N] reclaim worktrees, branches, old ledger rows, dep caches
  foreman trace <taskId>                  full JSON reconstruction of a task
  foreman service                         print a launchd plist for this install
  foreman backup [--to <dir>]             one verified, gzipped copy of the database, now (the daemon
                                          takes one a day by itself; keeps 7 dailies + 4 weeklies,
                                          in the copy dir too)
  foreman restore <file.gz>               replace the database with a backup; refuses while the daemon
                                          runs or if the file is not a Foreman database, and moves
                                          the current one aside as foreman.db.before-restore-<ts>
  foreman demo                            seed a mixed batch against the echo runner
  foreman agreement                       how often the LOCAL reviewer would have decided what the
                                          cloud reviewer did — the evidence for retiring the cloud
                                          gate. Needs FOREMAN_SHADOW_LOCAL=1 while cloud still runs.
  foreman drill [--capability|--plumbing]  local-only readiness: narrow probes with answers a
                                          program can check, not a model's opinion. Exits non-zero
                                          on a failure, so it can gate a cutover.
  foreman doctor [--bench] [--latency [--n N]]   probe models, runners, agents, budget
                                          --bench scores each local model and re-points the roster
                                          --latency prints median/p90 per-stage duration over the last N runs (default 20)
  foreman receipts [<taskId>]             spend ledger (today, or one task)
  foreman verdict <taskId>                council opinions for a task
  foreman ask "<what you want>" [--repo <path>] [--yes]   plan it, then queue it
  foreman build "<ask>" [--repo <path>] [--playbook <id>] [--auto] [--from-epic <id>] [--check|--no-check] [--revise] [--gate human|owner]
                                          plan a crew epic (owner decomposes it), then queue it
                                          --auto refuses to queue if plan checking found a blocking issue
                                          --gate owner lets the owner model approve the epic's green tickets
  foreman improve [--area X] [--yes] [--allow-core]       let Foreman work on Foreman
  foreman debrief <epicId|taskId> [--notes <file>]... [--no-model] [--json] [--max-usd N]
                                          what one finished epic (or one ticket) shows: per ticket the runs, skills
                                          carried, reviews, repair rounds, operator actions, failures by cause and
                                          where the gate disagreed with the review, read from the ledger, traces and
                                          run logs (no daemon, no model). The ledger's own records come first (the
                                          decisions table: who decided, the note, --corrected / --clean; a run's turns,
                                          how it ended, what was cut from its brief); a ticket from before them is
                                          read from the approval note's wording, and the report says which. Then ONE model call sorts it into findings
                                          with quoted evidence and at most 3 proposals. Writes nothing but its own files
                                          ($FOREMAN_HOME/debriefs/<id>.md and .json) and the spend receipt of its model
                                          call: the proposals are suggestions for a person. --notes attaches review
                                          notes kept outside the ledger as data (never instructions; on an S1 epic they
                                          go to the hosted model with the rest); --no-model skips the call, and then the
                                          ledger is opened read-only. The call costs about US$0.55 for a 19-ticket epic
                                          and is not made when its estimate is above --max-usd (default 1); its spend
                                          receipt (a row in the ledger's receipts table per attempt, where Foreman's own
                                          spend report reads it) is the one thing this command writes to the ledger, and
                                          it runs no schema statement on it.
                                          An S2 epic is diagnosed on a local model or not at all. Turning a proposal
                                          into a pending skill edit with a replay measurement is not built yet.
  foreman align extract|build|train|status                LoRA alignment on your own history
  foreman persona init|ls|build|set <id>|train <id>|adopt <id>|retire <id>|serve <id> [--stop]|lock
        persona ingest <id> --manuscript <dir>[,<dir>...] [--style <file>] [--replace] [--keep-tics]
                                          train an author persona on the work itself — the corpus
                                          mined from session history teaches it to write REPORTS
                                          about drafting, not to draft
                                          per-role local models: one corpus and one adapter per
                                          playbook role, trained in the background (suspended
                                          whenever foreman has work in flight), routed only once
                                          adopted
  foreman memory [--scope <s>] | memory add <key> <value> | memory rm <id> | memory consolidate
  foreman schedule add <title> --spec "weekly sun 09:00" (--prompt <t> | --ask "<req>" | --improve)
  foreman schedule ls | schedule rm <id> | schedule toggle <id>
  foreman prose audit <dir> [--json] [--strict]   manuscript audit (no daemon); exits 1 on a
                                          ban-level finding, or on any finding with --strict
  foreman prose import <file> --out <dir> .docx/.md/.txt -> chapter-NN-<slug>.md (+ front-matter.md)
  foreman crew init                       copy the repo's seed playbooks into $FOREMAN_HOME/playbooks
  foreman crew report                     per-role delivery, first-review pass rate and spend, with
                                          advisory tier suggestions (zero tokens; never edits a playbook)
  foreman playbooks                       list loaded playbooks (roles, reviewer chain) + refused ones
  foreman skills                          list loaded skills (roles, status, bytes) + refused ones, and
                                          the loadouts; reads FOREMAN_SKILLS_DIR, needs no daemon
  foreman skills show <playbook> <role> [--variant full|card]
                                          print exactly the skills block that role's brief carries
  foreman playbook forge "<domain>" [--ask "<request>"]   draft a playbook for a domain nothing covers
  foreman playbook pending                drafts awaiting your approval
  foreman playbook approve|reject <id>    install a draft, or delete it

Env: FOREMAN_HOME, FOREMAN_PORT, FOREMAN_MAX_WORKERS, FOREMAN_DB, FOREMAN_CLAUDE_BIN,
     FOREMAN_MAX_VERIFIES=2 (full test suites at once: Foreman's, and a worker's via src/verify/testSlot.ts),
     FOREMAN_REVERT_TESTS=on (default off; anything but on/off refuses to start). After a code ticket's tests pass, each
     test its diff adds or changes is run with the diff's non-test files put back to the base, and the reviewer and the
     owner gate get a per-test table: fails / passes / could not run without the change. A reviewer aid only: no
     repair, no hold. Stored as <run>.revert-tests.json (foreman show, foreman debrief).
     FOREMAN_SLOT_WAIT_CREDIT_MS=1800000 (how much of a worker's own wait for a test slot is not charged to its run),
     FOREMAN_CLAUDE_CONFIG_DIR (a claude-code worker's own CLAUDE_CONFIG_DIR; default $FOREMAN_HOME/claude-config),
     FOREMAN_CLAUDE_ENV_ALLOW (extra variable names a claude-code worker inherits, comma-separated; its env is an allowlist),
     FOREMAN_DAILY_USD_CAP, FOREMAN_VERIFY=off, FOREMAN_OLLAMA_URL, FOREMAN_GATEWAY_URL,
     FOREMAN_CREW_REVIEW=always|escalate (always skips the local council when the crew chain answers),
     FOREMAN_GATE_BATCH=off (one owner-gate call per ticket instead of one per epic batch),
     FOREMAN_LOCAL_ONLY=auto|1|0 (auto: fall back to local models while the Claude CLI is signed out),
     FOREMAN_MODEL_ROUTER (Claude model for ambiguous playbook classification; default haiku),
     FOREMAN_DOWNSHIFT=off (never step a local model down when it does not fit in memory),
     FOREMAN_PAGING_ALLOWANCE_GB (default 7), FOREMAN_RECHECK_MS (re-check provisional reviews; default 60000),
     FOREMAN_SKILLS_DIR (a skills repository; unset = no skills in any brief), FOREMAN_SKILL_BRIEF_BYTES (9000),
     FOREMAN_BACKUP=off (no daily database backup), FOREMAN_BACKUP_DIR (default $FOREMAN_HOME/backups),
     FOREMAN_BACKUP_COPY_DIR (a second copy of each backup; point it at ANOTHER disk or a synced
     folder — never at a git repository that is pushed anywhere),
     FOREMAN_SANDBOX=off|tests|all (default tests: test commands, playbook checks, shell tickets, run_shell, use_tool and
     the post-merge check run under sandbox-exec — they write only their jail and a private temp/home, read nothing
     under /Users but the jail (and, read-only, a worktree jail's real .git), and cannot reach the daemon's port. The claude-code worker itself is NOT sandboxed
     yet; all behaves as tests. off = no sandbox, the rollback. If sandbox-exec cannot be used the run fails,
     and serve refuses to start),
     FOREMAN_SANDBOX_RO (up to 4 extra read-only trees for sandboxed commands, colon-separated; one that is or contains
     /Users, your home, a temp dir, Foreman's home or the real repository is refused — name the subtree),
     FOREMAN_SANDBOX_DENY_PORTS (up to 4 loopback ports closed besides the daemon's; default 8000,8001,8002,3010),
     FOREMAN_SANDBOX_ALLOW=fsevents (file watching inside the sandbox; off by default — Kiln's gate needs it; see README)
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i++;
      }
    } else out._.push(arg);
  }
  return out;
}

const flagStr = (args: Args, key: string): string | undefined => {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
};

const base = daemonUrl(config.host, config.port);

/** `--skills a,b` as a list; `--skills default` as null (the role's default); undefined when the flag is absent. */
function skillsFlag(args: Args): string[] | null | undefined {
  const raw = args.flags['skills'];
  if (raw === undefined) return undefined;
  const names = typeof raw === 'string' ? [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))] : [];
  if (!names.length) throw new Error('--skills takes one or two skill names, comma-separated (see: foreman skills), or `default`');
  return names.length === 1 && names[0] === 'default' ? null : names;
}

/**
 * The daemon decides whether a ticket may carry the skills asked for, and
 * refuses with the reason. What it cannot do is refuse a field it does not
 * know: a daemon still running a build from before per-ticket skills queues
 * the ticket and drops the list unseen. So the answer is read back, and a
 * ticket that did not get what was asked is canceled rather than left to run
 * on the wrong procedures.
 */
async function assertSkillsStored(task: { id: string; skills?: string[] | null }, wanted: string[] | null): Promise<void> {
  const got = task.skills?.length ? task.skills : null;
  if (JSON.stringify(got) === JSON.stringify(wanted)) return;
  await apiCall(`/api/tasks/${task.id}/cancel`, { method: 'POST' });
  throw new Error(
    `the daemon at ${base} did not store --skills for ${task.id} (it holds: ${got ? got.join(', ') : 'none'}). ` +
      'It is running a build from before per-ticket skills — restart it. ' +
      `${task.id} was canceled so it cannot run on the wrong skills; nothing else changed.`,
  );
}

/** The skills line of `foreman show`: the ticket's own list, else its role's default as this shell's skills dir has it. */
function skillsLine(task: Pick<Task, 'playbook' | 'role' | 'agent' | 'skills'>): string {
  if (task.skills?.length) return `skills: ${task.skills.join(', ')} (named on the ticket)\n`;
  if (!config.skillsDir || !task.playbook || !task.role || task.agent) return '';
  const pb = getPlaybook(task.playbook);
  if (!pb?.roles[task.role]) return '';
  const names = carriedSkills(pb, task.role).skills.map((s) => s.name);
  return names.length ? `skills: role default: ${names.join(', ')}\n` : '';
}

const shortTree = (tree: string | null | undefined): string => (tree ? tree.slice(0, 12) : 'none');
const yesNo = (v: boolean | null | undefined, unknown = 'not stated'): string => (v == null ? unknown : v ? 'yes' : 'no');

/** One decision as `foreman show` and the confirmation line print it: action, who, corrected, the trees short, the note's head. */
function decisionLine(d: Decision): string {
  const parts = [`${d.action} by ${d.actor}`];
  if (d.action === 'approve') {
    parts.push(`corrected: ${yesNo(d.corrected)}${d.correctedSource ? ` (${d.correctedSource === 'trees' ? 'the trees differ' : 'stated'})` : ''}`);
    parts.push(`merged: ${yesNo(d.merged, 'n/a')}${d.asIs ? ' (--as-is)' : ''}`);
    parts.push(`reviewed ${shortTree(d.reviewedTree)} → landed ${shortTree(d.landedTree)}`);
    if (d.reviewSource) parts.push(`verified by: ${d.reviewSource}`);
  }
  if (d.statusAfter) parts.push(`→ ${d.statusAfter}`);
  const note = d.note ? d.note.replace(/\s+/g, ' ').trim() : '';
  parts.push(note ? `note: ${note.length > 120 ? `${note.slice(0, 120)}…` : note}${d.noteCutBytes ? ` (${d.noteCutBytes} bytes not stored)` : ''}` : 'no note');
  return parts.join('; ');
}

/**
 * The line that confirms what the ledger recorded for a decision just made,
 * from the row the daemon answered with. A daemon running a build from before
 * the decisions table answers without one and ignores --corrected, --clean and
 * a cancel's --note unseen: that is said, loudly, instead of being confirmed.
 */
function recordedLine(cmd: string, decision: Decision | null | undefined): string {
  if (decision && typeof decision === 'object' && decision.id) return `recorded ${decision.id}: ${decisionLine(decision)}\n`;
  return `NOT RECORDED: the daemon at ${base} answered without a decision record for this ${cmd} ` +
    '(a build from before the decisions ledger, or the ledger refused the row — see `foreman show`). ' +
    `The ${cmd} itself took effect; what you stated about it (--corrected, --clean, --review-source, a cancel\'s --note) was not kept.\n`;
}

/** `--corrected` / `--clean` as the approve route takes them: true, false, or undefined when neither was given. */
function correctedFlag(args: Args): boolean | undefined {
  for (const key of ['corrected', 'clean']) {
    if (typeof args.flags[key] === 'string') {
      throw new Error(`--${key} takes no value (it read "${String(args.flags[key])}" as one): put it after the task id or before another flag`);
    }
  }
  const corrected = args.flags['corrected'] === true;
  const clean = args.flags['clean'] === true;
  if (corrected && clean) throw new Error('--corrected and --clean say opposite things: give one, or neither (not stated)');
  return corrected ? true : clean ? false : undefined;
}

/** `--corrected` / `--clean` on a reject, retry or reopen: refused before anything is sent — they used to be dropped unseen. */
function refuseCorrectedFlags(args: Args, cmd: string): void {
  for (const key of ['corrected', 'clean']) {
    if (args.flags[key] !== undefined) {
      throw new Error(
        `--${key} goes with approve: it records whether APPROVED work needed a correction, and means nothing on a ${cmd}. ` +
        `Nothing was done; run \`foreman ${cmd}\` again without it.`,
      );
    }
  }
}

/**
 * For requests the daemon answers only after a model call — planning above
 * all. `fetch` gives up on a response whose headers take longer than 300s
 * (undici's headersTimeout, not settable without undici itself), and a
 * planner given a repo snapshot legitimately takes longer than that; the
 * daemon would finish the plan and nobody would be listening. node:http has
 * no such ceiling, so this waits as long as the daemon's own timeouts allow.
 */
function apiCallLong(path: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let parsed: any = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON error page */ }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) reject(new Error(parsed.error ?? `${status} ${res.statusMessage ?? ''}`.trim()));
        else resolve(parsed);
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'ECONNREFUSED'
        ? `cannot reach foreman at ${base} — is 'foreman serve' running?`
        : `cannot reach foreman at ${base}: ${err.code ?? err.message}`));
    });
    req.end(payload);
  });
}

async function apiCall(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch (err) {
    // A bare `catch {}` here reported every failure as "is foreman serve
    // running?" — including a request to a daemon that was demonstrably up and
    // forty minutes into its uptime. Six re-reviews were reported as a dead
    // daemon when what actually happened was undici abandoning a request whose
    // response took longer than its 300s header timeout. Chasing a phantom
    // crash cost more than carrying the cause would have.
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    if (cause === 'UND_ERR_HEADERS_TIMEOUT' || cause === 'UND_ERR_BODY_TIMEOUT') {
      throw new Error(
        `foreman at ${base} did not answer in time (${cause}). The daemon is probably fine and still ` +
        `working — long operations should not be waited on over one request.`,
      );
    }
    if (cause && cause !== 'ECONNREFUSED') {
      throw new Error(`cannot reach foreman at ${base}: ${cause}`);
    }
    throw new Error(`cannot reach foreman at ${base} — is 'foreman serve' running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/^(chapter|prologue|epilogue|part)\b/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

/** Greedy wrap for the one place the CLI prints a paragraph rather than a row. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** How long `reverify` waits for one review before giving up on watching it. */
const REVERIFY_POLL_MS = Number(process.env['FOREMAN_REVERIFY_WAIT_MS'] ?? 900_000);

const PAD = { id: 14, status: 18, runner: 12, who: 6 };
function taskLine(
  t: Task & { run?: { stage?: string; progress?: number; costUsd?: number } | null; resolvedAssignee?: string },
): string {
  const run = t.run;
  const pct = run && ['running', 'verifying'].includes(t.status) ? ` ${Math.round((run.progress ?? 0) * 100)}%` : '';
  const stage = run && ['running', 'verifying'].includes(t.status) ? ` ${run.stage}` : '';
  // The snapshot resolves the assignee (playbook + env are server-side state);
  // the raw column is only the explicit per-task override, so it is the
  // fallback, not the answer.
  const who = t.resolvedAssignee ?? t.assignee ?? 'ai';
  return [
    t.id.padEnd(PAD.id),
    t.status.padEnd(PAD.status),
    who.padEnd(PAD.who),
    t.runner.padEnd(PAD.runner),
    (stage + pct).padEnd(12),
    t.title,
  ].join(' ');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.flags['help']) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Worker ledger guard. A worker session carries its run id (runners/cliRunners.ts workerEnv); the ledger is the
  // daemon's, and a worker's `foreman ls`, `add` or `restore` would open it (or make a new one) from inside a ticket.
  // Nothing below runs, so nothing is opened, created or locked. (verify/testSlot.ts is not this file.)
  if (process.env['FOREMAN_RUN_ID']?.trim()) {
    process.stderr.write(
      `foreman: worker ledger guard: \`foreman ${cmd}\` is refused inside a worker run (FOREMAN_RUN_ID is set); ` +
        'the ledger belongs to the daemon. Run the suite through the slot wrapper your brief names (src/verify/testSlot.ts), ' +
        'and report what you need to the operator.\n',
    );
    return 2;
  }

  // A restore killed between its two renames leaves no database, only the old
  // one under its set-aside name. Every command that opens the store would
  // make an empty one in its place, so none of them runs until that is
  // settled. `restore` says the same thing itself; `stop` touches no database.
  if (cmd !== 'restore' && cmd !== 'stop') requireNoInterruptedRestore(config.dbPath);

  if (cmd === 'serve') {
    // FOREMAN_SANDBOX (security/sandbox.ts), before anything is opened: an unknown value, a sandbox-exec that is
    // missing or does not confine, is a refusal to start — never a daemon that quietly runs test commands unconfined.
    const sandboxProblem = await selfTest();
    if (sandboxProblem) {
      process.stderr.write(`foreman: ${sandboxProblem}\n`);
      return 1;
    }
    const releaseLock = acquireDaemonLock();
    const store = new Store(config.dbPath);
    const scheduler = new Scheduler(store);
    const tracer = new Tracer(store);
    tracer.start();
    // Before the first tick: under FOREMAN_LOCAL_ONLY=auto (the default) the
    // cloud's reachability decides how every ticket routes, so it must be
    // known before anything is dispatched — and re-checked, so a sign-in (or
    // a lapse) takes effect without a restart.
    await probeCloud().catch(() => null);
    process.stdout.write(`home ${config.home}\n`);
    process.stdout.write(`mode ${modeSummary()}\n`);
    process.stdout.write(`${await sandboxSummary()}\n`);
    if (sandboxMode() === 'all') {
      process.stdout.write('FOREMAN_SANDBOX=all: the claude-code worker is not sandboxed in this build; `all` behaves as `tests`\n');
    }
    let lastMode = modeSummary();
    const cloudTimer = setInterval(() => {
      void probeCloud().catch(() => null).then(() => {
        if (modeSummary() !== lastMode) {
          lastMode = modeSummary();
          process.stdout.write(`${new Date().toLocaleTimeString()} mode changed: ${lastMode}\n`);
        }
      });
    }, 5 * 60_000);
    cloudTimer.unref();
    // A crash mid post-merge check leaves its foreman-main-* worktree
    // registered; nothing of ours is running yet, so any left is stale.
    let closing = false;
    const staleMain = await pruneStaleMainWorktrees(store).catch(() => []);
    if (staleMain.length) process.stdout.write(`pruned ${staleMain.length} stale post-merge check worktree(s)\n`);
    // Landed work's worktrees are just disk once it is a few days old; reclaim
    // them on the hour, a bounded batch at a time (see sweepJails).
    let sweeping = false;
    const sweep = (): void => {
      if (sweeping || closing) return;
      sweeping = true;
      void sweepJails(store)
        .then((r) => {
          if (r.removed.length) {
            process.stdout.write(`${new Date().toLocaleTimeString()} reclaimed ${r.removed.length} finished worktree(s)\n`);
          }
          // A failed task's worktree past its bound that could not go: said, so a work directory that keeps growing has a reason.
          if (r.keptNoDiff.length) {
            process.stdout.write(
              `${new Date().toLocaleTimeString()} kept ${r.keptNoDiff.length} old worktree(s) of failed tasks: no diff artifact to recover the work from ` +
              '(`foreman prune` drops them by hand)\n',
            );
          }
        })
        .catch(() => {})
        .finally(() => { sweeping = false; });
    };
    const jailTimer = setInterval(sweep, 3_600_000);
    jailTimer.unref();
    const firstSweep = setTimeout(sweep, 60_000);
    firstSweep.unref();
    // The database is the only copy of memory, receipts, verdicts and run
    // decisions. One verified archive a day; the hourly tick is a no-op once
    // today's exists. The first check comes a minute in, not an hour, so a
    // daemon that is restarted often still gets its backup.
    const backup = backupSettings();
    const sameDisk = backup.enabled ? sameDiskWarning(backup) : null;
    if (sameDisk) process.stdout.write(`${sameDisk}\n`);
    let backingUp = false;
    const backupTick = (): void => {
      if (backingUp || closing || !backup.enabled) return;
      backingUp = true;
      void backupIfDue({
        dbPath: config.dbPath,
        dir: backup.dir,
        copyDir: backup.copyDir,
        record: (type, message) => {
          store.record({ type, message });
          process.stdout.write(`${new Date().toLocaleTimeString()} ${message}\n`);
        },
      }).finally(() => { backingUp = false; });
    };
    const backupTimer = setInterval(backupTick, 3_600_000);
    backupTimer.unref();
    const firstBackup = setTimeout(backupTick, 60_000);
    firstBackup.unref();
    scheduler.start();
    // Warm rung-0 in the background: the first review otherwise pays a cold
    // load for both advisors, serialised by the VRAM guard.
    void prewarmRoster({ onLine: (line) => process.stdout.write(`${line}\n`) }).catch(() => {});
    const server = await listen(store, scheduler);
    process.stdout.write(
      `foreman up — board ${daemonUrl(config.host, config.port)}  db ${config.dbPath}  workers ${config.maxWorkers}\n` +
        `trace ${tracer.path}\n`,
    );
    const shutdown = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      process.stdout.write('\nstopping…\n');
      try {
        clearInterval(jailTimer);
        clearTimeout(firstSweep);
        clearInterval(backupTimer);
        clearTimeout(firstBackup);
        server.close();
        // Claim nothing more: the drain below can take a minute, and a worker
        // started now would only be aborted by stop() at its end.
        scheduler.pauseDispatch();
        // No new approvals; post-merge checks aborted (and recorded as such);
        // a merge already under way is let finish, up to a hard cap, so the
        // operator's repo is never left mid-merge.
        const stuck = await approvals.shutdown();
        if (stuck) {
          process.stdout.write(`${stuck} approval(s) still landing after the shutdown cap; exiting anyway — check \`git status\` in their repos\n`);
        }
        await scheduler.stop();
      } catch (err) {
        process.stderr.write(`shutdown: ${(err as Error).message}\n`);
      } finally {
        // Last, so the stop's own events reach the trace before its final flush;
        // and always, so a failed step still leaves the trace and the lock settled.
        tracer.stop();
        try {
          store.close();
        } catch {
          /* already closed or never usable; the lock still goes */
        }
        releaseLock();
        process.exit(0);
      }
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    // A hangup (the terminal or the app that started the daemon went away) ends it the same orderly way: without a
    // listener SIGHUP would kill it outright, skipping the lock release, the trace flush and the 'exit' handlers.
    process.on('SIGHUP', () => void shutdown());
    return -1; // stay alive
  }

  if (cmd === 'stop') {
    const pidFile = path.join(config.home, 'daemon.pid');
    let holder = NaN;
    try {
      holder = Number(fs.readFileSync(pidFile, 'utf8').trim());
    } catch {
      process.stdout.write(`no daemon pidfile at ${pidFile}\n`);
      return 0;
    }
    if (!Number.isInteger(holder) || holder <= 0) throw new Error(`unreadable pidfile: ${pidFile}`);
    try {
      process.kill(holder, 'SIGTERM');
    } catch {
      process.stdout.write(`daemon ${holder} was not running; clearing a stale pidfile\n`);
      fs.rmSync(pidFile, { force: true });
      return 0;
    }
    // Shutdown aborts in-flight runs and escalates to SIGKILL, so give it room.
    // It also lets an in-flight merge finish (up to APPROVAL_DRAIN_CAP_MS).
    const deadline = Date.now() + 90_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        process.kill(holder, 0);
      } catch {
        process.stdout.write(`daemon ${holder} stopped\n`);
        return 0;
      }
      if (Date.now() > deadline) {
        process.stderr.write(`daemon ${holder} is still shutting down after 90s; check ${config.home}\n`);
        return 1;
      }
    }
  }

  switch (cmd) {
    case 'backup': {
      // Runs with or without the daemon: the copy is taken through a
      // read-only connection, so a live daemon is not disturbed.
      const settings = backupSettings();
      const to = flagStr(args, 'to');
      if (args.flags['to'] !== undefined && !to) throw new Error('usage: foreman backup [--to <dir>]');
      const r = await backupNow({
        dbPath: config.dbPath,
        dir: to ? path.resolve(to) : settings.dir,
        copyDir: settings.copyDir,
      });
      process.stdout.write(`backup: ${r.file} ${backupMb(r.bytes)} MB\n`);
      if (settings.copyDir) {
        process.stdout.write(r.copied ? `copied to ${settings.copyDir}\n` : `NOT copied — ${r.copyError ?? 'copy failed'}\n`);
        if (r.copied && r.copyError) process.stdout.write(`${r.copyError}\n`);
      }
      if (r.pruned.length) process.stdout.write(`pruned ${r.pruned.length}: ${r.pruned.join(', ')}\n`);
      if (r.copyPruned.length) {
        process.stdout.write(`pruned ${r.copyPruned.length} in ${settings.copyDir}: ${r.copyPruned.join(', ')}\n`);
      }
      const sameDisk = sameDiskWarning(settings);
      if (sameDisk) process.stderr.write(`${sameDisk}\n`);
      return 0;
    }
    case 'restore': {
      const file = args._[1];
      if (!file) throw new Error('usage: foreman restore <file.gz>');
      const r = await restoreFrom({ file: path.resolve(file), dbPath: config.dbPath, home: config.home });
      process.stdout.write(
        `restored ${r.dbPath} from ${path.resolve(file)}\n` +
          (r.aside ? `the previous database is at ${r.aside}\n` : ''),
      );
      return 0;
    }
    case 'add': {
      const title = args._.slice(1).join(' ').trim();
      const prompt = flagStr(args, 'prompt') ?? title;
      if (!title) throw new Error('usage: foreman add <title> --prompt <text>');
      const after = flagStr(args, 'after');
      const skills = skillsFlag(args) ?? null;
      const task = await apiCall('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title,
          prompt,
          kind: flagStr(args, 'kind'),
          runner: flagStr(args, 'runner'),
          repo: flagStr(args, 'repo') ?? null,
          sensitivity: flagStr(args, 'sensitivity'),
          agent: flagStr(args, 'agent') ?? null,
          priority: Number(flagStr(args, 'priority') ?? 0),
          budgetUsd: flagStr(args, 'budget') === undefined ? null : Number(flagStr(args, 'budget')),
          testCmd: flagStr(args, 'test-cmd') ?? null,
          role: flagStr(args, 'role') ?? null,
          playbook: flagStr(args, 'playbook') ?? null,
          allowCore: Boolean(args.flags['allow-core']),
          assignee: flagStr(args, 'assignee') ?? null,
          mergeOnApprove: args.flags['no-merge'] ? false : undefined,
          maxRepairs: flagStr(args, 'repairs') === undefined ? undefined : Number(flagStr(args, 'repairs')),
          deps: after ? after.split(',').map((s) => s.trim()).filter(Boolean) : [],
          ...(skills ? { skills } : {}),
        }),
      });
      if (skills) await assertSkillsStored(task, skills);
      process.stdout.write(`${task.id}  ${task.status}  ${task.title}${skills ? `  skills: ${skills.join(', ')}` : ''}\n`);
      return 0;
    }
    case 'assign': {
      const taskId = args._[1];
      const to = args._[2];
      if (!taskId || (to !== 'ai' && to !== 'human')) {
        throw new Error('usage: foreman assign <taskId> ai|human');
      }
      const task = await apiCall(`/api/tasks/${taskId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assignee: to }),
      });
      process.stdout.write(`${task.id}  ${task.status}  → ${to}\n`);
      return 0;
    }
    case 'archive': {
      const sub = args._[1] ?? 'ls';
      if (sub === 'sweep') {
        const days = flagStr(args, 'days');
        const r = await apiCall('/api/archive', {
          method: 'POST',
          body: JSON.stringify(days === undefined ? {} : { days: Number(days) }),
        });
        process.stdout.write(`archived ${r.archived} closed task(s)\n`);
        return 0;
      }
      if (sub === 'unarchive') {
        const taskId = args._[2];
        if (!taskId) throw new Error('usage: foreman archive unarchive <taskId>');
        await apiCall(`/api/tasks/${taskId}/unarchive`, { method: 'POST', body: '{}' });
        process.stdout.write(`${taskId} back in the Closed lane\n`);
        return 0;
      }
      if (sub === 'estimate') {
        const text = args._.slice(2).join(' ').trim();
        if (!text) throw new Error('usage: foreman archive estimate "<what you are about to queue>"');
        const params = new URLSearchParams({ q: text });
        const role = flagStr(args, 'role');
        const playbook = flagStr(args, 'playbook');
        if (role) params.set('role', role);
        if (playbook) params.set('playbook', playbook);
        const r = await apiCall(`/api/archive?${params}`);
        const e = r.estimate;
        if (!e.samples) {
          process.stdout.write('no comparable archived work — nothing to estimate from\n');
          return 0;
        }
        process.stdout.write(
          `from ${e.samples} similar archived task(s):\n` +
          `  duration  ${humanDuration(e.medianDurationMs)} (median)\n` +
          `  cost      $${e.medianCostUsd.toFixed(4)} (median)\n` +
          `  repairs   ${e.medianRepairs}\n` +
          `  landed    ${Math.round(e.successRate * 100)}%\n` +
          (e.medianPoints == null ? '' : `  points    ${e.medianPoints}\n`) +
          '\nbasis:\n',
        );
        for (const b of e.basis.slice(0, 8)) {
          process.stdout.write(`  ${b.taskId.padEnd(14)} ${b.status.padEnd(9)} ${humanDuration(b.durationMs).padStart(6)}  ${b.title}\n`);
        }
        return 0;
      }
      // `ls` and a bare search share one listing: with a query the server
      // ranks, without one it pages newest-first.
      const query = sub === 'ls' ? args._.slice(2).join(' ').trim() : args._.slice(1).join(' ').trim();
      const params = new URLSearchParams({ limit: flagStr(args, 'limit') ?? '40' });
      if (query) params.set('q', query);
      const role = flagStr(args, 'role');
      const playbook = flagStr(args, 'playbook');
      if (role) params.set('role', role);
      if (playbook) params.set('playbook', playbook);
      const r = await apiCall(`/api/archive?${params}`);
      const records = r.records as Array<Record<string, unknown>>;
      if (!records.length) {
        process.stdout.write(`archive is empty (${r.total} total)\n`);
        return 0;
      }
      process.stdout.write(
        ['ID'.padEnd(PAD.id), 'STATUS'.padEnd(9), 'ROLE'.padEnd(12), 'TOOK'.padStart(6), 'COST'.padStart(9), 'TITLE'].join(' ') + '\n',
      );
      for (const rec of records) {
        process.stdout.write([
          String(rec['taskId']).padEnd(PAD.id),
          String(rec['status']).padEnd(9),
          String(rec['role'] ?? '—').padEnd(12),
          humanDuration(Number(rec['durationMs'])).padStart(6),
          `$${Number(rec['costUsd']).toFixed(4)}`.padStart(9),
          String(rec['title']),
        ].join(' ') + '\n');
      }
      process.stdout.write(`\n${records.length} of ${r.total} archived\n`);
      return 0;
    }
    case 'drill': {
      // In-process, like `doctor --bench`: the capability probes are real model
      // calls that can outlast any sensible HTTP timeout, and none of it needs
      // a daemon.
      const store = new Store(config.dbPath);
      const broker = new Broker(store);
      const only = args.flags['plumbing'] ? 'plumbing' : args.flags['capability'] ? 'capability' : undefined;
      // Under FOREMAN_LOCAL_ONLY=auto the mode depends on the cloud, so ask
      // before reporting it — exactly as `serve` does at boot.
      await probeCloud().catch(() => null);
      process.stdout.write(
        `local-only readiness drill — mode ${localOnly() ? 'LOCAL-ONLY' : `${modeSummary()} (set FOREMAN_LOCAL_ONLY=1 for the real thing)`}\n\n`,
      );
      const report = await runDrill({
        store, broker, only: only as never,
        onProgress: (line) => process.stdout.write(`  ${line}\n`),
      });
      store.close();

      process.stdout.write('\n');
      for (const r of report.results) {
        const mark = r.skipped ? 'skip' : r.ok ? 'PASS' : 'FAIL';
        process.stdout.write(`${mark}  ${r.id.padEnd(24)} ${r.skipped ?? r.evidence}\n`);
        // The rationale is printed only for a probe that did not pass: a green
        // drill should be four lines, a red one should explain itself.
        if (!r.ok && !r.skipped) {
          for (const line of wrapText(r.matters, 72)) process.stdout.write(`      ${line}\n`);
        }
      }
      process.stdout.write(
        `\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped\n`,
      );
      // A failed probe is a non-zero exit so this can gate a cutover script.
      return report.failed ? 1 : 0;
    }
    case 'agreement': {
      const d = await apiCall('/api/agreement');
      const rows = d.rows as Array<Record<string, any>>;
      process.stdout.write(
        `shadow verdicts: ${d.total}` +
        `   recording: ${d.enabled ? 'ON' : 'OFF (set FOREMAN_SHADOW_LOCAL=1)'}\n` +
        `criterion: \u2265${Math.round(d.criterion.minAgreement * 100)}% agreement over \u2265${d.criterion.minSamples} samples, ` +
        `with at most ${(d.criterion.maxFalsePassRate * 100).toFixed(1)}% false passes\n\n`,
      );
      if (!rows.length) {
        process.stdout.write(
          'nothing recorded yet.\n\n' +
          'A shadow verdict is written every time a CLOUD reviewer decides a ticket and a local\n' +
          'reviewer is asked the same question for the record. It needs both to be in play:\n' +
          '  FOREMAN_SHADOW_LOCAL=1  FOREMAN_CREW_REVIEW=always  (and a playbook with reviewers)\n',
        );
        return 0;
      }
      process.stdout.write(
        ['ROLE'.padEnd(28), 'N'.padStart(4), 'AGREE'.padStart(7), 'TREND'.padStart(7), 'FALSE-PASS'.padStart(11), '  STATUS'].join('') + '\n',
      );
      for (const r of rows) {
        const name = r.role === 'ALL' ? '(all roles)' : `${r.playbook ?? '\u2014'}.${r.role ?? '\u2014'}`;
        const trend = r.trend == null ? '  \u2014  ' : `${r.trend >= 0 ? '+' : ''}${(r.trend * 100).toFixed(0)}%`.padStart(7);
        process.stdout.write(
          name.padEnd(28) +
          String(r.samples).padStart(4) +
          `${(r.agreementRate * 100).toFixed(0)}%`.padStart(7) +
          trend +
          `${r.falsePasses}`.padStart(11) +
          `  ${r.ready ? 'READY' : 'not yet'}\n`,
        );
        // Blockers are the actionable half; print them under the row that has them.
        if (!r.ready) for (const b of r.blockers) process.stdout.write(`      \u00b7 ${b}\n`);
      }
      process.stdout.write(
        '\nTREND is agreement over the recent half of the sample minus the older half:\n' +
        'positive means the local reviewer is catching up, which is the thing to watch.\n' +
        'FALSE-PASS counts work the cloud FAILED that the local reviewer would have landed.\n' +
        'That is the error that matters after the cutover, so it is held to a harder\n' +
        'limit than overall agreement.\n',
      );
      // Non-zero while any role is still short of the criterion, so this can
      // gate a cutover script the same way `drill` does.
      return rows.some((r) => r.role !== 'ALL' && !r.ready) ? 1 : 0;
    }
    case 'gate': {
      // `foreman gate --waiting owner`  — hand the current backlog over
      // `foreman gate --house owner`    — and/or everything queued from now on
      // `foreman gate <taskId> owner`   — one ticket
      //
      // parseArgs takes the token after a `--flag` as that flag's VALUE, so
      // `--waiting owner` arrives as flags.waiting === 'owner'. That reads
      // naturally, so it is the supported form rather than something to work
      // around; a bare `--waiting` still works alongside a trailing mode.
      const isMode = (v: unknown): v is 'owner' | 'human' => v === 'owner' || v === 'human';
      const positional = args._.slice(1).filter(isMode)[0];
      const waiting = isMode(args.flags['waiting']) ? args.flags['waiting'] : (args.flags['waiting'] ? positional : undefined);
      const house = isMode(args.flags['house']) ? args.flags['house'] : (args.flags['house'] ? positional : undefined);

      if (args.flags['waiting'] || args.flags['house']) {
        if (!waiting && !house) throw new Error('usage: foreman gate --waiting|--house owner|human');
        // The two effects are independent, and `--waiting` alone must not move
        // the house default: "decide the ones already waiting, but keep asking
        // me about new work" is a thing an operator legitimately wants, and
        // silently changing the default under them is not what they asked for.
        const r = await apiCall('/api/settings/gate', {
          method: 'POST',
          body: JSON.stringify({
            ...(house ? { gate: house } : {}),
            ...(waiting ? { applyToWaiting: waiting } : {}),
          }),
        });
        if (house) process.stdout.write(`house gate: ${house}\n`);
        if (waiting) process.stdout.write(`${r.applied} waiting task(s) handed to ${waiting}\n`);
        if (waiting === 'owner' || house === 'owner') {
          process.stdout.write(
            `\nThe owner model (${tierModel('owner')}) decides only work that already went GREEN.\n` +
            'Anything S2, allowCore, budget-stopped, test-failed, or with a fail/split verdict\n' +
            'still parks for you — and so does anything it is unsure about, with its reasoning\n' +
            'on the task timeline.\n',
          );
        }
        return 0;
      }

      const taskId = args._[1];
      if (!taskId || !positional) throw new Error('usage: foreman gate <taskId> owner|human');
      const task = await apiCall(`/api/tasks/${taskId}/gate`, {
        method: 'POST',
        body: JSON.stringify({ gate: positional }),
      });
      process.stdout.write(`${task.id}  gate → ${positional}\n`);
      return 0;
    }
    case 'reverify': {
      // Re-run the REVIEW on work that is already done. `retry` throws the
      // work away and does it again; this keeps it and asks the council once
      // more — which is what a `split` actually calls for.
      const ids = args.flags['split']
        ? ((await apiCall('/api/state')).tasks as Array<Record<string, any>>)
            .filter((t) => t.status === 'awaiting-approval' && t.run?.verdict === 'split')
            .map((t) => String(t.id))
        // Split on whitespace and commas as well as argv boundaries: zsh does
        // not word-split an unquoted variable, so `reverify $IDS` arrives as
        // ONE argument holding twelve ids. Without this it becomes a single
        // url-encoded "task not found: t_a%20t_b%20…", which is a confusing
        // way to learn about your shell.
        : args._.slice(1).flatMap((a) => String(a).split(/[\s,]+/)).filter(Boolean);
      if (!ids.length) {
        throw new Error('usage: foreman reverify <taskId>... | --split   (--split takes every task parked on a split verdict)');
      }
      process.stdout.write(`re-reviewing ${ids.length} task(s) — a chapter takes a few minutes each\n`);
      let changed = 0;
      for (const id of ids) {
        try {
          const started = await apiCall(`/api/tasks/${id}/reverify`, { method: 'POST', body: '{}' });
          // The server accepted the job and returned; the review runs in the
          // daemon. Poll for the verdict it will write rather than holding a
          // request open for minutes.
          const deadline = Date.now() + REVERIFY_POLL_MS;
          let verdict = 'timed out waiting';
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 4000));
            const d = await apiCall(`/api/tasks/${id}`);
            // A re-review that climbs the ladder writes a row per rung, so the
            // first new row can be a rung the climb then replaced. Wait for the
            // daemon to say the re-review is over (an older daemon never says).
            if (d.reverifying) continue;
            const wrote = (d.verdicts?.length ?? 0) > (started.verdictsBefore ?? 0);
            // Over, and nothing written: it failed or the task moved on (`=== false`,
            // so an older daemon that never says keeps the old wait).
            if (!wrote && d.reverifying === false) {
              verdict = 'no new verdict (see the task timeline)';
              break;
            }
            if (wrote) {
              // verdictsForTask returns NEWEST FIRST. Reading the last element
              // reported the OLDEST verdict — so a task that had just been
              // re-reviewed to `fail` printed the `split` it was carrying
              // before, which is precisely the value this command exists to
              // change. Believing that output would have meant re-reviewing
              // work that had already been judged.
              verdict = String(d.verdicts[0]?.verdict ?? 'no verdict');
              break;
            }
          }
          if (verdict === 'pass' || verdict === 'fail') changed++;
          process.stdout.write(`  ${id.padEnd(14)} ${verdict}\n`);
        } catch (err) {
          process.stdout.write(`  ${id.padEnd(14)} ERROR: ${(err as Error).message.slice(0, 110)}\n`);
        }
      }
      process.stdout.write(`\n${changed}/${ids.length} now carry a real verdict\n`);
      return 0;
    }
    case 'ls': {
      const state = await apiCall('/api/state');
      const closed = ['done', 'failed', 'rejected', 'canceled'];
      const tasks = (state.tasks as Task[]).filter((t) => args.flags['all'] || !closed.includes(t.status));
      if (!tasks.length) {
        // The archived count belongs here more than anywhere: an empty board
        // with a full archive reads as lost work unless it says otherwise.
        process.stdout.write(
          'no tasks' +
          (state.archivedCount ? `  ·  ${state.archivedCount} archived (foreman archive)` : '') + '\n',
        );
        return 0;
      }
      process.stdout.write(
        ['ID'.padEnd(PAD.id), 'STATUS'.padEnd(PAD.status), 'WHO'.padEnd(PAD.who), 'RUNNER'.padEnd(PAD.runner), 'STAGE'.padEnd(12), 'TITLE'].join(' ') + '\n',
      );
      for (const t of tasks) process.stdout.write(taskLine(t as never) + '\n');
      const w = state.workers;
      process.stdout.write(
        `\n${w.active}/${w.max} workers busy` + (w.verifying ? `, ${w.verifying} verifying` : '') +
        (state.archivedCount ? `  ·  ${state.archivedCount} archived (foreman archive)` : '') + '\n',
      );
      return 0;
    }
    case 'show': {
      const taskId = args._[1];
      if (!taskId) throw new Error('usage: foreman show <taskId>');
      const d = await apiCall(`/api/tasks/${taskId}`);
      process.stdout.write(`${d.task.title}\n${d.task.id}  ${d.task.status}  ${d.task.runner}  ${d.task.kind}\n${skillsLine(d.task)}\n`);
      if (d.task.error) process.stdout.write(`error: ${d.task.error}\n\n`);
      for (const a of d.artifacts) {
        process.stdout.write(`artifact ${a.type}: ${a.path}${a.summary ? ` (${a.summary})` : ''}\n`);
      }
      for (const v of d.verdicts ?? []) {
        process.stdout.write(
          `\ncouncil ${v.verdict}${v.disagreement ? (chairRuled(v) ? ' (split → chair ruled)' : ' (split, no ruling)') : ''}  $${v.costUsd.toFixed(4)}\n`,
        );
        for (const o of v.council) {
          process.stdout.write(`  ${o.model}: ${o.error ? `unavailable — ${o.error}` : `${o.verdict} (${o.confidence.toFixed(2)}) ${o.critique.slice(0, 160)}`}\n`);
        }
        if (v.chairSummary) process.stdout.write(`  ${chairRuled(v) ? 'chair' : 'note'}: ${v.chairSummary.slice(0, 300)}\n`);
      }
      const dropped = formatDroppedIssues(d.events);
      if (dropped) process.stdout.write(`\n${dropped}\n`);
      // The ledger's rows (queue.ts addDecision). A daemon from before them answers without the list: the timeline's
      // `decision` events, if any, are below under recent activity.
      const decisions: Decision[] = Array.isArray(d.decisions) ? d.decisions : [];
      if (decisions.length) {
        process.stdout.write('\ndecisions:\n');
        for (const dec of decisions) process.stdout.write(`  ${new Date(dec.at).toLocaleString()} ${decisionLine(dec)}\n`);
      }
      process.stdout.write('\nrecent activity:\n');
      for (const ev of d.events.slice(-25)) {
        if (ev.type === 'progress' || ev.type === 'metrics') continue;
        process.stdout.write(`  ${new Date(ev.ts).toLocaleTimeString()} [${ev.type}] ${ev.message}\n`);
      }
      return 0;
    }
    case 'retry':
    case 'reopen': {
      const taskId = args._[1];
      if (!taskId) throw new Error(`usage: foreman ${cmd} <taskId> [--note <text>]${cmd === 'retry' ? ' [--skills <a>[,<b>]|default]' : ''}`);
      const note = flagStr(args, 'note');
      refuseCorrectedFlags(args, cmd);
      const skills = skillsFlag(args);
      if (skills !== undefined && cmd !== 'retry') throw new Error('--skills goes with retry: a reopened task is not run again');
      const t = await apiCall(`/api/tasks/${taskId}/${cmd}`, {
        method: 'POST',
        // `skills: null` asks for the role's default; the key is absent when the loadout is left as it is.
        body: JSON.stringify({ ...(note === undefined ? {} : { note }), ...(skills === undefined ? {} : { skills }) }),
      });
      if (skills !== undefined) await assertSkillsStored(t, skills);
      process.stdout.write(
        `${t.id} → ${t.status}${skills === undefined ? '' : `  skills: ${skills ? skills.join(', ') : 'role default'}`}\n`,
      );
      process.stdout.write(recordedLine(cmd, t.decision));
      return 0;
    }
    case 'approve':
    case 'cancel': {
      const taskId = args._[1];
      if (!taskId) throw new Error(`usage: foreman ${cmd} <taskId>${cmd === 'approve' ? ' [--note <text>] [--as-is <tree sha>] [--corrected | --clean] [--review-source <text>]' : ' [--note <text>]'}`);
      const note = flagStr(args, 'note');
      if (args.flags['note'] === true) throw new Error('--note needs its text');
      const corrected = correctedFlag(args);
      const reviewSource = flagStr(args, 'review-source');
      if (args.flags['review-source'] === true) throw new Error('--review-source needs its text (who verified the work)');
      if (cmd !== 'approve' && (corrected !== undefined || reviewSource !== undefined)) {
        throw new Error('--corrected, --clean and --review-source go with approve');
      }
      if (reviewSource !== undefined && reviewSource.length > 200) throw new Error(`--review-source is ${reviewSource.length} characters; at most 200 are kept`);
      // An approve merges and then runs the repo's whole suite on the merged
      // HEAD (postMerge.ts) before it answers; on Kiln that took longer than
      // fetch's 300s header timeout, and the CLI reported a timeout for a
      // merge that had landed. node:http has no such ceiling.
      const t = cmd === 'approve'
        ? await apiCallLong(`/api/tasks/${taskId}/approve`, {
          ...(note === undefined ? {} : { note }),
          // Land the tree named here although it is not the one that was reviewed (merge.ts).
          ...(flagStr(args, 'as-is') === undefined ? {} : { acceptTree: flagStr(args, 'as-is') }),
          // For the record only (the `decisions` row): neither key is sent when nothing was stated.
          ...(corrected === undefined ? {} : { corrected }),
          ...(reviewSource === undefined ? {} : { reviewSource }),
        })
        : await apiCall(`/api/tasks/${taskId}/${cmd}`, { method: 'POST', ...(note === undefined ? {} : { body: JSON.stringify({ note }) }) });
      process.stdout.write(`${t.id} → ${t.status}\n`);
      if (t.merge?.branch) process.stdout.write(`merge: ${t.merge.reason}\n`);
      if (t.registration && t.registration.reason !== 'not a tool task') {
        process.stdout.write(`tool: ${t.registration.reason}\n`);
      }
      process.stdout.write(recordedLine(cmd, t.decision));
      // A cancel is never refused over its note; when the note could not be read the daemon says so here.
      if (cmd === 'cancel' && typeof t.warning === 'string') process.stdout.write(`${t.warning}\n`);
      // An approval that lands nothing read exactly like one that did, bar one quiet line: on the Kiln trial an
      // approved ADR (kind writing) was taken for landed. Said last and loudly, from what the daemon already answers
      // (merge.ts's reason for a ticket with merge-on-approve off, and the run that holds the branch).
      if (cmd === 'approve' && t.merge?.merged === false && t.merge.branch && /merge-on-approve disabled/.test(String(t.merge.reason))) {
        const runs: Array<{ branch?: string | null; worktreePath?: string | null }> =
          (await apiCall(`/api/tasks/${taskId}`).catch(() => null))?.runs ?? [];
        const where = runs.find((r) => r.branch === t.merge.branch && r.worktreePath)?.worktreePath ?? `branch ${t.merge.branch}`;
        process.stdout.write(
          t.kind && t.kind !== 'code'
            ? `NOT MERGED: this ticket's kind (${t.kind}) does not merge on approval — its work is still in ${where}; ` +
              'land it by hand or requeue it as --kind code\n'
            : `NOT MERGED: merge-on-approve is off for this ticket — its work is still in ${where}; land it by hand\n`,
        );
      }
      return 0;
    }
    case 'reject': {
      const taskId = args._[1];
      if (!taskId) throw new Error('usage: foreman reject <taskId> [--note <text>]');
      refuseCorrectedFlags(args, 'reject');
      const t = await apiCall(`/api/tasks/${taskId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ note: flagStr(args, 'note') ?? 'rejected via cli' }),
      });
      process.stdout.write(`${t.id} → ${t.status}\n`);
      process.stdout.write(recordedLine('reject', t.decision));
      return 0;
    }
    case 'rm': {
      const taskId = args._[1];
      if (!taskId) throw new Error('usage: foreman rm <taskId>');
      await apiCall(`/api/tasks/${taskId}`, { method: 'DELETE' });
      process.stdout.write(`${taskId} deleted\n`);
      return 0;
    }
    case 'watch': {
      for (;;) {
        const state = await apiCall('/api/state');
        const lines = (state.tasks as Task[]).map((t) => taskLine(t as never));
        process.stdout.write(
          `\x1b[2J\x1b[H foreman — ${state.workers.active}/${state.workers.max} workers · ${new Date().toLocaleTimeString()}\n\n` +
            (lines.join('\n') || ' no tasks') + '\n',
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case 'demo': {
      const seeds = [
        { title: 'Audit dependency licences', prompt: 'survey licences', priority: 1 },
        { title: 'Draft the launch note', prompt: 'write the note', kind: 'writing' },
        { title: 'Summarise last week', prompt: 'research summary', kind: 'research' },
        { title: 'Broken migration check', prompt: 'this one should fail on purpose' },
      ];
      const ids: string[] = [];
      for (const s of seeds) {
        const t = await apiCall('/api/tasks', { method: 'POST', body: JSON.stringify({ ...s, runner: 'echo' }) });
        ids.push(t.id);
        process.stdout.write(`${t.id}  ${t.title}\n`);
      }
      const dependent = await apiCall('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Publish the note (waits on the draft)',
          prompt: 'publish',
          runner: 'echo',
          deps: [ids[1]],
        }),
      });
      process.stdout.write(`${dependent.id}  ${dependent.title} (blocked on ${ids[1]})\n\nopen ${base}\n`);
      return 0;
    }
    case 'ask': {
      const ask = args._.slice(1).join(' ').trim();
      if (!ask) throw new Error('usage: foreman ask "<what you want>" [--repo <path>] [--yes]');
      const confirm = Boolean(args.flags['yes']);
      const d = await apiCall('/api/ask', {
        method: 'POST',
        body: JSON.stringify({
          ask,
          repo: flagStr(args, 'repo') ?? null,
          sensitivity: flagStr(args, 'sensitivity'),
          runner: flagStr(args, 'runner'),
          budgetUsd: flagStr(args, 'budget') === undefined ? null : Number(flagStr(args, 'budget')),
          priority: Number(flagStr(args, 'priority') ?? 0),
          confirm,
        }),
      });
      const plan = d.plan;
      process.stdout.write(`plan${plan.degraded ? ' (degraded)' : ''}: ${plan.notes || plan.ask}\n\n`);
      for (const n of plan.nodes) {
        process.stdout.write(
          `  ${n.ref.padEnd(8)} ${n.kind.padEnd(8)} ${n.runner.padEnd(12)} ${n.title}\n` +
            (n.after.length ? `           after ${n.after.join(', ')}\n` : '') +
            (n.reason ? `           ${n.reason.slice(0, 100)}\n` : ''),
        );
      }
      if (plan.reusedTools?.length) process.stdout.write(`\nreusing tools: ${plan.reusedTools.join(', ')}\n`);
      if (!confirm) {
        process.stdout.write('\nnothing queued — re-run with --yes to queue this plan\n');
        return 0;
      }
      process.stdout.write('\nqueued:\n');
      for (const t of d.queued) process.stdout.write(`  ${t.id}  ${t.status.padEnd(8)} ${t.title}\n`);
      return 0;
    }
    case 'build': {
      const ask = args._.slice(1).join(' ').trim();
      const fromEpic = flagStr(args, 'from-epic') ?? null;
      if (!ask && !fromEpic) {
        throw new Error(
          'usage: foreman build "<ask>" [--repo <path>] [--playbook <id>] [--auto] [--from-epic <id>] [--check|--no-check] [--revise] [--gate human|owner]',
        );
      }
      const auto = Boolean(args.flags['auto']);
      const check = Boolean(args.flags['check']) ? true : Boolean(args.flags['no-check']) ? false : undefined;
      // The build response does not carry the playbook catalog; ask for it, and never fail the build over it.
      const loaded = await apiCall('/api/playbooks').catch(() => null);
      const d = await apiCallLong('/api/build', {
          ask,
          fromEpic,
          repo: flagStr(args, 'repo') ?? null,
          playbook: flagStr(args, 'playbook') ?? null,
          sensitivity: flagStr(args, 'sensitivity'),
          // Epic-wide gate opt-in. `foreman add` has no counterpart on
          // purpose: one task is cheap to approve by hand.
          gate: flagStr(args, 'gate') ?? null,
          runner: flagStr(args, 'runner'),
          budgetUsd: flagStr(args, 'budget') === undefined ? null : Number(flagStr(args, 'budget')),
          priority: Number(flagStr(args, 'priority') ?? 0),
          auto,
          check,
          revise: Boolean(args.flags['revise']),
      });
      const plan = d.plan;
      for (const w of loaded?.warnings ?? []) process.stdout.write(`WARNING ${formatPlaybookWarning(w)}\n`);
      process.stdout.write(
        `epic${plan.degraded ? ' (degraded)' : ''}: ${plan.epic.title}\n` +
          `playbook: ${plan.playbook}${plan.precedents?.length ? `  precedent: ${plan.precedents.join(', ')}` : ''}` +
          `${plan.costUsd ? `  planning cost: $${Number(plan.costUsd).toFixed(4)}` : ''}\n` +
          (plan.notes ? `${plan.notes}\n` : '') +
          '\n',
      );
      // Shown on the ticket it changed, not in the list of things to look into.
      const allFindings: Array<{ level: string; code: string; ticket?: string; message: string }> = d.findings ?? [];
      const kindFixes = new Map(allFindings.filter((f) => f.code === 'kind-corrected' && f.ticket).map((f) => [f.ticket!, f.message]));
      for (const t of plan.tickets) {
        process.stdout.write(
          `  ${t.ref.padEnd(6)} ${String(t.role).padEnd(14)} ${String(t.points ?? '-').padEnd(3)} ${t.title}\n` +
            (kindFixes.has(t.ref) ? `         ${kindFixes.get(t.ref)}\n` : '') +
            (t.after.length ? `         after ${t.after.join(', ')}\n` : '') +
            (t.acceptance ? `         accept: ${String(t.acceptance).slice(0, 100)}\n` : '') +
            (t.skills?.length ? `         skills: ${t.skills.join(', ')}\n` : '') +
            (t.reviewNotes?.length ? `         plan review notes in its brief: ${t.reviewNotes.length} (listed under the senior review)\n` : ''),
        );
      }
      // Findings and critique print on every response that reaches here; a
      // 422 refusal throws in apiCall first, so on that path the user sees
      // the finding codes inside the error string instead.
      const findings = allFindings.filter((f) => !(f.code === 'kind-corrected' && f.ticket));
      if (findings.length) {
        process.stdout.write('\nplan check:\n');
        for (const f of findings) {
          const tag = f.level === 'error' ? '!! ERROR' : f.level === 'note' ? 'note' : 'warn';
          process.stdout.write(`  [${tag}] ${f.code}${f.ticket ? ` (${f.ticket})` : ''}: ${f.message}\n`);
        }
      }
      const revision = d.revision as { notes: string[]; applied: boolean; reason?: string } | null;
      if (revision) {
        process.stdout.write(
          revision.applied
            ? `\nrevised once against the senior review (${revision.notes.length} note(s)); the plan above is the revision\n`
            : `\nrevision failed (${revision.reason ?? 'unknown'}); the plan above is the original\n`,
        );
      }
      const critique = d.critique as { verdict: string; notes: string[] } | null;
      // The review of the plan as printed, each note with where it is kept: before, it was printed and dropped.
      const review = plan.review as { verdict: string; notes: Array<{ text: string; tickets: string[]; unmatched: string[] }> } | null | undefined;
      if (critique && review) {
        process.stdout.write(`\nsenior review: ${review.verdict}\n`);
        for (const note of review.notes) process.stdout.write(`  - ${note.text}\n      → ${planNoteHome(note)}\n`);
      } else if (critique) {
        process.stdout.write(`\nsenior review: ${critique.verdict}\n`);
        for (const note of critique.notes) process.stdout.write(`  - ${note}\n`);
      }
      if (!auto) {
        process.stdout.write('\nnothing queued — re-run with --auto to open this epic\n');
        return 0;
      }
      process.stdout.write(`\nepic ${d.epic.id} (${d.epic.status})\n`);
      for (const t of d.queued) process.stdout.write(`  ${t.id}  ${t.status.padEnd(8)} ${t.role ?? ''}  ${t.title}\n`);
      return 0;
    }
    case 'improve': {
      const confirm = Boolean(args.flags['yes']);
      const allowCore = Boolean(args.flags['allow-core']);
      const d = await apiCall('/api/improve', {
        method: 'POST',
        body: JSON.stringify({
          area: flagStr(args, 'area') ?? null,
          confirm,
          allowCore,
          budgetUsd: flagStr(args, 'budget') === undefined ? undefined : Number(flagStr(args, 'budget')),
          runner: flagStr(args, 'runner'),
        }),
      });
      const p = d.proposal;
      process.stdout.write(`proposal${p.degraded ? ' (degraded)' : ''}: ${p.title}\n  area: ${p.area}\n  why:  ${p.rationale}\n\n`);
      process.stdout.write(`${p.prompt}\n\n`);
      if (allowCore) process.stdout.write('!! --allow-core: this run may edit security, gate and merge logic\n\n');
      if (!confirm) {
        process.stdout.write('nothing queued — re-run with --yes to queue this against the foreman repo\n');
        return 0;
      }
      process.stdout.write(`queued ${d.queued.id} (priority ${d.queued.priority}, budget $${d.queued.budgetUsd})\n`);
      process.stdout.write('it will park at the gate; nothing merges on approval — you merge the branch yourself\n');
      return 0;
    }
    case 'debrief': {
      const subject = args._[1];
      if (!subject) throw new Error('usage: foreman debrief <epicId|taskId> [--notes <file>]... [--no-model] [--json] [--max-usd N]');
      // --notes repeats, and parseArgs keeps one value per flag: read every occurrence from argv.
      const argv = process.argv.slice(2);
      const notes = argv.flatMap((a, i) => (a === '--notes' && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? [path.resolve(argv[i + 1]!)] : []));
      if (args.flags['notes'] === true) throw new Error('--notes needs a file');
      const maxUsd = flagStr(args, 'max-usd') === undefined ? undefined : Number(flagStr(args, 'max-usd'));
      if (maxUsd !== undefined && !(Number.isFinite(maxUsd) && maxUsd >= 0)) throw new Error('--max-usd must be a number of dollars');
      // In-process, like `crew report`: it reads the store and needs no daemon. One long reply is expected from
      // the diagnose call, so this process alone waits longer for it than a judge's call is given.
      process.env['FOREMAN_MODEL_TIMEOUT_MS'] ??= '600000';
      // The ledger is READ through a connection that cannot write it and runs no schema statement (a debrief from
      // another checkout must not migrate the live ledger). The one writer is the broker's own store, opened only
      // when a model call is asked for: it records that call's spend receipt, and runs no schema statement either.
      const store = openLedgerReadOnly(config.dbPath);
      const writer: { store: Store | null } = { store: null };
      try {
        const noModel = Boolean(args.flags['no-model']);
        if (!noModel) await probeCloud().catch(() => null);
        const broker = noModel ? null : (): Broker => new Broker((writer.store ??= openLedgerForReceipt(config.dbPath)));
        const { report, paths } = await runDebrief(store, broker, subject, { notes, noModel, maxUsd });
        process.stdout.write(args.flags['json'] ? `${JSON.stringify(report, null, 2)}\n` : renderShort(report, paths));
      } finally {
        store.close();
        writer.store?.close();
      }
      return 0;
    }
    case 'align': {
      const sub = args._[1] ?? 'status';
      const { alignDir, extractSamples } = await import('./align/extract.ts');
      const { buildDatasets } = await import('./align/dataset.ts');

      if (sub === 'extract' || sub === 'build') {
        const store = new Store(config.dbPath);
        const withinDays = flagStr(args, 'within-days') ? Number(flagStr(args, 'within-days')) : undefined;
        const limitFiles = flagStr(args, 'limit') ? Number(flagStr(args, 'limit')) : undefined;
        if (sub === 'extract') {
          const { stats } = extractSamples({ withinDays, limitFiles });
          process.stdout.write(
            `read ${stats.filesRead} session(s), ${stats.turnsSeen} turns → ${stats.samples} samples\n` +
              `dropped: ${stats.droppedShort} short, ${stats.droppedNoise} noise, ${stats.droppedDuplicate} duplicate\n`,
          );
          for (const r of stats.redactions) process.stdout.write(`  redacted ${r.rule}: ${r.count}\n`);
          store.close();
          return 0;
        }
        const built = buildDatasets({
          store, withinDays, limitFiles,
          maxSamples: flagStr(args, 'max') ? Number(flagStr(args, 'max')) : undefined,
        });
        process.stdout.write(
          `sft: ${built.sft.train} train / ${built.sft.valid} valid\n` +
            `dpo: ${built.dpo.train} train / ${built.dpo.valid} valid ` +
            `(${built.dpo.fromGate} from the gate, ${built.dpo.fromCouncil} from the council` +
            `${built.dpo.councilHeldBack ? `; ${built.dpo.councilHeldBack} one-directional council pair(s) held back` : ''})\n`,
        );
        for (const f of built.files) process.stdout.write(`  ${f}\n`);
        store.close();
        return 0;
      }

      if (sub === 'train') {
        const { train, trainPreflight, adaptersDir } = await import('./align/train.ts');
        const blocked = await trainPreflight();
        if (blocked) {
          process.stderr.write(`cannot train: ${blocked}\n`);
          return 1;
        }
        const result = await train({
          base: flagStr(args, 'base') ?? 'mlx-community/Qwen2.5-7B-Instruct-4bit',
          dataDir: path.join(alignDir(), 'data'),
          adapterName: flagStr(args, 'name') ?? 'local-reason-persona',
          mode: args.flags['dpo'] ? 'dpo' : 'sft',
          iters: flagStr(args, 'iters') ? Number(flagStr(args, 'iters')) : undefined,
          onLine: (line) => process.stdout.write(`  ${line}\n`),
        });
        process.stdout.write(`${result.ok ? 'trained' : 'FAILED'}: ${result.reason}\n${result.adapterDir}\n`);
        process.stdout.write(`adapters live in ${adaptersDir()}\n`);
        return result.ok ? 0 : 1;
      }

      if (sub === 'status') {
        const dir = alignDir();
        process.stdout.write(`align dir: ${dir}\n`);
        for (const sub2 of ['data', 'adapters', 'adoption']) {
          const full = path.join(dir, sub2);
          const entries = fs.existsSync(full) ? fs.readdirSync(full) : [];
          process.stdout.write(`  ${sub2}: ${entries.length ? entries.join(', ') : '(empty)'}\n`);
        }
        const { trainPreflight } = await import('./align/train.ts');
        const blocked = await trainPreflight();
        process.stdout.write(`  training: ${blocked ?? 'mlx-lm available'}\n`);
        return 0;
      }
      throw new Error('usage: foreman align extract|build|train|status');
    }
    case 'persona': {
      const sub = args._[1] ?? 'ls';
      const {
        loadPersonas, savePersona, getPersona, seedPersonas, personasDir, personaServerUrl,
      } = await import('./align/personas.ts');

      if (sub === 'init') {
        const existing = new Set(loadPersonas().personas.map((p) => p.id));
        let written = 0;
        for (const persona of seedPersonas()) {
          if (existing.has(persona.id)) continue;
          savePersona(persona);
          written++;
        }
        process.stdout.write(`${written} persona(s) written to ${personasDir()}\n`);
        return 0;
      }

      if (sub === 'ls') {
        const { personas, refused } = loadPersonas();
        if (!personas.length) process.stdout.write('no personas yet — run: foreman persona init\n');
        for (const p of personas) {
          const counts = p.lastBuild ? `${p.lastBuild.sft} sft / ${p.lastBuild.dpo} dpo` : 'never built';
          process.stdout.write(
            `  ${p.status.padEnd(9)} ${p.id.padEnd(24)} ${counts.padEnd(22)} ${p.alias ?? '(no alias)'}\n`,
          );
        }
        for (const r of refused) process.stdout.write(`  REFUSED ${r.file}: ${r.reason}\n`);
        return 0;
      }

      if (sub === 'ingest') {
        const id = args._[2];
        const dir = flagStr(args, 'manuscript');
        if (!id || !dir) {
          throw new Error('usage: foreman persona ingest <id> --manuscript <dir> [--style <file>] [--replace]');
        }
        const persona = getPersona(id);
        if (!persona) throw new Error(`no such persona: ${id}`);

        const { buildFromManuscript } = await import('./align/manuscript.ts');
        const { personaDataDir } = await import('./align/personas.ts');
        const { fitsWindow, split, writeJsonl } = await import('./align/personaData.ts');

        const styleFile = flagStr(args, 'style');
        const styleNote = styleFile && fs.existsSync(styleFile)
          ? fs.readFileSync(styleFile, 'utf8').slice(0, 1200)
          : undefined;

        // Comma-separated, because the corpus that matters is the SERIES, not
        // one book of it. One book alone is tens of thousands of words; a series
        // is several times that, all of it revised and in the same voice —
        // and on an 8B LoRA the amount of in-voice text is the single biggest
        // lever there is. Later directories win on nothing; every passage is
        // an independent sample.
        const dirs = dir.split(',').map((d) => d.trim()).filter(Boolean);
        // The tic gate as a training filter. mlx-lm here has no DPO, so a bad
        // habit cannot be trained against — the only way to unlearn one is
        // never to show it. `--keep-tics` opts out.
        const { scanTics } = await import('./prose/tics.ts');
        const ticScan = args.flags['keep-tics'] ? undefined : (t: string) => scanTics(t);
        const reports = dirs.map((d) => buildFromManuscript({ dir: d, styleNote, ticScan }));
        const report = {
          rows: reports.flatMap((r) => r.rows),
          filesRead: reports.reduce((n, r) => n + r.filesRead, 0),
          passages: reports.reduce((n, r) => n + r.passages, 0),
          skipped: reports.flatMap((r) => r.skipped),
          ticDropped: reports.reduce((n, r) => n + r.ticDropped, 0),
        };
        // The same window check the history corpus goes through. A prompt that
        // fills the sequence leaves no unmasked target and mlx-lm answers that
        // batch with a NaN loss, which then silently ruins the whole run.
        const usable = report.rows.filter((r) => fitsWindow(r.prompt, r.completion, persona.training.maxSeqLength));
        const dropped = report.rows.length - usable.length;

        const dataDir = personaDataDir(id);
        let existing: Array<{ prompt: string; completion: string }> = [];
        const trainFile = path.join(dataDir, 'train.jsonl');
        const validFile = path.join(dataDir, 'valid.jsonl');
        if (!args.flags['replace']) {
          for (const f of [trainFile, validFile]) {
            if (!fs.existsSync(f)) continue;
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
              if (line.trim()) existing.push(JSON.parse(line));
            }
          }
        }
        // Manuscript rows lead. If the corpus has to be truncated anywhere
        // downstream, the prose the persona is judged on should be the part
        // that survives, not the session summaries that taught it to write
        // status reports.
        const all = [...usable, ...existing];
        const parts = split(all, 0.1);
        writeJsonl(path.join(dataDir, 'train.jsonl'), parts.train);
        writeJsonl(path.join(dataDir, 'valid.jsonl'), parts.valid);

        process.stdout.write(
          `read ${report.filesRead} chapter file(s) -> ${report.passages} passages -> ${report.rows.length} pairs\n` +
          `${report.ticDropped ? `withheld ${report.ticDropped} passage(s) carrying a hard tic — the model is never shown them\n` : ''}` +
          `${dropped ? `dropped ${dropped} that could not fit the ${persona.training.maxSeqLength}-token window\n` : ''}` +
          `${args.flags['replace'] ? 'replaced' : `kept ${existing.length} existing sample(s); now`} ` +
          `sft ${parts.train.length}/${parts.valid.length} in ${dataDir}\n` +
          `${report.skipped.length ? `skipped (nothing to learn from): ${report.skipped.join(', ')}\n` : ''}` +
          `\nNext:  foreman persona train ${id}\n`,
        );
        return 0;
      }

      if (sub === 'build') {
        const { buildPersonaDatasets } = await import('./align/personaData.ts');
        const store = new Store(config.dbPath);
        const report = buildPersonaDatasets({
          store,
          withinDays: flagStr(args, 'within-days') ? Number(flagStr(args, 'within-days')) : undefined,
          limitFiles: flagStr(args, 'limit') ? Number(flagStr(args, 'limit')) : undefined,
          ticketsOnly: Boolean(args.flags['tickets-only']),
        });
        process.stdout.write(
          `read ${report.filesRead} session file(s); ${report.unclaimed} sample(s) claimed by nobody; ` +
            `${report.droppedRedacted} dropped for carrying a redaction\n`,
        );
        for (const row of report.rows) {
          process.stdout.write(
            `  ${row.id.padEnd(24)} sft ${String(row.sft.train).padStart(5)}/${String(row.sft.valid).padStart(4)}  ` +
              `dpo ${String(row.dpo.train).padStart(4)}/${String(row.dpo.valid).padStart(3)}  ` +
              `+${row.newSinceLastBuild} new${row.droppedTooLong ? ` (-${row.droppedTooLong} too long)` : ''}` +
              `${row.dueForTraining ? '  DUE' : ''}\n`,
          );
        }
        store.close();
        return 0;
      }

      const id = args._[2];
      if (sub === 'train') {
        if (!id) throw new Error('usage: foreman persona train <id>');
        const persona = getPersona(id);
        if (!persona) throw new Error(`no such persona: ${id}`);
        const { machineIsBusy, trainPersonaGoverned } = await import('./align/governor.ts');
        // Two busy signals, because the operator's work is not only Foreman's.
        // A running ticket is the obvious one; load average catches everything
        // else — a test suite, a build, an editor doing something expensive.
        // Observed: a perf-sensitive test went red purely because a trainer was
        // competing with it, which is the chore disturbing the work.
        const store = new Store(config.dbPath);
        const busy = (): boolean => {
          const row = store.db
            .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running','verifying')")
            .get() as Record<string, unknown>;
          return Number(row['n'] ?? 0) > 0 || machineIsBusy();
        };
        const result = await trainPersonaGoverned(persona, {
          isBusy: busy,
          onLine: (line) => process.stdout.write(`  ${line}\n`),
          maxMs: flagStr(args, 'max-minutes') ? Number(flagStr(args, 'max-minutes')) * 60_000 : undefined,
        });
        store.close();
        process.stdout.write(
          `${result.ok ? 'trained' : 'FAILED'}: ${result.reason}\n` +
            `  ${Math.round(result.ranMs / 1000)}s of run time, suspended ${result.suspensions} time(s)\n` +
            (result.loss.train !== null || result.loss.valid !== null
              ? `  final loss: train ${result.loss.train ?? '?'}, valid ${result.loss.valid ?? '?'}\n`
              : '') +
            `  ${result.adapterDir}\n`,
        );
        // A memorized adapter is not a candidate for anything. It stays on disk
        // as a draft so the operator can look at it, and nothing can route to it
        // until it has been trained on more than it can memorize.
        if (result.ok && result.overfit) {
          process.stderr.write(`NOT a candidate: ${result.overfit}\n`);
          savePersona({ ...persona, status: 'draft', trainedAt: new Date().toISOString() });
          return 1;
        }
        if (result.ok) savePersona({ ...persona, status: 'candidate', trainedAt: new Date().toISOString() });
        return result.ok ? 0 : 1;
      }

      if (sub === 'adopt' || sub === 'retire') {
        if (!id) throw new Error(`usage: foreman persona ${sub} <id>`);
        const persona = getPersona(id);
        if (!persona) throw new Error(`no such persona: ${id}`);
        if (sub === 'retire') {
          savePersona({ ...persona, status: 'retired' });
          process.stdout.write(`${id} retired; its role goes back to the tier model\n`);
          return 0;
        }
        if (persona.status !== 'candidate') {
          throw new Error(`${id} is ${persona.status}: only a trained candidate can be adopted`);
        }
        const alias = flagStr(args, 'alias') ?? `persona-${id.replace(/[^a-z0-9]+/gi, '-')}`;

        // The gate, not a flag. An adapter serves live work only if it beats
        // the base it would replace on the golden set, wins a blind A/B judged
        // by a THIRD model, and regresses on nothing in the safety set.
        // --force exists for an operator who has their own evidence; it says so
        // in the record either way.
        if (!args.flags['force']) {
          const { gatePersona } = await import('./align/personaAdopt.ts');
          const { Broker } = await import('./budget.ts');
          const store = new Store(config.dbPath);
          try {
            // Default the judge to the strongest model that can still be
            // reached: opus (fable judged prose until it was deprecated on
            // 2026-10-05). Falls back to the local judge once the cloud
            // aliases stop resolving.
            const { specs } = await import('./models.ts');
            const preferred = 'opus';
            const judge = flagStr(args, 'judge')
              ?? (specs().has(preferred) ? preferred : 'local-reason');
            process.stdout.write(`gating ${id} against ${persona.base}, judged by ${judge}\n`);
            const report = await gatePersona({
              persona,
              broker: new Broker(store),
              judgeAlias: judge,
              onProgress: (line) => process.stdout.write(`  ${line}\n`),
            });
            process.stdout.write(
              `  golden  ${report.golden.candidate} vs ${report.golden.base} ${report.golden.passed ? 'ok' : 'REGRESSED'}\n` +
                `  safety  ${report.safety.candidate} vs ${report.safety.base} ${report.safety.passed ? 'ok' : 'REGRESSED'}\n` +
                `  blind   ${report.blindAb.wins}W ${report.blindAb.losses}L ${report.blindAb.ties}T ` +
                `${report.blindAb.passed ? 'ok' : 'NOT WON'}\n` +
                `  ${report.reportFile}\n`,
            );
            if (!report.adopted) {
              process.stderr.write(
                `NOT adopted: ${report.reasons.join('; ')}\n` +
                  `the adapter stays on disk; nothing routes to it. Train it further, give it more ` +
                  `material, or adopt anyway with --force if you have evidence this gate cannot see.\n`,
              );
              return 1;
            }
          } finally {
            store.close();
          }
        }

        savePersona({ ...persona, status: 'adopted', alias, adoptedAt: new Date().toISOString() });
        process.stdout.write(
          `${id} adopted as '${alias}'${args.flags['force'] ? ' (FORCED, ungated)' : ''}\n` +
            `serve it with:  foreman persona serve ${id}\n` +
            `it will answer at ${personaServerUrl(id)}\n`,
        );
        return 0;
      }

      if (sub === 'set') {
        if (!id) throw new Error('usage: foreman persona set <id> [--base <model>] [--iters N] [--max-seq-length N] [--mode sft|dpo] [--lora-layers N] [--retrain-after N]');
        const persona = getPersona(id);
        if (!persona) throw new Error(`no such persona: ${id}`);
        const numFlag = (name: string, fallback: number): number => {
          const raw = flagStr(args, name);
          const n = raw === undefined ? NaN : Number(raw);
          return Number.isFinite(n) && n > 0 ? n : fallback;
        };
        const updated = {
          ...persona,
          base: flagStr(args, 'base') ?? persona.base,
          retrainAfter: numFlag('retrain-after', persona.retrainAfter),
          training: {
            ...persona.training,
            iters: numFlag('iters', persona.training.iters),
            maxSeqLength: numFlag('max-seq-length', persona.training.maxSeqLength),
            loraLayers: numFlag('lora-layers', persona.training.loraLayers),
            batchSize: numFlag('batch-size', persona.training.batchSize),
            mode: flagStr(args, 'mode') === 'dpo' ? ('dpo' as const) : flagStr(args, 'mode') === 'sft' ? ('sft' as const) : persona.training.mode,
          },
        };
        savePersona(updated);
        process.stdout.write(
          `${id}\n  base ${updated.base}\n` +
            `  ${updated.training.mode}, ${updated.training.iters} iters, ` +
            `${updated.training.maxSeqLength} tokens, ${updated.training.loraLayers} layers, batch ${updated.training.batchSize}\n`,
        );
        return 0;
      }

      if (sub === 'serve') {
        if (!id) throw new Error('usage: foreman persona serve <id> [--stop]');
        const persona = getPersona(id);
        if (!persona) throw new Error(`no such persona: ${id}`);
        const { servePersona, stopPersonaServer, personaServerPid } = await import('./align/personaServe.ts');

        if (args.flags['stop']) {
          const stopped = stopPersonaServer(persona.id);
          process.stdout.write(stopped ? `${id} server stopped\n` : `${id} was not being served\n`);
          return 0;
        }

        const already = personaServerPid(persona.id);
        if (already) {
          process.stdout.write(`${id} is already served at ${personaServerUrl(id)} (pid ${already})\n`);
          return 0;
        }
        // Actually start it. Printing a command and calling that "serve" is how
        // an adopted persona ends up routed to an endpoint nobody ever started.
        process.stdout.write(`starting ${id} on ${persona.base}…\n`);
        const started = await servePersona(persona);
        process.stdout.write(
          started.ok
            ? `${id} served at ${personaServerUrl(id)} (pid ${started.pid})\n` +
              `stop it with: foreman persona serve ${id} --stop\n`
            : `FAILED to serve ${id}: ${started.reason}\n`,
        );
        return started.ok ? 0 : 1;
      }

      if (sub === 'lock') {
        const { localModelLockHolder, localModelLockFile, describeHolder } = await import('./align/localLock.ts');
        const holder = localModelLockHolder();
        process.stdout.write(
          `${localModelLockFile()}\n` +
            (holder ? `  held by ${describeHolder(holder)}\n` : '  free\n') +
            `\nAnything on this machine that loads a local model should take this lock first —\n` +
            `foreman does, and a script can with: foreman persona lock\n`,
        );
        return holder ? 1 : 0;
      }

      throw new Error('usage: foreman persona init|ls|build|set <id>|train <id>|adopt <id>|retire <id>|serve <id> [--stop]|lock');
    }
    case 'tools': {
      const sub = args._[1] ?? 'ls';
      if (sub === 'ls') {
        const d = await apiCall('/api/tools');
        if (d.dir) process.stdout.write(`catalog: ${d.dir}\n`);
        if (!d.tools.length) process.stdout.write('the catalog is empty\n');
        for (const t of d.tools) {
          process.stdout.write(
            `  ${t.quarantined ? 'QUAR' : 'ok  '} ${t.name.padEnd(20)} v${String(t.version).padEnd(3)} ` +
              `${String(t.stats.calls).padStart(4)} calls ${String(t.stats.failures).padStart(3)} fail  ${t.description.slice(0, 60)}\n`,
          );
        }
        return 0;
      }
      const name = args._[2];
      if (!name) throw new Error(`usage: foreman tools ${sub} <name>`);
      if (sub === 'show') {
        process.stdout.write(`${JSON.stringify(await apiCall(`/api/tools/${name}`), null, 2)}\n`);
        return 0;
      }
      if (sub === 'rm') {
        await apiCall(`/api/tools/${name}`, { method: 'DELETE' });
        process.stdout.write(`${name} removed from the catalog\n`);
        return 0;
      }
      if (sub === 'quarantine' || sub === 'release') {
        const t = await apiCall(`/api/tools/${name}/${sub}`, { method: 'POST' });
        process.stdout.write(`${t.name} ${t.quarantined ? 'quarantined' : 'released'}\n`);
        return 0;
      }
      throw new Error('usage: foreman tools ls|show|rm|quarantine|release [<name>]');
    }
    case 'prune': {
      const r = await apiCall('/api/prune', {
        method: 'POST',
        body: JSON.stringify({
          olderThanDays: flagStr(args, 'days') === undefined ? undefined : Number(flagStr(args, 'days')),
          keepDepsCaches: flagStr(args, 'keep-deps') === undefined ? undefined : Number(flagStr(args, 'keep-deps')),
        }),
      });
      process.stdout.write(`removed ${r.removed.length} branch(es); kept ${r.kept.length} still awaiting a decision\n`);
      for (const b of r.removed) process.stdout.write(`  - ${b}\n`);
      process.stdout.write(
        `ledgers: trimmed ${r.ledgers.receipts} receipt(s), ${r.ledgers.verdicts} verdict(s)\n` +
          `deps cache: dropped ${r.depsCachesDropped.length} install(s)\n`,
      );
      return 0;
    }
    case 'trace': {
      const taskId = args._[1];
      if (!taskId) throw new Error('usage: foreman trace <taskId>');
      process.stdout.write(`${JSON.stringify(await apiCall(`/api/trace/${taskId}`), null, 2)}\n`);
      return 0;
    }
    case 'service': {
      const node = process.execPath;
      const cli = new URL('./cli.ts', import.meta.url).pathname;
      process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.foreman.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${cli}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${process.cwd()}</string>
  <key>StandardOutPath</key><string>${config.home}/daemon.log</string>
  <key>StandardErrorPath</key><string>${config.home}/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FOREMAN_HOME</key><string>${config.home}</string>
    <key>FOREMAN_MAX_WORKERS</key><string>${config.maxWorkers}</string>
    <key>PATH</key><string>${process.env['PATH'] ?? '/usr/bin:/bin'}</string>
  </dict>
</dict>
</plist>
`);
      process.stderr.write(
        '\n# save as ~/Library/LaunchAgents/com.foreman.daemon.plist, then:\n' +
          '#   launchctl load -w ~/Library/LaunchAgents/com.foreman.daemon.plist\n',
      );
      return 0;
    }
    case 'doctor': {
      if (args.flags['bench']) {
        // Run in this process: 12 probes across the roster can outlast any
        // sensible HTTP timeout, and it needs no daemon.
        const store = new Store(config.dbPath);
        const broker = new Broker(store);
        process.stdout.write('benching local models (12 probes each, sequential to avoid VRAM thrash)…\n');
        const report = await benchModels(broker, {
          aliases: flagStr(args, 'alias')?.split(',').map((a) => a.trim()).filter(Boolean),
          onProgress: (line) => process.stdout.write(`  ${line}\n`),
        });
        process.stdout.write(
          `\n${'alias'.padEnd(16)}${'model'.padEnd(24)}${'score'.padEnd(7)}${'reason'.padEnd(8)}${'code'.padEnd(7)}` +
            `${'fidel'.padEnd(7)}${'tok/s'.padEnd(8)}cold\n`,
        );
        for (const m of [...report.models].sort((a, b) => b.score - a.score)) {
          process.stdout.write(
            `${m.alias.padEnd(16)}${m.model.padEnd(24)}${m.score.toFixed(2).padEnd(7)}` +
              `${m.byCategory.reasoning.toFixed(2).padEnd(8)}${m.byCategory.code.toFixed(2).padEnd(7)}` +
              `${m.byCategory.fidelity.toFixed(2).padEnd(7)}${String(m.tokensPerSec).padEnd(8)}${m.coldStartMs}ms` +
              `${m.ok ? '' : `  [${m.error}]`}\n`,
          );
        }
        process.stdout.write(`\nroster: ${Object.entries(report.roster).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}\n`);
        process.stdout.write(`written to ${benchPath()}\n`);
        store.close();
        return 0;
      }
      if (args.flags['latency']) {
        // Reads the events table directly, like --bench needs no daemon.
        const store = new Store(config.dbPath);
        const n = flagStr(args, 'n') ? Number(flagStr(args, 'n')) : 20;
        const raw = store.recentRunsForLatency(Number.isFinite(n) && n > 0 ? n : 20);
        store.close();
        if (!raw.length) {
          process.stdout.write('no runs recorded yet\n');
          return 0;
        }
        const report = computeLatencyReport(raw);
        process.stdout.write(`per-stage latency — last ${report.sampleRuns} run(s)\n\n`);
        process.stdout.write(
          `${'STAGE'.padEnd(11)}${'N'.padEnd(5)}${'MEDIAN'.padEnd(9)}${'P90'.padEnd(9)}SHARE\n`,
        );
        for (const s of report.stages) {
          process.stdout.write(
            `${s.stage.padEnd(11)}${String(s.count).padEnd(5)}${formatDuration(s.medianMs).padEnd(9)}` +
              `${formatDuration(s.p90Ms).padEnd(9)}${s.count ? `${s.shareOfTotalPct.toFixed(1)}%` : '—'}\n`,
          );
        }
        return 0;
      }
      const d = await apiCall('/api/doctor');
      // As THIS shell's environment has it: the daemon reads FOREMAN_SANDBOX from its own, at start.
      process.stdout.write(`${await sandboxSummary()}\n`);
      process.stdout.write(
        `home ${d.home}   workers ${d.workers.active}/${d.workers.max}` +
          `   verify lane ${d.workers.verifying}/${d.workers.verifyLane}\n`,
      );
      // The cutover block goes first because it is what an operator checking
      // readiness is here for; everything below is detail underneath it.
      process.stdout.write(
        `mode ${d.mode ?? (d.localOnly ? 'LOCAL-ONLY (no cloud models)' : 'mixed (cloud models allowed)')}\n` +
        `${d.memory ? `⚠ ${d.memory}\n` : ''}` +
        `   tiers owner=${d.tiers.owner} senior=${d.tiers.senior} worker=${d.tiers.worker}\n`,
      );
      if (d.personas?.length) {
        process.stdout.write('\nadopted personas:\n');
        for (const p of d.personas) {
          // A persona that is adopted but not served is the one state worth
          // shouting about: routing already points at it.
          process.stdout.write(
            `  ${p.serving ? 'ok  ' : 'DOWN'} ${String(p.alias).padEnd(20)} ${p.url}` +
            `${p.serving ? '' : `  — nothing is listening; run: foreman persona serve ${p.id}`}\n`,
          );
        }
      }
      process.stdout.write(`spend today $${d.budget.spentToday.toFixed(4)} of $${d.budget.dailyCapUsd.toFixed(2)} cap\n\nmodels:\n`);
      for (const m of d.models) {
        process.stdout.write(
          `  ${m.ok ? 'ok  ' : 'DOWN'} ${m.alias.padEnd(14)} ${m.provider}/${m.model}${m.local ? ' [local]' : ''}` +
            `${m.ok ? ` ${m.latencyMs}ms` : ` — ${m.error}`}\n`,
        );
      }
      process.stdout.write('\nrunners:\n');
      for (const r of d.runners) {
        process.stdout.write(`  ${r.ok ? 'ok  ' : 'n/a '} ${r.id.padEnd(14)}${r.ok ? '' : ` — ${r.reason}`}\n`);
      }
      process.stdout.write('\nagents:\n');
      if (!d.agents.length) process.stdout.write('  (none — drop .json or .md defs in $FOREMAN_HOME/agents)\n');
      for (const a of d.agents) {
        const warn = a.findings.filter((f: { severity: string }) => f.severity === 'warn').length;
        process.stdout.write(`  ok   ${a.id.padEnd(14)}${a.model ? a.model.padEnd(14) : ''.padEnd(14)}${a.description.slice(0, 60)}${warn ? `  [${warn} warning(s)]` : ''}\n`);
      }
      for (const r of d.refusedAgents) process.stdout.write(`  BLOCKED ${r.id} — ${r.reason}\n`);
      const parallelism = await checkOllamaParallelism();
      process.stdout.write(
        `\nollama parallelism: ${parallelism.numParallel ?? 'unknown'}` +
          `${parallelism.ok ? '' : `  ⚠ ${parallelism.advice}`}\n`,
      );
      process.stdout.write(`pre-warmed at boot: ${warmTargets().join(', ') || '(none)'}\n`);
      // Read here, from this shell's FOREMAN_SKILLS_DIR: the daemon reads its
      // own environment, and its /api/doctor does not report skills.
      process.stdout.write(`${skillsDoctorLine()}\n`);
      process.stdout.write(`${await workerSuiteInJail()}\n`);
      if (d.bench) {
        process.stdout.write(`\nbench (${new Date(d.bench.measuredAt).toLocaleString()}):\n`);
        for (const m of [...d.bench.models].sort((a: { score: number }, b: { score: number }) => b.score - a.score)) {
          process.stdout.write(`  ${m.alias.padEnd(16)}score ${m.score.toFixed(2)}  ${m.tokensPerSec} tok/s\n`);
        }
        process.stdout.write(`  roster: ${Object.entries(d.bench.roster).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
      } else {
        process.stdout.write('\nno bench yet — run: foreman doctor --bench\n');
      }
      return 0;
    }
    case 'receipts': {
      const taskId = args._[1];
      if (taskId) {
        const d = await apiCall(`/api/tasks/${taskId}`);
        let total = 0;
        for (const r of d.receipts) {
          total += Number(r.cost_usd);
          process.stdout.write(
            `  ${new Date(Number(r.created_at)).toLocaleTimeString()} ${String(r.kind).padEnd(8)} ${String(r.model).padEnd(20)}` +
              ` ${r.local ? 'local' : 'CLOUD'} in ${r.tokens_in} out ${r.tokens_out} $${Number(r.cost_usd).toFixed(4)} ${r.latency_ms}ms\n`,
          );
        }
        process.stdout.write(`  total $${total.toFixed(4)} across ${d.receipts.length} call(s)\n`);
        return 0;
      }
      const state = await apiCall('/api/state');
      const b = state.budget;
      process.stdout.write(
        `today: ${b.callsToday} model call(s), ${b.callsToday - b.nonLocalCallsToday} local · ` +
          `$${b.spentToday.toFixed(4)} of $${b.dailyCapUsd.toFixed(2)} cap\n`,
      );
      // Spend and time are the two costs of a run; report them together.
      const store = new Store(config.dbPath);
      const raw = store.recentRunsForLatency(20);
      store.close();
      if (raw.length) {
        const report = computeLatencyReport(raw);
        const busiest = report.stages.filter((st) => st.count > 0).sort((a, b2) => b2.medianMs - a.medianMs);
        process.stdout.write(`stage medians over the last ${report.sampleRuns} run(s): `);
        process.stdout.write(
          busiest.length
            ? `${busiest.map((st) => `${st.stage} ${formatDuration(st.medianMs)}`).join(' · ')}\n`
            : '(no completed stages yet)\n',
        );
      }
      return 0;
    }
    case 'verdict': {
      const taskId = args._[1];
      if (!taskId) throw new Error('usage: foreman verdict <taskId>');
      const d = await apiCall(`/api/tasks/${taskId}`);
      if (!d.verdicts.length) {
        process.stdout.write('no council verdict yet\n');
        return 0;
      }
      for (const v of d.verdicts) {
        process.stdout.write(`${new Date(v.createdAt).toLocaleString()}  ${v.verdict}${v.disagreement ? ' (split)' : ''}\n`);
        for (const o of v.council) {
          process.stdout.write(`  ${o.model}: ${o.error ?? `${o.verdict} (${o.confidence.toFixed(2)}) — ${o.critique}`}\n`);
        }
        if (v.chairSummary) process.stdout.write(`  ${chairRuled(v) ? 'chair' : 'note'}: ${v.chairSummary}\n\n`);
      }
      return 0;
    }
    case 'memory': {
      const sub = args._[1];
      if (sub === 'add') {
        const key = args._[2];
        const value = args._.slice(3).join(' ');
        if (!key || !value) throw new Error('usage: foreman memory add <key> <value> [--scope <scope>]');
        const fact = await apiCall('/api/memory', {
          method: 'POST',
          body: JSON.stringify({ key, value, scope: flagStr(args, 'scope') ?? 'global' }),
        });
        process.stdout.write(`${fact.id}  ${fact.scope}  ${fact.key} = ${fact.value}\n`);
        return 0;
      }
      if (sub === 'consolidate') {
        const r = await apiCall('/api/memory/consolidate', {
          method: 'POST',
          body: JSON.stringify({ scope: flagStr(args, 'scope') ?? 'global' }),
        });
        process.stdout.write(
          `${r.scope}: read ${r.episodesRead} episode(s) → wrote ${r.factsWritten} fact(s), retired ${r.retired}` +
            `${r.degraded ? ' [degraded]' : ''}\n${r.reason}\n`,
        );
        for (const f of r.facts) process.stdout.write(`  - ${f}\n`);
        return 0;
      }
      if (sub === 'rm') {
        const factId = args._[2];
        if (!factId) throw new Error('usage: foreman memory rm <id>');
        await apiCall(`/api/memory/${factId}`, { method: 'DELETE' });
        process.stdout.write(`${factId} retired\n`);
        return 0;
      }
      const scope = flagStr(args, 'scope') ?? 'global';
      const d = await apiCall(`/api/memory?scope=${encodeURIComponent(scope)}`);
      if (!d.facts.length) process.stdout.write('no facts remembered for this scope\n');
      for (const f of d.facts) {
        process.stdout.write(`  ${f.id}  ${f.confidence.toFixed(2)}  [${f.scope}] ${f.key}: ${f.value}\n`);
      }
      return 0;
    }
    case 'schedule': {
      const sub = args._[1] ?? 'ls';
      if (sub === 'add') {
        const title = args._.slice(2).join(' ').trim();
        const spec = flagStr(args, 'spec');
        const standingAsk = flagStr(args, 'ask');
        const prompt = flagStr(args, 'prompt') ?? standingAsk ?? title;
        if (!title || !spec) {
          throw new Error(
            'usage: foreman schedule add <title> --spec "daily 07:30" (--prompt <text> | --ask <request> | --improve)',
          );
        }
        const sched = await apiCall('/api/schedules', {
          method: 'POST',
          body: JSON.stringify({
            action: args.flags['improve'] ? 'improve' : standingAsk ? 'ask' : 'task',
            ask: standingAsk ?? flagStr(args, 'area') ?? null,
            repo: flagStr(args, 'repo') ?? null,
            title,
            spec,
            template: {
              title,
              prompt,
              kind: flagStr(args, 'kind'),
              runner: flagStr(args, 'runner'),
              repo: flagStr(args, 'repo') ?? null,
              sensitivity: flagStr(args, 'sensitivity'),
            },
          }),
        });
        process.stdout.write(`${sched.id}  ${sched.spec}  next ${new Date(Number(sched.next_run_at)).toLocaleString()}\n`);
        return 0;
      }
      if (sub === 'rm' || sub === 'toggle') {
        const scheduleId = args._[2];
        if (!scheduleId) throw new Error(`usage: foreman schedule ${sub} <id>`);
        if (sub === 'rm') {
          await apiCall(`/api/schedules/${scheduleId}`, { method: 'DELETE' });
          process.stdout.write(`${scheduleId} deleted\n`);
        } else {
          const s2 = await apiCall(`/api/schedules/${scheduleId}/toggle`, { method: 'POST' });
          process.stdout.write(`${s2.id} ${Number(s2.enabled) ? 'enabled' : 'paused'}\n`);
        }
        return 0;
      }
      const d = await apiCall('/api/schedules');
      if (!d.schedules.length) process.stdout.write('no schedules\n');
      for (const s3 of d.schedules) {
        process.stdout.write(
          `  ${s3.id}  ${Number(s3.enabled) ? 'on ' : 'off'}  ${String(s3.spec).padEnd(18)} next ${new Date(Number(s3.next_run_at)).toLocaleString()}  ${s3.title}\n`,
        );
      }
      return 0;
    }
    case 'prose': {
      const sub = args._[1];
      // Pure filesystem, like `crew init` — works without the daemon.
      if (sub === 'audit') {
        const dirArg = args._[2];
        if (!dirArg) throw new Error('usage: foreman prose audit <dir> [--json] [--strict]');
        const dir = path.resolve(dirArg);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
        const result = auditDir(dir);
        if (args.flags['json']) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(formatAuditReport(result) + '\n');
        }
        // The same bar the scheduler's check uses (auditHasBans): only a hard
        // tic ban or a bible always-violation is a failure, because a
        // manuscript in progress should not fail on style metrics. Exiting 1
        // on any warn made the CLI and the daemon disagree about the same book.
        // --strict is for the operator who wants the metrics enforced too.
        return (args.flags['strict'] ? result.findings.length > 0 : auditHasBans(result)) ? 1 : 0;
      }
      if (sub === 'import') {
        const fileArg = args._[2];
        const outArg = flagStr(args, 'out');
        if (!fileArg || !outArg) throw new Error('usage: foreman prose import <file> --out <dir>');
        const file = path.resolve(fileArg);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`file not found: ${file}`);
        const outDir = path.resolve(outArg);
        if (fs.existsSync(outDir)) {
          const existing = fs.readdirSync(outDir).filter((n) => !n.startsWith('.'));
          if (existing.length) throw new Error(`refusing to write into a non-empty directory: ${outDir}`);
        }
        const text = /\.docx$/i.test(file) ? docxToText(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8');
        const chapters = splitChapters(text);
        if (!chapters.length) throw new Error('nothing to import — the file produced no chapters');
        fs.mkdirSync(outDir, { recursive: true });
        const written: string[] = [];
        let n = 1;
        for (const ch of chapters) {
          if (ch.frontMatter) {
            fs.writeFileSync(path.join(outDir, 'front-matter.md'), ch.text.trim() + '\n');
            written.push('front-matter.md');
            continue;
          }
          const name = `chapter-${String(n).padStart(2, '0')}-${slugify(ch.title)}.md`;
          fs.writeFileSync(path.join(outDir, name), ch.text.trim() + '\n');
          written.push(name);
          n++;
        }
        const title = bookTitleFrom(text);
        process.stdout.write(
          `imported ${chapters.length} chapter(s) from ${path.basename(file)}${title ? ` ("${title}")` : ''}\n`,
        );
        for (const w of written) process.stdout.write(`  wrote ${path.join(outDir, w)}\n`);
        return 0;
      }
      throw new Error('usage: foreman prose audit <dir> [--json] | foreman prose import <file> --out <dir>');
    }
    case 'crew': {
      const sub = args._[1];
      // Zero-token: three local queries over tasks, verdicts and receipts. No
      // daemon either — `foreman receipts` reads the store the same way.
      if (sub === 'report') {
        const store = new Store(config.dbPath);
        const rows = store.crewReport();
        store.close();
        if (!rows.length) {
          process.stdout.write('no crew tickets on record yet\n');
          return 0;
        }
        process.stdout.write(
          `${'playbook'.padEnd(14)}${'role'.padEnd(12)}${'done'.padStart(5)}${'1st-pass'.padStart(10)}` +
            `${'repairs'.padStart(9)}${'map-repairs'.padStart(13)}${'cost'.padStart(11)}${'$/ticket'.padStart(11)}\n`,
        );
        for (const r of rows) {
          const pass = r.firstPassRate === null
            ? '     n/a'
            : `${(r.firstPassRate * 100).toFixed(0)}% (${r.firstReviewed})`;
          process.stdout.write(
            `${r.playbook.slice(0, 13).padEnd(14)}${r.role.slice(0, 11).padEnd(12)}` +
              `${String(r.tickets).padStart(5)}${pass.padStart(10)}${r.avgRepairs.toFixed(1).padStart(9)}${String(r.mapRepairs).padStart(13)}` +
              `${`$${r.costUsd.toFixed(4)}`.padStart(11)}${`$${r.avgCostUsd.toFixed(4)}`.padStart(11)}\n`,
          );
        }
        const incomplete = rows.reduce((n, r) => n + r.firstIncomplete, 0);
        if (incomplete) {
          process.stdout.write(`  (${incomplete} ticket(s) left out of 1st-pass: their first review lost a reviewer)\n`);
        }
        const advisories = crewAdvisories(rows);
        process.stdout.write('\n');
        for (const line of advisories) process.stdout.write(`  → ${line}\n`);
        if (!advisories.length) process.stdout.write('  no tier changes worth making on this evidence\n');
        return 0;
      }
      if (sub !== 'init') throw new Error('usage: foreman crew init | crew report');
      // Pure filesystem copy — no daemon needed, mirrors `foreman service`.
      const src = path.join(config.sourceRoot, 'playbooks');
      const dest = playbooksDir();
      fs.mkdirSync(dest, { recursive: true });
      const copied: string[] = [];
      const skipped: string[] = [];
      if (fs.existsSync(src)) {
        for (const name of fs.readdirSync(src).sort()) {
          if (!name.endsWith('.md')) continue;
          const destFile = path.join(dest, name);
          if (fs.existsSync(destFile)) {
            skipped.push(name);
            continue;
          }
          fs.copyFileSync(path.join(src, name), destFile);
          copied.push(name);
        }
      }
      process.stdout.write(`playbooks dir: ${dest}\n`);
      process.stdout.write(`copied: ${copied.join(', ') || '(none)'}\n`);
      process.stdout.write(`skipped (already present): ${skipped.join(', ') || '(none)'}\n`);
      return 0;
    }
    case 'playbooks': {
      const d = await apiCall('/api/playbooks');
      if (!d.playbooks.length) process.stdout.write('no playbooks loaded — run: foreman crew init\n');
      for (const p of d.playbooks) {
        process.stdout.write(`${p.id.padEnd(14)} ${p.description}\n`);
        process.stdout.write(`  roles: ${Object.entries(p.roles).map(([r, def]: [string, any]) => `${r}(${def.tier})`).join(', ')}\n`);
        process.stdout.write(
          `  reviewers: ${p.reviewers.map((r: { role: string; style: string }) => `${r.role}(${r.style})`).join(', ') || '(none)'}\n`,
        );
        const tools = Object.entries(p.tools ?? {}) as Array<[string, Array<{ name: string }>]>;
        if (tools.length) {
          process.stdout.write(
            `  tools: ${tools.map(([r, list]) => `${r}[${list.map((t) => t.name).join(' ')}]`).join('  ')}\n`,
          );
        }
      }
      for (const r of d.refused) process.stdout.write(`  BLOCKED ${r.id} — ${r.reason}\n`);
      for (const w of d.warnings ?? []) process.stdout.write(`  WARNING ${formatPlaybookWarning(w)}\n`);
      if (d.missingTools?.length) {
        // A standing request, not an error. The forge exists to answer it.
        process.stdout.write('\ntools these playbooks ask for and nobody has built:\n');
        for (const m of d.missingTools) {
          process.stdout.write(`  ${m.tool.padEnd(20)} wanted by ${m.playbook}.${m.role}${m.when ? ` — ${m.when.slice(0, 70)}` : ''}\n`);
        }
        process.stdout.write("\nBuild one with:  foreman add \"build the <name> tool\" --kind tool --prompt \"...\"\n");
      }
      return 0;
    }
    case 'skills': {
      // Pure filesystem reads — no daemon, like `foreman crew init`. What it
      // shows is this shell's FOREMAN_SKILLS_DIR and playbooks dir.
      const sub = args._[1] ?? 'ls';
      if (sub === 'ls') {
        process.stdout.write(formatSkillList());
        return 0;
      }
      if (sub !== 'show') throw new Error('usage: foreman skills | skills show <playbook> <role> [--variant full|card]');
      const pbId = args._[2];
      const role = args._[3];
      if (!pbId || !role) throw new Error('usage: foreman skills show <playbook> <role> [--variant full|card]');
      const pb = getPlaybook(pbId);
      if (!pb) throw new Error(`no playbook '${pbId}' is loaded from ${playbooksDir()}`);
      const roleDef = pb.roles[role];
      if (!roleDef) throw new Error(`playbook '${pbId}' has no role '${role}'`);
      const asked = flagStr(args, 'variant');
      if (asked !== undefined && asked !== 'full' && asked !== 'card') throw new Error('--variant is full or card');
      const block = skillBlock(pb, role, asked ?? skillVariantFor(tierModel(roleDef.tier)));
      if (block) {
        process.stdout.write(`${block}\n`);
        return 0;
      }
      // Nothing is served, so the brief carries no block at all. Say why on
      // stderr, so stdout stays exactly what the brief gets: nothing.
      const { dropped } = skillsFor(pbId, role, { names: pb.skills?.[role] ?? null });
      process.stderr.write(
        `${config.skillsDir ? `no skills for ${pbId}.${role}` : 'skills are off (FOREMAN_SKILLS_DIR is not set)'}` +
          `${dropped.map((d) => `\n  left out: ${JSON.stringify(d.name)} — ${d.reason}`).join('')}\n`,
      );
      return 0;
    }
    case 'playbook': {
      const sub = args._[1] ?? 'pending';
      const roleLine = (p: any): string =>
        Object.entries(p.roles).map(([r, def]: [string, any]) => `${r}(${def.tier})`).join(', ');
      if (sub === 'forge') {
        const domain = args._[2];
        if (!domain) throw new Error('usage: foreman playbook forge "<domain>" [--ask "<request>"]');
        const d = await apiCall('/api/playbooks/forge', {
          method: 'POST',
          body: JSON.stringify({ domain, ask: flagStr(args, 'ask') ?? null }),
        });
        const p = d.playbook;
        process.stdout.write(`drafted ${p.id}: ${p.description}\n`);
        process.stdout.write(`  roles: ${roleLine(p)}\n`);
        process.stdout.write(
          `  reviewers: ${p.reviewers.map((r: { role: string; style: string }) => `${r.role}(${r.style})`).join(', ') || '(none)'}\n`,
        );
        process.stdout.write(`  escalation chair: ${p.escalation.chair}  gate: ${p.gate.default} (hard: ${p.gate.hardHuman.join(', ')})\n`);
        for (const c of p.constraints) process.stdout.write(`  constraint: ${c}\n`);
        for (const w of d.warnings) process.stdout.write(`  ! ${w}\n`);
        process.stdout.write(`  cost: $${Number(d.costUsd ?? 0).toFixed(4)}\n`);
        process.stdout.write(`\npending: ${d.path}\n`);
        // Nothing about a forged playbook takes effect until this line is run.
        process.stdout.write(`read it, then approve with: foreman playbook approve ${p.id}\n`);
        return 0;
      }
      if (sub === 'pending') {
        const d = await apiCall('/api/playbooks/pending');
        if (!d.drafts.length && !d.refused.length) process.stdout.write('no drafts pending\n');
        for (const p of d.drafts) {
          process.stdout.write(`${p.id.padEnd(14)} ${p.description}\n`);
          process.stdout.write(`  roles: ${roleLine(p)}\n`);
          // The fields approve refuses on are printed, not summarized: a draft
          // is hand-editable while it sits here, so what the reviewer reads has
          // to be what approvePending will check (checks must be empty, the
          // gate must be human, and the hard-human trio must be there).
          process.stdout.write(`  gate: ${p.gate.default} (hard: ${p.gate.hardHuman.join(', ') || 'none'})\n`);
          process.stdout.write(`  checks: ${p.checks.length ? p.checks.join(' | ') : '(none)'}\n`);
          for (const c of p.constraints) process.stdout.write(`  constraint: ${c}\n`);
          if (!p.constraints.length) process.stdout.write('  constraint: (none)\n');
          process.stdout.write(`  file: ${p.source}\n`);
          process.stdout.write(`  approve with: foreman playbook approve ${p.id}\n`);
        }
        for (const r of d.refused) process.stdout.write(`  BLOCKED ${r.id} — ${r.reason}\n`);
        return 0;
      }
      const pbId = args._[2];
      if (!pbId || (sub !== 'approve' && sub !== 'reject')) {
        throw new Error('usage: foreman playbook forge "<domain>" | playbook pending | playbook approve|reject <id>');
      }
      const d = await apiCall(`/api/playbooks/${pbId}/${sub}`, { method: 'POST' });
      process.stdout.write(
        sub === 'approve' ? `installed ${d.installed.id} at ${d.installed.source}\n` : `discarded ${d.id} (${d.path})\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

const code = await main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
if (code >= 0) process.exit(code);
