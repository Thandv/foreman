/**
 * The OS sandbox around code a worker wrote: the repo's test command, a playbook check, the `shell` runner, the api
 * runner's `run_shell` and `use_tool`, the post-merge check. A jail is a worktree, not a boundary — a test command could write the
 * real repo's `.git`, the operator's home, Foreman's database, or call the control port. Under `sandbox-exec` it can
 * write only its jail and its private temp/home, read nothing a person owns, and not open the control port.
 *
 * FOREMAN_SANDBOX=off|tests|all (unset = tests). `off` is the rollback: nothing here runs. The claude-code worker
 * itself is NOT sandboxed by this file yet; `all` is accepted and behaves as `tests` until that lands.
 *
 * Rules this file keeps:
 *  - the profile text is never built here. The .sb files beside this one are used as they are; everything that
 *    varies goes in as a `-D NAME=value` argv entry, so a path with a space, a quote or a parenthesis is data;
 *  - every path parameter is a REAL path (the kernel matches resolved paths: /tmp is /private/tmp);
 *  - profiles are read from the daemon's own source root, never from a jail;
 *  - when the sandbox is on and cannot be used, the command does not run. The one exception is `nested`: this
 *    process is already inside a sandbox (a sandbox cannot be nested, and cannot be loosened), so it runs plain.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { nodeInstall, type NodeInstall } from './nodeRoot.ts';

export type SandboxMode = 'off' | 'tests' | 'all';
export type SandboxKind = 'git' | 'tests' | 'worker';

/** A reason the sandbox cannot be used. The caller fails the run with it; it never falls back to unsandboxed. */
export class SandboxError extends Error {}

const SWITCH_HINT = 'Set FOREMAN_SANDBOX=off to run without the sandbox.';

/** Loopback ports closed besides the control port when FOREMAN_SANDBOX_DENY_PORTS is unset: common local dashboard and git-forge ports. */
export const DEFAULT_DENY_PORTS = [8000, 8001, 8002, 3010];
const MAX_LIST = 4;

// Test seams. Nothing outside test/sandbox.test.ts sets these; they exist so "sandbox-exec is missing" and "the
// profile does not compile" can be driven without touching /usr/bin.
let execPath = '/usr/bin/sandbox-exec';
let profileDirOverride: string | null = null;
let nodeExecOverride: string | null = null;
export function _setSandboxSeamsForTest(seams: { exec?: string; profileDir?: string | null; nodeExec?: string | null } | null): void {
  execPath = seams?.exec ?? '/usr/bin/sandbox-exec';
  profileDirOverride = seams?.profileDir ?? null;
  nodeExecOverride = seams?.nodeExec ?? null;
  available = null;
}

function profileDir(): string {
  return profileDirOverride ?? path.join(config.sourceRoot, 'src', 'security', 'sandbox');
}

/** The switch. Read on every call (it is one env lookup), so an unknown value can never be cached as `off`. */
export function sandboxMode(): SandboxMode {
  const raw = (process.env['FOREMAN_SANDBOX'] ?? '').trim().toLowerCase();
  if (raw === '') return 'tests';
  if (raw === 'off' || raw === 'tests' || raw === 'all') return raw;
  throw new SandboxError(`FOREMAN_SANDBOX must be off, tests or all, got ${JSON.stringify(process.env['FOREMAN_SANDBOX'])}`);
}

/** The loopback ports a sandboxed command may not connect to, besides the control port. */
export function denyPorts(): number[] {
  const raw = process.env['FOREMAN_SANDBOX_DENY_PORTS'];
  if (raw === undefined) return [...DEFAULT_DENY_PORTS];
  const ports = raw.split(/[\s,:]+/).filter(Boolean).map((p) => {
    const n = Number(p);
    if (!/^\d+$/.test(p) || n < 1 || n > 65535) {
      throw new SandboxError(`FOREMAN_SANDBOX_DENY_PORTS: ${JSON.stringify(p)} is not a port (1-65535)`);
    }
    return n;
  });
  if (ports.length > MAX_LIST) throw new SandboxError(`FOREMAN_SANDBOX_DENY_PORTS takes at most ${MAX_LIST} ports, got ${ports.length}`);
  return ports;
}

