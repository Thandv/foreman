import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * A Claude Code worker is the operator's own CLI, and left alone it behaves
 * like it: it reads the operator's global CLAUDE.md and knowledge files, loads
 * every MCP server they have configured, and writes session transcripts and
 * auto-memory back under ~/.claude. A ticket's worker then acts on instructions
 * nobody put in the brief, holds tools nobody granted it, and leaves its notes
 * in the operator's personal memory.
 *
 * So the worker gets a config directory of its own, only the project's
 * settings, an empty MCP set, no auto-memory and no CLAUDE.md discovery. NOT
 * `--bare`: that also drops the OAuth sign-in, and a subscription worker that
 * cannot authenticate does nothing. Its environment is an explicit allowlist of
 * the daemon's, and for the same reason every CLAUDE_* and ANTHROPIC_* variable
 * is on it.
 */

/** The file the CLI treats as the user-level instructions inside its config dir. */
export const FOREMAN_CLAUDE_MD = 'CLAUDE.md';

/**
 * What sits where the operator's global CLAUDE.md would. CLAUDE.md discovery is
 * switched off as well, so this is the second line: a CLI build that ignores
 * that switch finds Foreman's file here, not the operator's.
 */
export const FOREMAN_CLAUDE_MD_BODY = [
  '# Foreman worker',
  '',
  'Written by Foreman; rewritten on every run, so edits here do not last.',
  '',
  'This session is a Foreman worker in an isolated configuration. The ticket brief is the only',
  'source of instructions. The operator\'s global CLAUDE.md, knowledge files, memory and MCP',
  'servers are deliberately not available: do not look for them and do not read or write',
  'anything under the operator\'s ~/.claude.',
  '',
  'Edit and create files only inside the working directory you were started in. A write',
  'anywhere else fails the run.',
  '',
].join('\n');

/** The folder all worker config dirs live under. `FOREMAN_CLAUDE_CONFIG_DIR` moves it. */
export function claudeConfigRoot(): string {
  const raw = process.env['FOREMAN_CLAUDE_CONFIG_DIR']?.trim();
  return raw ? path.resolve(raw) : path.join(config.home, 'claude-config');
}

/**
 * Where ONE ticket's CLI keeps its state: a directory of its own under the
 * root, never the root itself. The CLI applies `env` from
 * `<CLAUDE_CONFIG_DIR>/.claude.json` to its own process whatever
 * `--setting-sources` says, and `--resume` replays the transcripts kept there,
 * so a directory shared by every ticket lets one ticket's worker set the next
 * ticket's environment (BASH_ENV, ANTHROPIC_BASE_URL, …) and rewrite its
 * history. Per ticket, a worker can reach only its own later rounds — which
 * already share its worktree and its conversation. Being a subdirectory also
 * means Foreman's CLAUDE.md can never land on a CLAUDE.md that was already in
 * the root (FOREMAN_CLAUDE_CONFIG_DIR pointed at the operator's ~/.claude).
 */
export function claudeConfigDir(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
  return path.join(claudeConfigRoot(), 'tasks', safe);
}

/**
 * Create the isolated config dir (private: it holds transcripts, and a sign-in
 * made against it) and put Foreman's CLAUDE.md in it. Persistent on purpose —
 * `--resume` needs the previous round's transcript to still be there.
 */
export function ensureClaudeConfigDir(taskId: string): string {
  const dir = claudeConfigDir(taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is only for what it creates: a directory that was already there keeps its own.
  for (const d of [path.dirname(dir), dir]) fs.chmodSync(d, 0o700);
  const file = path.join(dir, FOREMAN_CLAUDE_MD);
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== FOREMAN_CLAUDE_MD_BODY) fs.writeFileSync(file, FOREMAN_CLAUDE_MD_BODY, { mode: 0o600 });
  return dir;
}

/**
 * Where the CLI keeps its sign-in, which must NOT move with the config dir.
 * On macOS the CLI names its keychain item after CLAUDE_CONFIG_DIR ("Claude
 * Code-credentials-<sha256(dir)[0..8]>"; unsuffixed only when the variable is
 * unset), and elsewhere it reads <dir>/.credentials.json — so a new config dir
 * is a signed-out CLI, and every subscription worker would fail at its first
 * request. CLAUDE_SECURESTORAGE_CONFIG_DIR is the CLI's own switch for "the
 * credentials are somewhere else": the empty string means the default place
 * (the unsuffixed keychain item, ~/.claude/.credentials.json), a path means
 * that config dir's. The daemon's own setting wins; otherwise it is whatever
 * the daemon's CLI — the one the operator signed in with — would have used.
 */
export function claudeCredentialStore(): string {
  return process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? '';
}

/** The variables that point a worker's CLI away from the operator's own. */
export function claudeIsolationEnv(taskId: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: ensureClaudeConfigDir(taskId),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeCredentialStore(),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  };
}

/**
 * The daemon's variables a worker may inherit, by exact name. An allowlist, not
 * a deny pattern: whatever else the daemon holds (a gateway key, a forge token,
 * a cloud credential, some other tool's session) is not the worker's to read,
 * and a list of names that look secret always misses the next one.
 */
