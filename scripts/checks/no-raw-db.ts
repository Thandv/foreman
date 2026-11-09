// Fails when a src file other than src/queue.ts and src/db.ts runs raw ledger SQL or opens a DatabaseSync beyond its
// count in ALLOW, or when a count in ALLOW is higher than the file's (lower it). Usage: node scripts/checks/no-raw-db.ts [root-dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface RawDbCounts {
  /** `.prepare`/`.exec` that only reads: SELECT, PRAGMA, transaction control, or a statement read at once. */
  reads: number;
  /** `.prepare`/`.exec` of INSERT/UPDATE/DELETE/REPLACE/DDL/VACUUM, or of non-literal SQL not read at once. */
  writes: number;
  /** `new DatabaseSync(path, { readOnly: true })`. */
  readOnlyOpeners: number;
  /** `new DatabaseSync(...)` without `readOnly: true`. */
  writableOpeners: number;
}

/** Per-file counts: each may only fall. Lower an entry (or delete it at zero) in the change that removes a site. */
export const ALLOW: Record<string, Partial<RawDbCounts>> = {
  'src/align/dataset.ts': { reads: 2 }, // training-set export queries
  'src/align/personaData.ts': { reads: 2 }, // persona corpus queries
  'src/archive.ts': { reads: 3 }, // landed and failed tickets and their runs, for archiving
  'src/backup.ts': { reads: 2, readOnlyOpeners: 2 }, // integrity and ledger-table checks on a backup file
  'src/cli.ts': { reads: 1 }, // count of active tickets
  // read-only debrief queries and openLedgerReadOnly; openLedgerForReceipt is the ONE writable opener (a probe
  // receipt through Store.prototype inside BEGIN IMMEDIATE, rolled back)
  'src/debrief.ts': { reads: 10, readOnlyOpeners: 2, writableOpeners: 1 },
  'src/gate.ts': { reads: 2 }, // repos with tickets; a run's decision
  'src/improve.ts': { reads: 1 }, // gatherEvidence's SELECT helper
  'src/metrics.ts': { reads: 1 }, // parked tickets for GET /api/metrics
  'src/roles.ts': { reads: 1 }, // a ticket's last skills line
  'src/scheduler.ts': { reads: 1, writes: 1 }, // blocked-ticket count; WRITE: pruneEvents
  'src/server.ts': { reads: 4 }, // landed decisions, last event id, prune's branch list, an artifact lookup
  'src/skills.ts': { writes: 1 }, // WRITE: setTicketSkills
  'src/verify/crewReview.ts': { reads: 1 }, // the status event before a run's first event
  'src/verify/followUpChain.ts': { reads: 1 }, // open tickets for the follow-up chain
};

const EXEMPT = new Set(['src/queue.ts', 'src/db.ts']);
const WRITE_SQL = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM)\b/i;
const READ_AT_ONCE = new Set(['get', 'all', 'iterate']);
const KINDS = ['reads', 'writes', 'readOnlyOpeners', 'writableOpeners'] as const;

function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

const isDatabaseSyncNew = (n: ts.Node): n is ts.NewExpression =>
  ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'DatabaseSync';

/** The opener's `new DatabaseSync` expressions under an initializer (through `?:` and parentheses). */
function openersIn(n: ts.Expression): ts.NewExpression[] {
  if (ts.isParenthesizedExpression(n)) return openersIn(n.expression);
  if (ts.isConditionalExpression(n)) return [...openersIn(n.whenTrue), ...openersIn(n.whenFalse)];
  return isDatabaseSyncNew(n) ? [n] : [];
}

function readOnly(n: ts.NewExpression): boolean {
  const opts = n.arguments?.[1];
  return !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === 'readOnly' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

/** The literal text of the SQL argument (a template's head), or undefined when it is not a literal. */
function sqlText(arg: ts.Expression | undefined): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return ts.isTemplateExpression(arg) ? arg.head.text : undefined;
}

/** Raw ledger SQL in one source file: the TypeScript parser, so a chain split over lines counts and a comment does not. */
export function countSource(file: string, text: string): RawDbCounts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const c: RawDbCounts = { reads: 0, writes: 0, readOnlyOpeners: 0, writableOpeners: 0 };
  const locals = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && openersIn(n.initializer).length) {
      locals.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const visit = (n: ts.Node): void => {
    if (isDatabaseSyncNew(n)) c[readOnly(n) ? 'readOnlyOpeners' : 'writableOpeners']++;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ['prepare', 'exec'].includes(n.expression.name.text)) {
      const recv = n.expression.expression;
      const raw = (ts.isPropertyAccessExpression(recv) && recv.name.text === 'db') || (ts.isIdentifier(recv) && locals.has(recv.text));
      if (raw) {
        const sql = sqlText(n.arguments[0]);
        const use = n.parent;
        const readAtOnce = ts.isPropertyAccessExpression(use) && use.expression === n && READ_AT_ONCE.has(use.name.text);
        c[(sql === undefined ? !readAtOnce : WRITE_SQL.test(sql)) ? 'writes' : 'reads']++;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return c;
}

/** file -> counts, for every src file outside queue.ts and db.ts with any raw ledger SQL or opener. */
export function countRawDb(root: string): Map<string, RawDbCounts> {
  const out = new Map<string, RawDbCounts>();
  for (const file of tsFiles(path.join(root, 'src')).sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (EXEMPT.has(rel)) continue;
    const c = countSource(rel, fs.readFileSync(file, 'utf8'));
    if (KINDS.some((k) => c[k] > 0)) out.set(rel, c);
  }
  return out;
}

/** What differs from the allow-list: a count above its entry is new raw SQL; one below it is a stale entry. */
export function ratchet(counts: Map<string, RawDbCounts>, allow: Record<string, Partial<RawDbCounts>>): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...counts.keys(), ...Object.keys(allow)])].sort()) {
    for (const k of KINDS) {
      const have = counts.get(file)?.[k] ?? 0;
      const allowed = allow[file]?.[k] ?? 0;
      if (have > allowed) problems.push(`${file}: ${k} ${have} > ${allowed} allowed — go through Store (src/queue.ts) instead`);
      else if (have < allowed) problems.push(`${file}: ${k} ${have} < ${allowed} allowed — stale; lower the entry in ALLOW`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const counts = countRawDb(path.resolve(process.argv[2] ?? process.cwd()));
  const problems = ratchet(counts, ALLOW);
  if (problems.length) {
    console.error(`no-raw-db: FAIL — raw ledger SQL outside src/queue.ts and src/db.ts must match ALLOW\n${problems.join('\n')}`);
    process.exit(1);
  }
  const total = (k: (typeof KINDS)[number]): number => [...counts.values()].reduce((s, c) => s + c[k], 0);
  console.log(`no-raw-db: ok
raw reads outside queue: ${total('reads')}
raw writes outside queue: ${total('writes')}
read-only openers outside queue: ${total('readOnlyOpeners')}
writable openers outside queue: ${total('writableOpeners')}`);
}