/**
 * FOREMAN_SANDBOX_ALLOW: allowances that are off unless the operator names them, because each lets a little of the
 * outside in. Known: `fsevents` — file watching (node's fs.watch, FSEvents). With it a sandboxed command can also
 * learn the NAMES (never the contents) of short-lived files created directly inside the directories above its jail,
 * TMPDIR and HOME. An unknown name is an error, not ignored.
 */
const ALLOWANCES = ['fsevents'] as const;
export type SandboxAllowance = (typeof ALLOWANCES)[number];
export function sandboxAllowances(): SandboxAllowance[] {
  const names = (process.env['FOREMAN_SANDBOX_ALLOW'] ?? '').split(/[\s,]+/).filter(Boolean).map((n) => n.toLowerCase());
  for (const n of names) {
    if (!(ALLOWANCES as readonly string[]).includes(n)) {
      throw new SandboxError(`FOREMAN_SANDBOX_ALLOW: ${JSON.stringify(n)} is not known (known: ${ALLOWANCES.join(', ')})`);
    }
  }
  return ALLOWANCES.filter((a) => names.includes(a));
}

/** FOREMAN_SANDBOX_RO: extra read-only trees, colon-separated. */
function envReadOnly(): string[] {
  return (process.env['FOREMAN_SANDBOX_RO'] ?? '').split(':').map((p) => p.trim()).filter(Boolean);
}

/**
 * realpath, for a path whose tail may not exist yet (FOREMAN_HOME before first use): the deepest existing ancestor
 * is resolved and the rest appended. A rule written with an unresolved spelling never matches.
 */
async function real(p: string): Promise<string> {
  if (!path.isAbsolute(p)) throw new SandboxError(`sandbox path must be absolute, got ${JSON.stringify(p)}`);
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.promises.realpath(head), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const up = path.dirname(head);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || up === head) {
        throw new SandboxError(`sandbox path ${JSON.stringify(p)} cannot be resolved: ${(err as Error).message}`);
      }
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** /System/Volumes/Data/Users/x is /Users/x (a firmlink: realpath leaves it as written). Compared in the short spelling. */
const DATA_VOLUME = '/System/Volumes/Data';
const short = (p: string): string => (p === DATA_VOLUME ? '/' : p.startsWith(`${DATA_VOLUME}/`) ? p.slice(DATA_VOLUME.length) : p);

/**
 * The trees a read-only give-back must not be, or contain. The give-backs are written AFTER the profile's deny rules
 * and the last matching rule decides, so FOREMAN_SANDBOX_RO=/Users (or the home, or the temp dir the private homes
 * live in) would hand a sandboxed command everything the sandbox closes there. A subtree of any of them is what the
 * knob is for and stays allowed.
 */
async function closedRoots(home: string, jail: string, opts: WrapOptions): Promise<[string, string][]> {
  const roots: [string, string][] = [
    ['/', 'the filesystem root'],
    ['/Users', '/Users'],
    ['/Volumes', '/Volumes'],
    ['/private', '/private'],
    ['/private/tmp', 'the shared temp dir /tmp'],
    ['/private/var', '/var'],
    ['/private/var/tmp', 'the shared temp dir /var/tmp'],
    ['/private/var/folders', 'the per-user temp dirs'],
    // The rest of base.sb's closed list: a give-back above one of these would open it again the same way.
    ['/private/var/root', "root's home"],
    ['/private/var/db/sudo', "sudo's records"],
    ['/opt/homebrew/var', "Homebrew's service data (/opt/homebrew/var)"],
    ['/usr/local/var', "Homebrew's service data (/usr/local/var)"],
    ['/Library/Keychains', 'the system keychains'],
    [home, "Foreman's home"],
    [await real(config.workRoot), 'the directory the jails live in'],
    [path.dirname(jail), "the directory above the run's jail"],
  ];
  const homes = [process.env['HOME'], os.homedir()];
  try {
    homes.push(os.userInfo().homedir);
  } catch {
    /* no passwd entry: HOME is all there is */
  }
  for (const h of homes) if (h && path.isAbsolute(h)) roots.push([await real(h), 'your home directory']);
  roots.push([await real(os.tmpdir()), 'the temp dir the private homes live in']);
  // The real repository: named outright for a clone jail, the directory holding `.git` for a worktree jail.
  const repos: string[] = [];
  if (opts.realRepo) repos.push(await real(opts.realRepo));
  if (opts.realGit) {
    const g = await real(opts.realGit);
    repos.push(path.basename(g) === '.git' ? path.dirname(g) : g);
  }
  for (const r of repos) roots.push([r, 'the real repository'], [path.dirname(r), 'the directory above the real repository']);
  return roots.map(([p, what]) => [short(p), what]);
}

