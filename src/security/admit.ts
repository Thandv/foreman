import { execFileSync } from 'node:child_process';
import { isSelfTask, PROTECTED_PATHS } from './coreGuard.ts';
import { localOnly, localOnlyLabel } from '../localOnly.ts';
import type { Task } from '../types.ts';

export class AdmissionBlocked extends Error {}

export interface Finding {
  severity: 'note' | 'warn' | 'block';
  rule: string;
  message: string;
}

interface Rule {
  severity: Finding['severity'];
  rule: string;
  pattern: RegExp;
  message: string;
}

/**
 * Deliberately narrow: each pattern describes something that is almost never
 * what a task legitimately asks for. Broad rules that fire on ordinary work
 * train the operator to ignore the scanner.
 */
const RULES: Rule[] = [
  { severity: 'block', rule: 'wipe-root', pattern: /\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME)(\s|$)/i, message: 'attempts to delete the filesystem root or home directory' },
  { severity: 'block', rule: 'fork-bomb', pattern: /:\(\)\s*\{\s*:\|\:&\s*\}\s*;?\s*:/, message: 'fork bomb' },
  { severity: 'block', rule: 'remote-exec', pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, message: 'pipes a remote script straight into a shell' },
  // Command-shaped only: at a line start, after a shell separator, or in a
  // backtick. Prose that merely mentions sudo (a prompt about the sudo *rule*)
  // is a warning, not a refusal — a scanner that blocks ordinary sentences
  // teaches the operator to route around it.
  { severity: 'block', rule: 'privilege', pattern: /(^|\n|[;&|]\s*|`|\$\()\s*sudo\s+\S/i, message: 'runs a command as root' },
  { severity: 'warn', rule: 'privilege-mention', pattern: /\bsudo\b/i, message: 'mentions sudo' },
  { severity: 'block', rule: 'persistence', pattern: /(LaunchAgents|LaunchDaemons|crontab\s+-|systemctl\s+enable)/i, message: 'installs a persistent background job' },
  { severity: 'block', rule: 'permission-bypass', pattern: /--dangerously-skip-permissions|--yolo\b/i, message: 'asks a runner to bypass its own permission gate' },
  { severity: 'block', rule: 'secret-exfil', pattern: /(\.ssh\/|\.aws\/credentials|\.env\b|security\s+find-generic-password|id_rsa)[\s\S]{0,200}?\b(curl\b|wget\b|nc\b|scp\b|http)/i, message: 'reads credentials and then sends them somewhere' },
  { severity: 'warn', rule: 'publish', pattern: /\b(npm\s+publish|git\s+push|gh\s+release\s+create|twine\s+upload)\b/i, message: 'publishes or pushes outward' },
  { severity: 'warn', rule: 'history-rewrite', pattern: /\bgit\s+(push\s+(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f)/i, message: 'rewrites or discards git state' },
  { severity: 'warn', rule: 'destructive-sql', pattern: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;)/i, message: 'destructive SQL' },
  { severity: 'warn', rule: 'loose-perms', pattern: /\bchmod\s+(-R\s+)?777\b/, message: 'world-writable permissions' },
  // Every alternative closes on its own boundary. `\bcurl` with no trailing
  // \b flags the word "curly" as a network call, which is how a book's style
  // sheet ("curly quotes") came to be scanned as one.
  { severity: 'note', rule: 'network', pattern: /\b(curl\b|wget\b|fetch\()/i, message: 'makes network calls' },
];

function scanText(text: string): Finding[] {
  return RULES.filter((r) => r.pattern.test(text)).map((r) => ({
    severity: r.severity,
    rule: r.rule,
    message: r.message,
  }));
}

/** Use the real scanner when it is installed; fall back to the built-in rules. */
function friskFindings(text: string): Finding[] | null {
  try {
    const out = execFileSync('frisk-scan', ['--stdin', '--json'], {
      input: text,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out) as { findings?: Array<{ severity?: string; rule?: string; message?: string }> };
    return (parsed.findings ?? []).map((f) => ({
      severity: (f.severity === 'block' || f.severity === 'warn' ? f.severity : 'note') as Finding['severity'],
      rule: f.rule ?? 'frisk',
      message: f.message ?? 'frisk finding',
    }));
  } catch {
    return null; // not installed, or it failed — the built-in rules still run
  }
}

/**
 * Screen a command the *model* wrote, which never passed task admission.
 * Returns the reason to refuse, or null to allow.
 */
export function scanCommand(command: string): string | null {
  const blocked = scanText(command).filter((f) => f.severity === 'block');
  return blocked.length ? blocked.map((b) => `${b.rule} — ${b.message}`).join('; ') : null;
}

/**
 * `text` with every path list that follows a prohibition ("do not touch A, B or C", "never edit A", "without touching
 * A") blanked out, so naming a core file to keep a worker away from it does not count as targeting it. Only the list
 * right after the prohibition is removed: it ends at the first word that is not a path or a list joiner, so
 * "do not touch X but rewrite Y" still names Y. A self-improvement epic was refused whole for saying "Do NOT touch
 * src/merge.ts, ..."; the produced diff is still checked against the protected paths either way. A read permission
 * ("you may read src/merge.ts") is treated the same way: reading is not targeting, and a worker can read anything.
 * The list may be introduced by "any of:" ("Do not modify any of: A, B."), which is how `foreman improve` words its
 * own constraint; without that every improve task named the whole protected list.
 */
const FORBIDDEN_LIST =
  /(?:\b(?:(?:do|does|must|may|should)\s+not|don't|never|not)\s+(?:touch|edit|modify|change|alter)\s+|\bwithout\s+(?:touching|editing|modifying|changing)\s+|\b(?:may|can)\s+read\s+)(?:any\s+of\s*:?\s+)?/gi;
const LIST_ITEM = /^`?[\w./-]+`?(?:\s*,\s*(?:(?:or|and|nor)\s+)?|\s+(?:or|and|nor)\s+)?/;

export function withoutForbiddenLists(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(FORBIDDEN_LIST)) {
    if (m.index < last) continue;
    let end = m.index + m[0].length;
    for (let item = LIST_ITEM.exec(text.slice(end)); item && item[0]; item = LIST_ITEM.exec(text.slice(end))) end += item[0].length;
    out += text.slice(last, m.index + m[0].length);
    last = end;
  }
  return out + text.slice(last);
}

/** The text of a task that admission reads. */
function admissionText(task: Task): string {
  return [task.title, task.prompt, task.agent ?? '', task.testCmd ?? ''].join('\n');
}

/**
 * The protected paths a task against Foreman itself names outside a
 * prohibition; empty for any other task, and for one carrying allowCore.
 * `selfRoot` stands in for Foreman's own checkout in tests. `isSelf` is the
 * caller's own `isSelfTask` answer for this task, so a run asks git once.
 */
export function namedCorePaths(task: Task, selfRoot?: string, isSelf?: boolean): string[] {
  if (!(isSelf ?? isSelfTask(task, selfRoot)) || task.allowCore) return [];
  const targeted = withoutForbiddenLists(admissionText(task));
  return PROTECTED_PATHS.filter((p) => targeted.includes(p));
}

/**
 * Admission control. Throws AdmissionBlocked on any BLOCK finding — that
 * outcome is not configurable, by design. Returns the survivable findings so
 * the caller can record them.
 */
export function admit(task: Task, opts: { selfRoot?: string; /** The caller's `isSelfTask` answer, when it has one. */ isSelf?: boolean } = {}): Finding[] {
  const text = admissionText(task);
  const findings = [...(friskFindings(text) ?? []), ...scanText(text)];

  // A task that targets Foreman itself and names a protected path is admitted
  // with a warning, not refused (operator decision, 2026-10-10). Naming is not
  // editing: a brief that only DESCRIBES src/merge.ts ("src/merge.ts returns
  // merged:false") was refused whole, and with the longer protected list most
  // briefs about Foreman name one. What stops the change is elsewhere: the run
  // check and the landing check (they live in scheduler.ts and merge.ts and use
  // security/coreGuard.ts) refuse a change to a protected path without
  // --allow-core, the warning leads the gate item, and a person lands every
  // change to Foreman. Those hold against a worker that makes a mistake, not
  // against code that drives the daemon's own API.
  const named = namedCorePaths(task, opts.selfRoot, opts.isSelf);
  if (named.length) {
    findings.push({
      severity: 'warn',
      rule: 'core-guard',
      message: `names ${named.join(', ')}: a change to a protected path is refused at the run check and at landing without --allow-core`,
    });
  }

  // Cloud-billed CLI runners cannot honour an S2 (local-only) promise.
  const hostedRunner = task.runner === 'claude-code' || task.runner === 'codex-cli';
  if (task.sensitivity === 'S2' && hostedRunner) {
    findings.push({
      severity: 'block',
      rule: 's2-runner',
      message: `S2 tasks may not use the '${task.runner}' runner: it sends the prompt to a hosted model`,
    });
  }
  // ...and in local-only mode no task can, whatever its sensitivity. Refusing
  // at admission rather than at launch matters: a hosted-runner task admitted
  // now would cut a worktree, provision deps and only then discover it has no
  // model — a failure that looks like the work going wrong rather than like a
  // configuration that cannot run.
  if (localOnly() && hostedRunner) {
    findings.push({
      severity: 'block',
      rule: 'local-only-runner',
      message: `${localOnlyLabel()}: the '${task.runner}' runner drives a hosted model. Use the 'api' runner.`,
    });
  }

  const blocks = findings.filter((f) => f.severity === 'block');
  if (blocks.length) {
    throw new AdmissionBlocked(
      `admission refused (${blocks.length} blocking finding${blocks.length > 1 ? 's' : ''}): ` +
        blocks.map((b) => `${b.rule} — ${b.message}`).join('; '),
    );
  }
  const seen = new Set<string>();
  return findings.filter((f) => (seen.has(f.rule) ? false : (seen.add(f.rule), true)));
}