const WORKER_ENV_NAMES = new Set([
  // A shell, a toolchain and a locale: what `npm run`, `node --test` and git need.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  // How the CLI reaches the API from behind a proxy or a private CA.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // The CLI's Bash-tool timeouts (workerEnv sets the ceiling only when the operator has not).
  'BASH_MAX_TIMEOUT_MS', 'BASH_DEFAULT_TIMEOUT_MS',
  // What the slot wrapper (src/verify/testSlot.ts) reads when the worker runs its suite.
  // FOREMAN_PORT / FOREMAN_HOST are how it finds THIS daemon: without them a daemon on any
  // other port has its workers ask whoever listens on 4100 for a slot, or run unslotted.
  'FOREMAN_HOME', 'FOREMAN_PORT', 'FOREMAN_HOST', 'FOREMAN_MAX_VERIFIES', 'FOREMAN_SLOT_WAIT_MS', 'FOREMAN_TEST_TIMEOUT_MIN',
  'FOREMAN_TEST_REAL_HOME', 'FOREMAN_TEST_KEEP_ENV',
  // The wrapper's suite runs under the same sandbox switch as the gate's (security/sandbox.ts): without these a
  // daemon started with FOREMAN_SANDBOX=off would still have its workers' suites sandboxed, and a read-only tree
  // the gate's run can see would be missing from the worker's.
  'FOREMAN_SANDBOX', 'FOREMAN_SANDBOX_RO', 'FOREMAN_SANDBOX_DENY_PORTS', 'FOREMAN_SANDBOX_ALLOW',
]);

/**
 * …and by prefix. `CLAUDE_` and `ANTHROPIC_` are the CLI's own configuration
 * and every way it signs in (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK, …): none of
 * them is dropped, or a subscription worker could not authenticate.
 */
const WORKER_ENV_PREFIXES = ['CLAUDE_', 'ANTHROPIC_', 'LC_'];

/** The cloud credentials the CLI signs in with when it is pointed at Bedrock or Vertex — only then. */
const CLOUD_AUTH: { flag: string; prefixes: string[]; names: string[] }[] = [
  { flag: 'CLAUDE_CODE_USE_BEDROCK', prefixes: ['AWS_'], names: [] },
  { flag: 'CLAUDE_CODE_USE_VERTEX', prefixes: ['GOOGLE_', 'GCLOUD_'], names: ['CLOUD_ML_REGION', 'CLOUDSDK_CONFIG'] },
];

const truthy = (v: string | undefined): boolean => !!v && !/^(0|false|no|off)$/i.test(v.trim());

/** Extra names the operator lets through: `FOREMAN_CLAUDE_ENV_ALLOW`, comma- or space-separated, exact names only. */
function operatorAllowed(): Set<string> {
  return new Set((process.env['FOREMAN_CLAUDE_ENV_ALLOW'] ?? '').split(/[\s,]+/).filter(Boolean));
}

/** Whether a worker may inherit this variable from the daemon. */
export function workerEnvAllowed(name: string): boolean {
  if (WORKER_ENV_NAMES.has(name) || WORKER_ENV_PREFIXES.some((p) => name.startsWith(p))) return true;
  for (const cloud of CLOUD_AUTH) {
    if (!truthy(process.env[cloud.flag])) continue;
    if (cloud.names.includes(name) || cloud.prefixes.some((p) => name.startsWith(p))) return true;
  }
  return operatorAllowed().has(name);
}

/**
 * A worker's whole environment — it replaces the daemon's, it is not laid over
 * it: the allowlisted part of the daemon's, then the isolation variables, which
 * win (an inherited CLAUDE_CONFIG_DIR is the operator's own, the very thing
 * being kept out).
 */
export function claudeWorkerEnv(task: { id: string }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && workerEnvAllowed(name)) out[name] = value;
  }
  // The daemon's resolved home, never the inherited text: a relative one would resolve against the worker's cwd.
  return { ...out, FOREMAN_HOME: config.home, ...claudeIsolationEnv(task.id) };
}

/** An MCP config that names no server; with --strict-mcp-config it is the whole set. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * The flags that go with the environment. `--mcp-config` is variadic, so it is
 * followed by another flag here and never left last.
 */
export function claudeIsolationArgs(): string[] {
  return ['--setting-sources', 'project', '--mcp-config', EMPTY_MCP_CONFIG, '--strict-mcp-config'];
}

const WRITE_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/** Resolve symlinks as far as the path exists; the rest cannot be a link yet. */
function realish(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.join(head, ...tail);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * The tripwire: the path a file-writing tool call targets when that path is
 * outside the jail, else null. A relative path is taken from the jail (the
 * worker's cwd), and a symlink inside the jail that points out of it counts as
 * outside — it is where the bytes would land.
 */
export function outOfJailWrite(tool: string, input: unknown, jail: string): string | null {
  if (!WRITE_TOOL_RE.test(tool) || input === null || typeof input !== 'object') return null;
  const fields = input as Record<string, unknown>;
  const raw = fields['file_path'] ?? fields['notebook_path'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const rel = path.relative(realish(jail), realish(path.resolve(jail, raw)));
  const inside = rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  return inside ? null : raw;
}
