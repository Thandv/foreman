import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isProtectedPath, PROTECTED_PATHS } from '../src/security/coreGuard.ts';

// Architecture guard: the shape of src/ as the import graph and the environment reads show it.
//
// UPDATE RULE: a change that adds an import edge covered below, a FOREMAN_* read outside config.ts, a new src file
// that touches process.env, or an import cycle updates the allowlist in this file in its own diff, with a one-line reason, and its reviewer checks that
// entry. An entry that no longer matches anything fails too, so a fixed cycle or a removed read leaves the list in
// the same diff that fixes it.

const SRC = path.join(import.meta.dirname, '..', 'src');
const rel = (f: string) => path.relative(path.join(SRC, '..'), f).split(path.sep).join('/');

type Spec = { spec: string; typeOnly: boolean };

/** The text with every // and block comment blanked, string and template contents left as they are. */
function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i]!, two = text.slice(i, i + 2);
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (two === '//') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Every static import, export-from and dynamic import('literal') specifier in a source text, comments left out.
 * Throws when a statement that looks like an import or export-from yields no specifier, or an import() has a
 * non-literal argument, so a parser gap fails loudly instead of hiding an edge. A `{ type A }` import is a value
 * edge (verbatimModuleSyntax keeps it as a side-effect import); only `import type` and `export type` are type-only.
 */