/** The trees base.sb closes to reads (its step 2), in the short spelling. Kept in step with base.sb by hand. */
const PROFILE_CLOSED: [string, string][] = [
  ['/Users', '/Users'],
  ['/Volumes', '/Volumes'],
  ['/private/tmp', 'the shared temp dir /tmp'],
  ['/private/var/folders', 'the per-user temp dirs'],
  ['/private/var/tmp', 'the shared temp dir /var/tmp'],
  ['/private/var/root', "root's home"],
  ['/private/var/db/sudo', "sudo's records"],
  ['/opt/homebrew/var', "Homebrew's service data (/opt/homebrew/var)"],
  ['/usr/local/var', "Homebrew's service data (/usr/local/var)"],
  ['/Library/Keychains', 'the system keychains'],
];

/** What the sandbox does about the running node: a root to give back read-only (NODE_ROOT), and/or a line to say. */
export interface NodeGiveBack {
  root: string | null;
  note: string | null;
}

/**
 * The running node's install root, given back READ-ONLY so a sandboxed `node`/`npm` can start when node lives where
 * the sandbox closes reads (nvm under the home, a tarball in a temp dir). Separate from FOREMAN_SANDBOX_RO:
 * it never takes one of the four places. Nothing is added when node is already readable (Homebrew, /usr/local,
 * the system). It is added only when it is a node install and nothing else (nodeRoot.ts), is not inside Foreman's
 * home or the real repository, and is not, and does not contain, a tree the sandbox closes (closedRoots: /, /Users,
 * your home, the temp dir roots, Foreman's home, the jails' directory, the repository). Otherwise nothing is added
 * and `note` says sandboxed commands may not find node and what to do. Pure: a test passes in what it needs.
 */
export function nodeGiveBack(inst: NodeInstall, foremanHome: string, closed: [string, string][]): NodeGiveBack {
  const tree = short(inst.tree);
  const shut = PROFILE_CLOSED.find(([c]) => inside(tree, c)) ?? (inside(tree, short(foremanHome)) ? [foremanHome, "Foreman's home"] : null);
  if (!shut) return { root: null, note: null };
  const lead = `sandboxed commands may not find node: ${inst.exe} is under ${shut[1]}, which the sandbox closes,`;
  if (inside(tree, short(foremanHome))) {
    return { root: null, note: `${lead} and it is inside Foreman's home (${foremanHome}), which is never given back. Install node outside FOREMAN_HOME.` };
  }
  const repo = closed.find(([c, what]) => what === 'the real repository' && inside(tree, c));
  const hit = repo ?? closed.find(([c]) => inside(c, tree));
  if (hit) {
    return {
      root: null,
      note: `${lead} and its install directory ${inst.tree} was not given back: it ${repo ? 'is inside' : 'is, or contains,'} ${hit[1]}${hit[1] === hit[0] ? '' : ` (${hit[0]})`}. ` +
        'Install node in a directory of its own (a version manager such as nvm does), or name the tree holding bin/node and lib/node_modules in FOREMAN_SANDBOX_RO',
    };
  }
  if (!inst.root) {
    return {
      root: null,
      note: `${lead} and ${inst.tree} was not given back because it does not look like a node install only (${inst.why}). ` +
        `If it holds nothing private, name it: FOREMAN_SANDBOX_RO=${inst.tree}`,
    };
  }
  return { root: inst.root, note: null };
}

async function nodeFor(home: string, closed: [string, string][]): Promise<NodeGiveBack> {
  return nodeGiveBack(await nodeInstall(nodeExecOverride ?? process.execPath, process.env['PATH'] ?? ''), home, closed);
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin' }, cwd: '/' }, (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, stderr, error: null });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (typeof e.code === 'number') return resolve({ code: e.code, stderr, error: null });
      resolve({ code: null, stderr, error: e.killed ? `no answer in ${Math.round(timeoutMs / 1000)}s` : e.message });
    });
  });
}

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

let available: Promise<string> | null = null;

