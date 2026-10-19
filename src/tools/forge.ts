import fs from 'node:fs';
import path from 'node:path';
import { describe, type Schema } from './schema.ts';
import { getTool, registerTool, type ToolManifest } from './catalog.ts';
import { builtToolDir } from './run.ts';
import type { Run, Task } from '../types.ts';
import { linkToolToPlaybook, parseToolRequest } from './link.ts';

export interface ToolRequest {
  name: string;
  description: string;
  /** What the tool must do, in the requester's words. */
  spec: string;
  input?: Schema;
  output?: Schema;
  runtime?: 'node' | 'python';
}

/**
 * The brief handed to the worker that builds a tool. It is deliberately
 * prescriptive about the calling convention: `use_tool` is the only caller,
 * and it speaks JSON on stdin/stdout.
 */
export function toolBrief(req: ToolRequest): string {
  const runtime = req.runtime ?? 'node';
  const entry = runtime === 'python' ? 'tool.py' : 'tool.js';
  const testFile = runtime === 'python' ? 'tool/test/test_tool.py' : 'tool/test/tool.test.js';
  return [
    `Build a reusable tool called "${req.name}".`,
    '',
    `WHAT IT MUST DO:\n${req.spec}`,
    '',
    'DELIVERABLES — create exactly this layout inside the working directory:',
    '  tool/manifest.json',
    `  tool/${entry}`,
    `  ${testFile}`,
    '  tool/README.md',
    '',
    'manifest.json must be valid JSON with these fields:',
    JSON.stringify(
      {
        name: req.name,
        description: req.description,
        runtime,
        entry,
        input: req.input ?? { type: 'object', properties: {}, required: [] },
        output: req.output ?? { type: 'object' },
      },
      null,
      2,
    ),
    '',
    'CALLING CONVENTION (do not deviate):',
    `- ${entry} reads ONE JSON object from stdin and writes ONE JSON object to stdout.`,
    '- Nothing else may go to stdout — diagnostics go to stderr.',
    '- Exit 0 on success, non-zero on failure with a message on stderr.',
    '- Validate the input and fail loudly rather than guessing.',
    '- Use only the language standard library. No network access. No writes outside the working directory.',
    '',
    'TESTS: the test file must run the tool end to end (spawn it, feed stdin, assert stdout)',
    runtime === 'python'
      ? 'and must pass under `python3 -m unittest discover -s tool/test`.'
      : 'and must pass under `node --test "tool/test/*.test.js"`.',
    'A test that only asserts the file exists is not a test.',
  ].join('\n');
}

/** How a tool task proves itself before the council ever sees it. */
export function toolTestCommand(jail: string): string | null {
  const dir = builtToolDir(jail);
  if (!fs.existsSync(path.join(dir, 'test'))) return null;
  const python = fs.existsSync(path.join(dir, 'tool.py'));
  return python
    ? 'python3 -m unittest discover -s tool/test -t .'
    : 'node --test "tool/test/*.test.js"';
}

export interface ToolBuildCheck {
  ok: boolean;
  reason: string;
  manifest: Partial<ToolManifest> | null;
}

/** Structural check run before tests: did the worker deliver the layout at all? */
export function checkBuiltTool(jail: string): ToolBuildCheck {
  const dir = builtToolDir(jail);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return { ok: false, reason: 'no tool/manifest.json was produced', manifest: null };

  let manifest: Partial<ToolManifest>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Partial<ToolManifest>;
  } catch (err) {
    return { ok: false, reason: `tool/manifest.json is not valid JSON: ${(err as Error).message}`, manifest: null };
  }
  if (!manifest.name) return { ok: false, reason: 'manifest.json has no name', manifest };
  if (!manifest.description) return { ok: false, reason: 'manifest.json has no description', manifest };

  const entry = manifest.entry ?? (manifest.runtime === 'python' ? 'tool.py' : 'tool.js');
  if (!fs.existsSync(path.join(dir, entry))) {
    return { ok: false, reason: `entry file tool/${entry} is missing`, manifest };
  }
  if (!fs.existsSync(path.join(dir, 'test'))) {
    return { ok: false, reason: 'the tool ships no tests; a tool without tests is not registerable', manifest };
  }
  return { ok: true, reason: 'layout is complete', manifest };
}

/** Evidence the council reviews for a tool task: the contract plus the source. */
export function toolEvidence(jail: string): string {
  const dir = builtToolDir(jail);
  const parts: string[] = [];
  const read = (rel: string, cap = 8000): void => {
    const file = path.join(dir, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      parts.push(`--- ${rel} ---\n${fs.readFileSync(file, 'utf8').slice(0, cap)}`);
    }
  };
  read('manifest.json', 3000);
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (/\.(js|mjs|cjs|ts|py)$/.test(name)) read(name);
  }
  const testDir = path.join(dir, 'test');
  if (fs.existsSync(testDir)) {
    for (const name of fs.readdirSync(testDir).slice(0, 4)) read(path.join('test', name), 4000);
  }
  return parts.join('\n\n');
}

export interface RegisterResult {
  registered: boolean;
  reason: string;
  tool: ToolManifest | null;
}

/**
 * Registration is the approval side-effect for a tool task, exactly as merging
 * is for a code task: it only ever runs for a task the human approved.
 */
export function registerApprovedTool(task: Task, run: Run | null): RegisterResult {
  if (task.kind !== 'tool') return { registered: false, reason: 'not a tool task', tool: null };
  if (task.status !== 'done') return { registered: false, reason: `task is ${task.status}, not approved`, tool: null };
  if (!run?.worktreePath) return { registered: false, reason: 'the run left no jail to register from', tool: null };

  const check = checkBuiltTool(run.worktreePath);
  if (!check.ok) return { registered: false, reason: check.reason, tool: null };

  try {
    const tool = registerTool({
      sourceDir: builtToolDir(run.worktreePath),
      provenance: { taskId: task.id, runId: run.id, date: new Date().toISOString() },
    });
    const previous = tool.version > 1 ? ` (replacing v${tool.version - 1})` : '';

    // Link it to the role that asked for it, so a tool built for one task is a
    // habit for the next rather than a thing to be rediscovered. Only on a
    // first registration: a v2 is already linked, and re-linking would append
    // a duplicate on every rebuild.
    let link = '';
    if (tool.version === 1) {
      const req = parseToolRequest(task.prompt);
      if (req) {
        const result = linkToolToPlaybook(tool.name, req);
        // Never fatal. A tool that registered and did not link is a working
        // tool with a missing habit; failing the approval over it would trade
        // something that matters for something that does not.
        link = `; ${result.reason}`;
      }
    }
    return { registered: true, reason: `registered '${tool.name}' v${tool.version}${previous}${link}`, tool };
  } catch (err) {
    return { registered: false, reason: `registration refused: ${(err as Error).message}`, tool: null };
  }
}

/** One-line summaries for a model's tool surface. */
export function toolSurface(tools: ToolManifest[]): string {
  if (!tools.length) return '(the catalog is empty)';
  return tools
    .map((t) => `- ${t.name}: ${t.description} — args ${describe(t.input)}${t.quarantined ? ' [QUARANTINED]' : ''}`)
    .join('\n');
}

export { getTool };