export function scanSource(text: string): Spec[] {
  const code = stripComments(text);
  const out: Spec[] = [];
  const seen = new Set<number>();
  const staticRe = /^[ \t]*(import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const m of code.matchAll(staticRe)) {
    seen.add(m.index);
    if (m[1] === 'export' && m[3] === undefined) continue;
    out.push({ spec: m[4]!, typeOnly: !!m[2] });
  }
  for (const m of code.matchAll(/^[ \t]*(?:import(?![\w$(.])|export\s+(?:type\s+)?[{*])/gm)) {
    const stmt = code.slice(m.index, code.indexOf(';', m.index) < 0 ? undefined : code.indexOf(';', m.index));
    const isModule = m[0].includes('import') || /\bfrom\s*['"]/.test(stmt);
    if (isModule && !seen.has(m.index)) {
      const line = code.slice(0, m.index).split('\n').length;
      throw new Error(`scanner gap: the import or export-from statement at line ${line} yields no specifier: ${stmt.slice(0, 80)}`);
    }
  }
  const mid = /[;}][ \t]*(?:import(?![\w$(.])|export\s+(?:type\s+)?[{*])/.exec(code);
  if (mid) throw new Error(`scanner gap: an import or export statement follows other code at line ${code.slice(0, mid.index).split('\n').length}`);
  const dynamic = [...code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)];
  for (const m of dynamic) out.push({ spec: m[2]!, typeOnly: false });
  const calls = [...code.matchAll(/\bimport\s*\(/g)].length;
  if (calls !== dynamic.length) throw new Error(`scanner gap: ${calls - dynamic.length} import() call(s) with a non-literal specifier`);
  return out;
}

/** True when the source text references process.env outside a comment (a read, a write or a whole-env pass). */
export function touchesProcessEnv(text: string): boolean {
  return /\bprocess\s*\.\s*env\b/.test(stripComments(text));
}

/** Each value import in `specs` that is neither relative nor a node:* built-in, as "<file>: '<specifier>'". */
export function bareValueImports(file: string, specs: Spec[]): string[] {
  return specs.filter((s) => !s.typeOnly && !s.spec.startsWith('.') && !s.spec.startsWith('node:')).map((s) => `${file}: '${s.spec}'`);
}

/** Each package a package.json object would install at runtime, as "package.json <field>: <name>". */
export function runtimeDependencies(pkg: Record<string, unknown>): string[] {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) =>
    Object.keys(pkg[field] ?? {}).map((name) => `package.json ${field}: ${name}`),
  );
}

/**
 * Each unprotected module whose value importers are all protected (and there is at least one), sorted: a helper only
 * protected code uses, whose behaviour a run can change without touching a protected file.
 */
export function protectedOnlyHelpers(graph: Map<string, Set<string>>, isProtected: (f: string) => boolean): string[] {
  const importers = new Map<string, string[]>();
  for (const [from, tos] of graph) for (const to of tos) importers.set(to, [...(importers.get(to) ?? []), from]);
  return [...importers].filter(([to, froms]) => !isProtected(to) && froms.every(isProtected)).map(([to]) => to).sort();
}

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listTs(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

const files = listTs(SRC).map(rel).sort();
const known = new Set(files);
const value = new Map<string, Set<string>>();
const typeOnly = new Map<string, Set<string>>();
const envReads = new Map<string, Set<string>>();
const processEnvFiles: string[] = [];
const bareImports: string[] = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(SRC, '..', f), 'utf8');
  value.set(f, new Set());
  typeOnly.set(f, new Set());
  const specs = scanSource(text);
  bareImports.push(...bareValueImports(f, specs));
  if (touchesProcessEnv(text)) processEnvFiles.push(f);
  for (const { spec, typeOnly: t } of specs) {
    if (!spec.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
    const target = [base, `${base}.ts`, `${base}/index.ts`].find((c) => known.has(c));
    assert.ok(target, `${f}: import '${spec}' resolves to no file under src/`);
    (t ? typeOnly : value).get(f)!.add(target);
  }
  if (f !== 'src/config.ts') {
    const names = [...text.matchAll(/\benv(?:\[\s*['"`]|\.)(FOREMAN_[A-Z0-9_]+)/g)].map((m) => m[1]!);
    if (names.length) envReads.set(f, new Set(names));
  }
}

/** Strongly connected components with a cycle in them (Tarjan), each as a sorted list of files. */
function cycles(graph: Map<string, Set<string>>): string[][] {
  let n = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || graph.get(v)?.has(v)) found.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return found.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

// (a) Every cycle of value imports, by strongly connected component, with why it is allowed.
const CYCLES: { files: string[]; reason: string }[] = [
  {
    files: ['src/isolate.ts', 'src/security/coreGuard.ts'],
    reason: 'coreGuard takes driverlessEnv from isolate.ts, and isolate.ts takes changedPaths from coreGuard',
  },
];

// (b) Edges out of src/security/* beyond config, types, localOnly and security itself, with why.
const SECURITY_EDGES: Record<string, string> = {
  'src/security/coreGuard.ts -> src/isolate.ts': 'coreGuard takes driverlessEnv from isolate.ts',
};

// (c) The modules queue.ts imports as values.
const QUEUE_IMPORTS = [
  'src/archive.ts', 'src/assign.ts', 'src/assistant/retro.ts', 'src/db.ts', 'src/isolate.ts', 'src/runners/proctree.ts',
  'src/schedule.ts', 'src/skills.ts', 'src/types.ts', 'src/verify/followUpChain.ts',
];

// (d) Value edges into src/align/ and src/prose/ from the rest of src/, with why. The core reaches the alignment and
// prose features only through these.
const ALIGN_PROSE_EDGES: Record<string, string> = {
  'src/assistant/repoBrief.ts -> src/align/redact.ts': 'the repo brief redacts secrets before it leaves the machine',
  'src/cli.ts -> src/align/dataset.ts': '`align` builds its datasets (dynamic import)',
  'src/cli.ts -> src/align/extract.ts': '`align` extracts its samples (dynamic import)',
  'src/cli.ts -> src/align/governor.ts': '`persona train` runs under the machine governor (dynamic import)',
  'src/cli.ts -> src/align/localLock.ts': '`persona lock` reports the local model lock (dynamic import)',
  'src/cli.ts -> src/align/manuscript.ts': '`persona ingest` builds training pairs from a manuscript (dynamic import)',
  'src/cli.ts -> src/align/personaAdopt.ts': '`persona adopt` gates a persona (dynamic import)',
  'src/cli.ts -> src/align/personaData.ts': '`persona ingest` and `persona build` write its datasets (dynamic import)',
  'src/cli.ts -> src/align/personaServe.ts': '`persona serve` starts and stops a persona server (dynamic import)',
  'src/cli.ts -> src/align/personas.ts': '`persona` commands read the persona registry (dynamic import)',
  'src/cli.ts -> src/align/train.ts': '`align train` and `align status` train and check adapters (dynamic import)',
  'src/cli.ts -> src/prose/audit.ts': '`prose audit` audits a manuscript directory',
  'src/cli.ts -> src/prose/ingest.ts': '`prose import` splits a manuscript into chapters',
  'src/cli.ts -> src/prose/tics.ts': '`persona ingest` leaves out passages with tics (dynamic import)',
  'src/drill.ts -> src/align/personaHealth.ts': 'the drill reports adopted personas that do not answer',
  'src/models.ts -> src/align/personas.ts': 'a persona model resolves to its server URL',
  'src/roles.ts -> src/align/personas.ts': 'a role picks the persona for a task',
  'src/runners/api.ts -> src/align/personaHealth.ts': 'the api runner refuses an unreachable persona',
  'src/runners/api.ts -> src/prose/contextPack.ts': 'the api runner briefs a prose ticket with its context pack',
  'src/scheduler.ts -> src/align/localLock.ts': 'the scheduler holds local work while training holds the lock',
  'src/scheduler.ts -> src/align/personaHealth.ts': 'the scheduler starts adopted persona servers',
  'src/scheduler.ts -> src/prose/auditWorker.ts': 'the scheduler audits prose off the main thread',
  'src/scheduler.ts -> src/prose/linecheck.ts': 'the scheduler checks a prose change for fact drift',
  'src/server.ts -> src/align/personaHealth.ts': 'the API reports persona health',
  'src/server.ts -> src/align/personas.ts': 'the API reports persona server URLs',
  'src/server.ts -> src/prose/audit.ts': 'the API formats a prose audit report',
  'src/server.ts -> src/prose/auditWorker.ts': 'the API runs a prose audit off the main thread',
};

// (e) FOREMAN_* names read outside config.ts, per file: each module's own tuning, read where it is used.
const ENV_READS: Record<string, string[]> = {
  'src/agents.ts': ['FOREMAN_AGENTS_DIR'],
  'src/agreement.ts': ['FOREMAN_SHADOW_LOCAL'],
  'src/align/extract.ts': ['FOREMAN_ALIGN_DIR', 'FOREMAN_CLAUDE_PROJECTS', 'FOREMAN_COWORK_SESSIONS'],
  'src/align/governor.ts': ['FOREMAN_PYTHON', 'FOREMAN_TRAIN_MEMORY_SHARE', 'FOREMAN_TRAIN_NICE'],
  'src/align/localLock.ts': ['FOREMAN_LOCAL_LOCK'],
  'src/align/personaAdopt.ts': ['FOREMAN_PYTHON'],
  'src/align/personaServe.ts': ['FOREMAN_PYTHON', 'FOREMAN_SERVE_NICE'],
  'src/align/personas.ts': ['FOREMAN_PERSONAS_DIR', 'FOREMAN_PERSONA_BASE', 'FOREMAN_PERSONA_PORT_BASE', 'FOREMAN_PERSONA_URL_'],
  'src/align/redact.ts': ['FOREMAN_ENTROPY_THRESHOLD'],
  'src/align/train.ts': ['FOREMAN_PYTHON'],
  'src/assign.ts': ['FOREMAN_ASSIGNEE'],
  'src/assistant/crewPlan.ts': ['FOREMAN_MAX_PLAN_TICKETS', 'FOREMAN_MODEL_ROUTER', 'FOREMAN_PLAN_TIMEOUT_MS'],
  'src/assistant/ownerCall.ts': ['FOREMAN_CLAUDE_BIN'],
  'src/backup.ts': ['FOREMAN_BACKUP', 'FOREMAN_BACKUP_COPY_DIR', 'FOREMAN_BACKUP_DIR'],
  'src/budget.ts': ['FOREMAN_DOWNSHIFT', 'FOREMAN_DOWNSHIFT_HOLD_MS', 'FOREMAN_OLLAMA_KEEP_ALIVE', 'FOREMAN_OLLAMA_KEEP_ALIVE_COLD', 'FOREMAN_OLLAMA_URL', 'FOREMAN_VRAM_GUARD'],
  'src/cli.ts': ['FOREMAN_MODEL_TIMEOUT_MS', 'FOREMAN_REVERIFY_WAIT_MS', 'FOREMAN_RUN_ID'],
  'src/deps.ts': ['FOREMAN_DEPS_MODE', 'FOREMAN_SANDBOX'],
  'src/diskSpace.ts': ['FOREMAN_MIN_FREE_MB'],
  'src/gate.ts': ['FOREMAN_GATE', 'FOREMAN_GATE_BATCH'],
  'src/gitTimeout.ts': ['FOREMAN_GIT_TIMEOUT_MS'],
  'src/improve.ts': ['FOREMAN_IMPROVE_BUDGET_USD', 'FOREMAN_IMPROVE_PRIORITY'],
  'src/localOnly.ts': ['FOREMAN_LOCAL_MAX_OUTPUT_TOKENS', 'FOREMAN_LOCAL_NUM_CTX', 'FOREMAN_LOCAL_ONLY'],
  'src/memory.ts': ['FOREMAN_OLLAMA_URL', 'FOREMAN_PAGING_ALLOWANCE_GB'],
  'src/models.ts': [
    'FOREMAN_CLAUDE_BIN', 'FOREMAN_GATEWAY_ALIASES', 'FOREMAN_GATEWAY_IN_RATE', 'FOREMAN_GATEWAY_KEY', 'FOREMAN_GATEWAY_OUT_RATE',
    'FOREMAN_GATEWAY_URL', 'FOREMAN_MODEL_', 'FOREMAN_MODEL_TIMEOUT_MS', 'FOREMAN_OLLAMA_URL',
  ],
  'src/playbooks.ts': ['FOREMAN_PLAYBOOKS_DIR'],
  'src/postMerge.ts': ['FOREMAN_POSTMERGE_CHECK'],
  'src/providerLimit.ts': ['FOREMAN_LIMIT_BACKOFF_MS'],
  'src/roles.ts': ['FOREMAN_MAX_TURNS_SENIOR'],
  'src/runClock.ts': ['FOREMAN_SLOT_WAIT_CREDIT_MS'],
  'src/runners/api.ts': ['FOREMAN_API_ALLOW_SHELL', 'FOREMAN_API_MAX_TURNS', 'FOREMAN_TOOL_SURFACE'],
  'src/runners/claudeIsolation.ts': ['FOREMAN_CLAUDE_CONFIG_DIR', 'FOREMAN_CLAUDE_ENV_ALLOW'],
  'src/runners/cliRunners.ts': ['FOREMAN_CLAUDE_ALLOWED_TOOLS', 'FOREMAN_CLAUDE_DISALLOWED_TOOLS', 'FOREMAN_CLAUDE_PERMISSION_MODE'],
  'src/runners/echo.ts': ['FOREMAN_ECHO_STEP_MS'],
  'src/runners/freezeSweep.ts': ['FOREMAN_FREEZE_SWEEP_CAP_MS', 'FOREMAN_FREEZE_SWEEP_FAULT', 'FOREMAN_FREEZE_SWEEP_GRACE_MS'],
  'src/runners/proctree.ts': ['FOREMAN_LEFTOVER_SAMPLE_MS'],
  'src/scheduler.ts': [
    'FOREMAN_ARCHIVE_AFTER_DAYS', 'FOREMAN_CLAUDE_RESUME', 'FOREMAN_COUNCIL_DEADLINE_SHARE', 'FOREMAN_IGNORE_TRAINING_LOCK',
    'FOREMAN_RECHECK_MS', 'FOREMAN_REDCHECK_MS', 'FOREMAN_VERIFY',
  ],
  'src/security/sandbox.ts': ['FOREMAN_SANDBOX', 'FOREMAN_SANDBOX_ALLOW', 'FOREMAN_SANDBOX_DENY_PORTS', 'FOREMAN_SANDBOX_RO'],
  'src/server.ts': ['FOREMAN_ALLOWED_HOSTS', 'FOREMAN_ALLOW_REMOTE'],
  'src/tools/catalog.ts': ['FOREMAN_TOOLBOX', 'FOREMAN_TOOLS_DIR', 'FOREMAN_TOOL_QUARANTINE_AFTER'],
  'src/tools/run.ts': ['FOREMAN_PYTHON', 'FOREMAN_TOOL_TIMEOUT_MS'],
  'src/trace.ts': ['FOREMAN_TRACE_KEY', 'FOREMAN_TRACE_SINK'],
  'src/verify/council.ts': ['FOREMAN_COUNCIL_NUM_CTX', 'FOREMAN_HIGH_PRIORITY'],
  'src/verify/crewReview.ts': ['FOREMAN_CREW_REVIEW'],
  'src/verify/slots.ts': ['FOREMAN_MAX_VERIFIES'],
  'src/verify/testSlot.ts': ['FOREMAN_SLOT_WAIT_MS'],
  'src/verify/tests.ts': ['FOREMAN_TEST_KEEP_ENV', 'FOREMAN_TEST_REAL_HOME', 'FOREMAN_TEST_TIMEOUT_MIN'],
  'src/verify/triage.ts': ['FOREMAN_FAST_VERIFY', 'FOREMAN_FAST_VERIFY_MAX_LINES'],
  'src/warm.ts': ['FOREMAN_OLLAMA_KEEP_ALIVE', 'FOREMAN_OLLAMA_URL', 'FOREMAN_PREWARM', 'FOREMAN_PREWARM_TIMEOUT_MS'],
};

// (f) Every src file that references process.env outside a comment, config.ts and whole-env passes to a child
// included: a new file reading any variable, or handing the daemon's environment on, is a reviewed change.
const PROCESS_ENV_FILES: string[] = [
  'src/agents.ts', 'src/agreement.ts', 'src/align/extract.ts', 'src/align/governor.ts', 'src/align/localLock.ts',
  'src/align/personaAdopt.ts', 'src/align/personaServe.ts', 'src/align/personas.ts', 'src/align/redact.ts',
  'src/align/train.ts', 'src/assign.ts', 'src/assistant/crewPlan.ts', 'src/assistant/ownerCall.ts', 'src/backup.ts',
  'src/budget.ts', 'src/cli.ts', 'src/config.ts', 'src/deps.ts', 'src/diskSpace.ts', 'src/gate.ts',
  'src/gitTimeout.ts', 'src/improve.ts', 'src/isolate.ts', 'src/localOnly.ts', 'src/memory.ts', 'src/models.ts',
  'src/playbooks.ts', 'src/postMerge.ts', 'src/providerLimit.ts', 'src/roles.ts', 'src/runClock.ts',
  'src/runners/api.ts', 'src/runners/claudeIsolation.ts', 'src/runners/cliRunners.ts', 'src/runners/echo.ts',
  'src/runners/freezeSweep.ts', 'src/runners/proc.ts', 'src/runners/proctree.ts', 'src/runners/shell.ts',
  'src/scheduler.ts', 'src/security/coreGuard.ts', 'src/security/nodeRoot.ts', 'src/security/sandbox.ts',
  'src/server.ts', 'src/tools/catalog.ts', 'src/tools/run.ts', 'src/trace.ts', 'src/verify/citedSource.ts',
  'src/verify/council.ts', 'src/verify/crewReview.ts', 'src/verify/gateOutcome.ts', 'src/verify/slots.ts',
  'src/verify/testSlot.ts', 'src/verify/tests.ts', 'src/verify/triage.ts', 'src/warm.ts',
];

// (g) Unprotected modules that only protected src files value-import: a run could change what the guarded code does
// without touching a protected file. The list may only shrink; protecting one is a change to PROTECTED_PATHS.
const PROTECTED_ONLY_HELPERS: string[] = [
  'src/assign.ts', 'src/assistant/playbookForge.ts', 'src/diskSpace.ts', 'src/doctorPlan.ts', 'src/gitTripwire.ts',
  'src/metrics.ts', 'src/postMerge.ts', 'src/prose/auditWorker.ts', 'src/prose/linecheck.ts', 'src/runClock.ts',
  'src/runFacts.ts', 'src/runners/index.ts', 'src/schedule.ts', 'src/scope.ts', 'src/verify/assertionCheck.ts',
  'src/verify/backgroundRun.ts', 'src/verify/workerSuite.ts',
];

test('the value-import cycles are exactly the allowlisted components', () => {
  const actual = cycles(value).map((c) => c.join(' + '));
  const allowed = CYCLES.map((c) => [...c.files].sort().join(' + ')).sort();
  assert.deepEqual(actual.sort(), allowed, 'a component appeared or an allowlisted one is gone: update CYCLES');
  for (const c of CYCLES) assert.ok(c.reason.length > 0);
});

test('src/security value imports stay inside config, types, localOnly, security and the allowlisted edges', () => {
  const stray: string[] = [];
  for (const [from, tos] of value) {
    if (!from.startsWith('src/security/')) continue;
    for (const to of tos) {
      const ok = to.startsWith('src/security/') || ['src/config.ts', 'src/types.ts', 'src/localOnly.ts', 'src/gitTimeout.ts'].includes(to);
      if (!ok) stray.push(`${from} -> ${to}`);
    }
  }
  assert.deepEqual(stray.sort(), Object.keys(SECURITY_EDGES).sort(), 'update SECURITY_EDGES (stale or new edge)');
});

test('value imports into src/align and src/prose from the rest of src are exactly the allowlisted edges', () => {
  const feature = (f: string) => f.startsWith('src/align/') || f.startsWith('src/prose/');
  const edges: string[] = [];
  for (const [from, tos] of value) {
    if (!feature(from)) for (const to of tos) if (feature(to)) edges.push(`${from} -> ${to}`);
  }
  assert.deepEqual(edges.sort(), Object.keys(ALIGN_PROSE_EDGES).sort(), 'update ALIGN_PROSE_EDGES (stale or new edge)');
  for (const reason of Object.values(ALIGN_PROSE_EDGES)) assert.ok(reason.length > 0);
});

test('admit.ts does not reach improve.ts, models.ts, personas.ts, bench.ts or the tool catalog through value imports', () => {
  const reached = new Set<string>();
  const queue = ['src/security/admit.ts'];
  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    for (const to of value.get(f) ?? []) if (!reached.has(to)) { reached.add(to); queue.push(to); }
  }
  assert.ok(reached.has('src/security/coreGuard.ts'), 'the walk starts from admit.ts and follows its imports');
  const banned = ['src/improve.ts', 'src/models.ts', 'src/align/personas.ts', 'src/bench.ts', 'src/tools/catalog.ts'];
  assert.deepEqual(banned.filter((b) => reached.has(b)), []);
});

test('db.ts imports only types and queue.ts imports exactly its listed modules', () => {
  assert.deepEqual([...value.get('src/db.ts')!], [], 'db.ts has a value import');
  assert.deepEqual([...typeOnly.get('src/db.ts')!].sort(), ['src/archive.ts', 'src/types.ts'], 'db.ts type-only imports');
  assert.deepEqual([...value.get('src/queue.ts')!].sort(), [...QUEUE_IMPORTS].sort());
});

test('FOREMAN_* reads outside config.ts match the per-file allowlist', () => {
  const actual = Object.fromEntries([...envReads].sort().map(([f, s]) => [f, [...s].sort()]));
  const allowed = Object.fromEntries(Object.entries(ENV_READS).sort().map(([f, a]) => [f, [...a].sort()]));
  assert.deepEqual(actual, allowed, 'update ENV_READS (new read, or a stale entry)');
});

test('the src files that touch process.env match the allowlist', () => {
  assert.deepEqual(processEnvFiles, [...PROCESS_ENV_FILES].sort(), 'update PROCESS_ENV_FILES (new file, or a stale entry)');
});

test('the process.env scan counts code and strings, and not a comment', () => {
  assert.equal(touchesProcessEnv("const x = process.env['X'];"), true);
  assert.equal(touchesProcessEnv('spawn(cmd, args, { env: process.env });'), true);
  assert.equal(touchesProcessEnv('const e = process\n  .env;'), true);
  assert.equal(touchesProcessEnv("// process.env['X']\n/* process.env.Y */\nconst a = 1;"), false);
  assert.equal(touchesProcessEnv('const a = process.envelope;'), false);
});

test('every PROTECTED_PATHS entry exists, and the helpers only protected files import match the allowlist', () => {
  for (const p of PROTECTED_PATHS) assert.ok(fs.existsSync(path.join(SRC, '..', p)), `${p} does not exist`);
  assert.deepEqual(protectedOnlyHelpers(value, isProtectedPath), [...PROTECTED_ONLY_HELPERS].sort(), 'update PROTECTED_ONLY_HELPERS (new helper, or a stale entry)');
});

test('the protected-closure scan flags a helper only protected files import, and not one an unprotected file shares', () => {
  const graph = new Map<string, Set<string>>([
    ['src/gate.ts', new Set(['src/newHelper.ts', 'src/shared.ts'])],
    ['src/cli.ts', new Set(['src/shared.ts'])],
    ['src/security/admit.ts', new Set(['src/security/coreGuard.ts'])],
  ]);
  const isProtected = (f: string) => f === 'src/gate.ts' || f.startsWith('src/security/');
  assert.deepEqual(protectedOnlyHelpers(graph, isProtected), ['src/newHelper.ts']);
});

test('the runtime has no dependencies: package.json lists none and src value-imports only node:* built-ins', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(runtimeDependencies(pkg), [], 'Foreman is dependency-free at runtime; use a devDependency');
  assert.deepEqual(bareImports, [], 'src may import only node:* built-ins and relative files');
});

test('the dependency checks name a bare import with its file and a runtime dependency with its field', () => {
  const specs = scanSource("import x from 'lodash';\nimport fs from 'node:fs';\nimport type { Y } from 'typescript';\nexport { z } from 'left-pad';\nconst w = await import('chalk');\nimport { a } from './a.ts';");
  assert.deepEqual(bareValueImports('src/x.ts', specs), ["src/x.ts: 'lodash'", "src/x.ts: 'left-pad'", "src/x.ts: 'chalk'"]);
  assert.deepEqual(runtimeDependencies({ dependencies: { lodash: '^4' }, optionalDependencies: { a: '1' }, peerDependencies: { b: '2' }, devDependencies: { c: '3' } }), [
    'package.json dependencies: lodash',
    'package.json optionalDependencies: a',
    'package.json peerDependencies: b',
  ]);
});

/**
 * Every `.catch(` / `.finally(` handler in a source text whose body calls store.record( or this.store.record( directly.
 * A handler runs where nothing can catch what it throws, so its writes go through safeRecord (src/queue.ts).
 */
export function rawRecordInHandlers(text: string): string[] {
  const code = stripComments(text);
  const found: string[] = [];
  for (const m of code.matchAll(/\.(catch|finally)\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i]!;
      if (c === "'" || c === '"' || c === '`') {
        i++;
        while (i < code.length && code[i] !== c && !(c !== '`' && code[i] === '\n')) i += code[i] === '\\' ? 2 : 1;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const body = code.slice(m.index, i);
    if (/\bstore\.record\(/.test(body)) found.push(`line ${code.slice(0, m.index).split('\n').length}: .${m[1]}( handler calls store.record(`);
  }
  return found;
}

test('no .catch or .finally handler in scheduler.ts or server.ts calls store.record directly', () => {
  for (const file of ['scheduler.ts', 'server.ts']) {
    const found = rawRecordInHandlers(fs.readFileSync(path.join(SRC, file), 'utf8'));
    assert.deepEqual(found, [], `src/${file}: use safeRecord(store, ...) in a handler`);
  }
});

test('the handler scan flags store.record and this.store.record in a catch or finally, and not safeRecord', () => {
  assert.equal(rawRecordInHandlers("p.catch((err) => store.record({ type: 'error', message: `x (${err})` }));").length, 1);
  assert.equal(rawRecordInHandlers('p.then(a).finally(() => {\n  this.store.record({});\n});').length, 1);
  assert.deepEqual(rawRecordInHandlers('p.catch((err) => safeRecord(store, {}));\nstore.record({});'), []);
});

test('the scanner reads a multi-line import', () => {
  const s = scanSource("import {\n  a,\n  b,\n} from './x.ts';\nimport d, { e } from './y.ts';");
  assert.deepEqual(s, [{ spec: './x.ts', typeOnly: false }, { spec: './y.ts', typeOnly: false }]);
});

test('the scanner reads a dynamic import() call, also inside an await', () => {
  const s = scanSource("const m = await import('./late.ts');\n// import('./commented.ts')\n/* import('./blocked.ts') */");
  assert.deepEqual(s, [{ spec: './late.ts', typeOnly: false }]);
});

test('the scanner reads export-from, single and multi-line, and not a plain export', () => {
  const s = scanSource("export * from './a.ts';\nexport {\n  b,\n} from './b.ts';\nexport const c = 1;\nexport { d };");
  assert.deepEqual(s, [{ spec: './a.ts', typeOnly: false }, { spec: './b.ts', typeOnly: false }]);
});

test('the scanner reports type-only imports apart from value imports', () => {
  const s = scanSource("import type { A } from './t.ts';\nimport { type B, type C } from './u.ts';\nimport { type D, e } from './v.ts';\nexport type { F } from './w.ts';");
  assert.deepEqual(s, [
    { spec: './t.ts', typeOnly: true },
    { spec: './u.ts', typeOnly: false }, // verbatimModuleSyntax keeps `{ type B }` as a runtime side-effect import
    { spec: './v.ts', typeOnly: false },
    { spec: './w.ts', typeOnly: true },
  ]);
});

test('the scanner skips a comment inside a multi-line import and a trailing comment after a specifier', () => {
  const s = scanSource(
    "import {\n  a, // don't reuse\n  b, /* it's; here */\n} from './x.ts'; // trailing\nexport {\n  c, // see note; below\n} from './y.ts';",
  );
  assert.deepEqual(s, [{ spec: './x.ts', typeOnly: false }, { spec: './y.ts', typeOnly: false }]);
});

test('the scanner throws on an import() with a non-literal specifier', () => {
  assert.throws(() => scanSource('const m = await import(name);'), /non-literal/);
});

test('the scanner throws on an import statement it cannot read', () => {
  assert.throws(() => scanSource('import {\n  a\n} from ./x.ts;'), /scanner gap/);
});

test('the scanner reads import ( with a space, and throws on a statement after other code on its line', () => {
  assert.deepEqual(scanSource("const m = await import ('./a.ts');\nconst n = () => import\n('./b.ts');"), [
    { spec: './a.ts', typeOnly: false },
    { spec: './b.ts', typeOnly: false },
  ]);
  assert.throws(() => scanSource("import './a.ts'; import './b.ts';"), /scanner gap/);
  assert.throws(() => scanSource("export const a = 1; export * from './b.ts';"), /scanner gap/);
});