/**
 * Whether sandbox-exec can be used from this process: 'ok'; 'nested' when this process is itself inside a sandbox
 * (sandbox_apply is refused: no environment variable is trusted for this); otherwise the reason. 'ok' and 'nested'
 * are remembered; a failure is asked again next time, so one bad moment does not fail every run until a restart.
 */
export function sandboxAvailable(): Promise<'ok' | 'nested' | string> {
  if (available) return available;
  const probe = (async (): Promise<string> => {
    if (process.platform !== 'darwin') return `the sandbox needs macOS sandbox-exec (this is ${process.platform})`;
    try {
      await fs.promises.access(execPath, fs.constants.X_OK);
    } catch {
      return `${execPath} is missing or not executable`;
    }
    const r = await run(execPath, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    if (r.code === 0) return 'ok';
    // Exactly what a second sandbox_apply() answers; any other failure is a broken sandbox, not a nested one.
    if (r.code === 71 && /sandbox_apply: Operation not permitted/.test(r.stderr)) return 'nested';
    return `${execPath} does not work here: ${firstLine(r.stderr) || r.error || `exit ${r.code}`}`;
  })();
  available = probe;
  void probe.then((answer) => {
    if (answer !== 'ok' && answer !== 'nested' && available === probe) available = null;
  });
  return probe;
}

/**
 * What a caller about to spawn worker-written code must do: 'off' and 'nested' spawn plain, 'on' spawns through
 * wrapChecked(). Throws SandboxError when the switch asks for the sandbox and it cannot be used.
 */
export async function sandboxState(): Promise<'off' | 'on' | 'nested'> {
  if (sandboxMode() === 'off') return 'off';
  const answer = await sandboxAvailable();
  if (answer === 'ok') return 'on';
  if (answer === 'nested') return 'nested';
  throw new SandboxError(`the sandbox is on (FOREMAN_SANDBOX=${sandboxMode()}) but cannot be used: ${answer}. ${SWITCH_HINT}`);
}

export interface WrapOptions {
  /** The run's working directory: read + write. */
  jail: string;
  /** The run's private TMPDIR: read + write. */
  tmp: string;
  /** The run's private HOME: read + write. */
  home: string;
  /** The git directory a worktree jail reads through (the real repo's `.git`): read-only. */
  realGit?: string | null;
  /** A clone jail's source repository: only its `.git/objects` is readable. */
  realRepo?: string | null;
  /** Extra read-only trees, added to FOREMAN_SANDBOX_RO. */
  readOnly?: string[];
  claudeCfg?: string;
  slotSock?: string;
}

/**
 * The argv that runs `cmd args…` inside the `kind` sandbox. Throws SandboxError on a relative path, on more than
 * four read-only trees or denied ports, on a read-only tree inside Foreman's home, on one that is or contains a
 * tree the sandbox closes (closedRoots), and when Foreman's home sits inside a directory the command may write
 * (the give-back would hand it the database). The running node's install root is added read-only on its own
 * (NODE_ROOT, nodeGiveBack), never counted against the four.
 */
export async function wrap(kind: SandboxKind, opts: WrapOptions, cmd: string, args: string[]): Promise<{ cmd: string; args: string[] }> {
  const home = await real(config.home);
  const jail = await real(opts.jail);
  const tmp = await real(opts.tmp);
  const runHome = await real(opts.home);
  for (const [name, dir] of [['jail', jail], ['TMPDIR', tmp], ['HOME', runHome]] as const) {
    if (inside(home, dir)) {
      throw new SandboxError(`the run's ${name} (${dir}) contains Foreman's home (${home}); a sandboxed command could write Foreman's state`);
    }
  }
  // The same tree named twice (the toolbox by Foreman and again in FOREMAN_SANDBOX_RO) takes one slot.
  const closed = await closedRoots(home, jail, opts);
  const ro: string[] = [];
  for (const p of [...(opts.readOnly ?? []), ...envReadOnly()]) {
    const r = await real(p);
    if (inside(r, home)) throw new SandboxError(`read-only tree ${r} is inside Foreman's home; refused (FOREMAN_SANDBOX_RO)`);
    const hit = closed.find(([root]) => inside(root, short(r)));
    if (hit) {
      throw new SandboxError(
        `read-only tree ${JSON.stringify(p)}${r === p ? '' : ` (${r})`} is, or contains, ${hit[1]}${hit[1] === hit[0] ? '' : ` (${hit[0]})`}: ` +
          'it would open everything the sandbox closes there; refused. Name the one subtree the command needs (FOREMAN_SANDBOX_RO)',
      );
    }
    if (!ro.includes(r)) ro.push(r);
  }
  if (ro.length > MAX_LIST) throw new SandboxError(`at most ${MAX_LIST} read-only trees (FOREMAN_SANDBOX_RO), got ${ro.length}`);
  // The running node's install root, outside the four places; nothing when node is readable already or the root is
  // too broad (then sandboxSummary says so at serve and in doctor).
  const node = await nodeFor(home, closed);
  const ports = denyPorts();
  const allowances = sandboxAllowances();
  // Port 0 is "pick one" (the test suite's daemon): there is no fixed control port to close, and the profile needs a number.
  const control = config.port >= 1 && config.port <= 65535 ? config.port : 1;

  const defs: [string, string][] = [
    ['PROFILE_DIR', await real(profileDir())],
    ['JAIL', jail],
    ['TMP', tmp],
    ['RUNHOME', runHome],
    ['FOREMAN_HOME', home],
    ['CONTROL_PORT', String(control)],
  ];
  if (opts.realGit) defs.push(['REAL_GIT', await real(opts.realGit)]);
  if (opts.realRepo) defs.push(['REAL_REPO', await real(opts.realRepo)]);
  ro.forEach((p, i) => defs.push([`RO_${i + 1}`, p]));
  if (node.root) defs.push(['NODE_ROOT', node.root]);
  ports.forEach((p, i) => defs.push([`DENY_PORT_${i + 1}`, String(p)]));
  for (const a of allowances) defs.push([`ALLOW_${a.toUpperCase()}`, '1']);
  if (opts.claudeCfg) defs.push(['CLAUDE_CFG', await real(opts.claudeCfg)]);
  if (opts.slotSock) defs.push(['SLOT_SOCK', await real(opts.slotSock)]);

  const argv: string[] = [];
  for (const [name, value] of defs) argv.push('-D', `${name}=${value}`);
  argv.push('-f', path.join(await real(profileDir()), `profile-${kind}.sb`), cmd, ...args);
  return { cmd: execPath, args: argv };
}

/**
 * wrap(), then prove that exact sandbox starts: the same parameters around /usr/bin/true must exit 0. A profile that
 * does not compile, a missing .sb file, a sandbox-exec that stopped working — each is a SandboxError naming the
 * switch, and the command is never spawned. One extra short process per run.
 */
export async function wrapChecked(kind: SandboxKind, opts: WrapOptions, cmd: string, args: string[]): Promise<{ cmd: string; args: string[] }> {
  const probe = await wrap(kind, opts, '/usr/bin/true', []);
  const r = await run(probe.cmd, probe.args);
  if (r.code !== 0) {
    throw new SandboxError(
      `the sandbox is on (FOREMAN_SANDBOX=${sandboxMode()}) but did not start: ${firstLine(r.stderr) || r.error || `exit ${r.code}`}. ${SWITCH_HINT}`,
    );
  }
  return wrap(kind, opts, cmd, args);
}

/**
 * The real repo's git directory for a worktree jail (`<jail>/.git` is a file naming `<real>/.git/worktrees/<id>`),
 * or null. Read from the jail, which a worker can write, so it is believed only when the named directory is
 * `<something>/.git/worktrees/<id>` AND that directory points back at this jail — a `.git` file edited to name
 * another tree gets nothing. No git is run: the jail's config is the worker's.
 */
export async function worktreeGitDir(jail: string): Promise<string | null> {
  try {
    const dotGit = path.join(jail, '.git');
    if (!(await fs.promises.lstat(dotGit)).isFile()) return null;
    const m = /^gitdir: (.+)$/m.exec(await fs.promises.readFile(dotGit, 'utf8'));
    if (!m?.[1]) return null;
    const admin = await fs.promises.realpath(path.resolve(jail, m[1].trim()));
    const common = path.dirname(path.dirname(admin));
    if (path.basename(path.dirname(admin)) !== 'worktrees' || path.basename(common) !== '.git') return null;
    const back = (await fs.promises.readFile(path.join(admin, 'gitdir'), 'utf8')).trim();
    if (path.basename(back) !== '.git') return null;
    if ((await fs.promises.realpath(path.dirname(back))) !== (await fs.promises.realpath(jail))) return null;
    if (!(await fs.promises.stat(path.join(common, 'objects'))).isDirectory()) return null;
    return common;
  } catch {
    return null;
  }
}

/**
 * The start-up check: null when work may run, else why not. With the switch on, a sandboxed /usr/bin/true must exit
 * 0 and a sandboxed write into Foreman's home must fail. An unknown switch value is a reason too.
 */
export async function selfTest(): Promise<string | null> {
  let dir: string | null = null;
  const marker = path.join(config.home, '.sandbox-selftest');
  try {
    const state = await sandboxState();
    if (state !== 'on') return null;
    await fs.promises.mkdir(config.home, { recursive: true });
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'foreman-sbx-'));
    const opts = { jail: dir, tmp: dir, home: dir };
    await wrapChecked('tests', opts, '/usr/bin/true', []);
    await fs.promises.rm(marker, { force: true });
    const touch = await wrap('tests', opts, '/usr/bin/touch', [marker]);
    const r = await run(touch.cmd, touch.args);
    const wrote = await fs.promises.access(marker).then(() => true, () => false);
    if (wrote || r.code === 0) {
      return `the sandbox did not stop a write into Foreman's home (${marker}); refusing to run work. ${SWITCH_HINT}`;
    }
    return null;
  } catch (err) {
    if (err instanceof SandboxError) return err.message;
    return `the sandbox self-test failed: ${(err as Error).message}. ${SWITCH_HINT}`;
  } finally {
    await fs.promises.rm(marker, { force: true }).catch(() => {});
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One line for `foreman doctor` and the serve banner. */
export async function sandboxSummary(): Promise<string> {
  let mode: SandboxMode;
  try {
    mode = sandboxMode();
  } catch (err) {
    return `sandbox: ${(err as Error).message}`;
  }
  if (mode === 'off') return 'sandbox off (FOREMAN_SANDBOX=off): test commands and shell tickets run unconfined';
  const answer = await sandboxAvailable();
  const problem = await selfTest();
  const covers = 'test commands, checks, shell tickets, run_shell, use_tool, post-merge check; the claude-code worker is NOT sandboxed';
  if (problem) return `sandbox ${mode}: FAILING — ${problem}`;
  if (answer === 'nested') return `sandbox ${mode}: this process is already inside a sandbox; commands run under that one`;
  let ports: string;
  let extra: string;
  try {
    ports = [config.port, ...denyPorts()].join(', ');
    extra = sandboxAllowances().join(', ');
  } catch (err) {
    return `sandbox ${mode}: FAILING — ${(err as Error).message}`;
  }
  const line = `sandbox ${mode}: ok (${covers}; closed loopback ports ${ports}${extra ? `; allowed: ${extra}` : ''})`;
  const node = await sandboxNodeNote();
  return node ? `${line}\nsandbox ${mode}: ${node}` : line;
}

/**
 * The line `foreman doctor` and `serve` add when the running node's install root is closed to sandboxed commands
 * and is not given back (nodeGiveBack), else null. Judged as wrap() judges it, for a jail under the jails' directory.
 */
export async function sandboxNodeNote(): Promise<string | null> {
  try {
    const home = await real(config.home);
    const jail = path.join(await real(config.workRoot), 'jail');
    return (await nodeFor(home, await closedRoots(home, jail, { jail, tmp: jail, home: jail }))).note;
  } catch (err) {
    return `cannot tell whether sandboxed commands can find node: ${(err as Error).message}`;
  }
}

/** Appended to a failed sandboxed test run, so a suite that needs something outside the jail says where to look. */
export function sandboxNote(): string {
  let ports = '';
  try {
    ports = denyPorts().join(', ');
  } catch {
    /* said elsewhere */
  }
  return (
    `foreman: this ran sandboxed (FOREMAN_SANDBOX=${sandboxMode()}): no network beyond loopback, no reads under /Users except the jail. ` +
    `If the suite needs a tool under your home, add it to FOREMAN_SANDBOX_RO.` +
    (ports ? ` Closed loopback ports: ${ports} (FOREMAN_SANDBOX_DENY_PORTS).` : '') +
    ' File watching (fs.watch) needs FOREMAN_SANDBOX_ALLOW=fsevents.'
  );
}
