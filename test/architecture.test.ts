import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Architecture guard: the shape of src/ as the import graph and the environment reads show it.
//
// UPDATE RULE: a change that adds an import edge covered below, a FOREMAN_* read outside config.ts, or an import
// cycle updates the allowlist in this file in its own diff, with a one-line reason, and its reviewer checks that
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
for (const f of files) {
  const text = fs.readFileSync(path.join(SRC, '..', f), 'utf8');
  value.set(f, new Set());
  typeOnly.set(f, new Set());
  for (const { spec, typeOnly: t } of scanSource(text)) {
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
  {
    files: ['src/security/admit.ts', 'src/improve.ts', 'src/models.ts', 'src/align/personas.ts', 'src/bench.ts', 'src/tools/catalog.ts'],
    reason: 'admit.ts takes isSelfTask and PROTECTED_PATHS from improve.ts, which reaches back to admit.ts through models, bench and the tool catalog; every cycle passes admit.ts -> improve.ts',
  },
];

// (b) Edges out of src/security/* beyond config, types, localOnly and security itself, with why.
const SECURITY_EDGES: Record<string, string> = {
  'src/security/admit.ts -> src/improve.ts':'admit.ts takes isSelfTask and PROTECTED_PATHS from improve.ts (the edge every cycle in the six-file component passes through)',
  'src/security/coreGuard.ts -> src/isolate.ts': 'coreGuard takes driverlessEnv from isolate.ts',
};

// (c) The modules queue.ts imports as values.
const QUEUE_IMPORTS = [
  'src/archive.ts', 'src/assign.ts', 'src/assistant/retro.ts', 'src/db.ts', 'src/runners/proctree.ts',
  'src/schedule.ts', 'src/skills.ts', 'src/types.ts', 'src/verify/followUpChain.ts',
];

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
  'src/gate.ts': ['FOREMAN_GATE', 'FOREMAN_GATE_BATCH'],
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
      const ok = to.startsWith('src/security/') || ['src/config.ts', 'src/types.ts', 'src/localOnly.ts'].includes(to);
      if (!ok) stray.push(`${from} -> ${to}`);
    }
  }
  assert.deepEqual(stray.sort(), Object.keys(SECURITY_EDGES).sort(), 'update SECURITY_EDGES (stale or new edge)');
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
