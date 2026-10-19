import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  claudeCodeSpec, cliFailureReason, codexCliSpec, handleCliLine, initialCliState, type CliSpec, type CliState,
} from '../src/runners/cliRunners.ts';
import { spawnStreaming } from '../src/runners/proc.ts';
import type { RunnerContext } from '../src/runners/index.ts';

interface Recorded {
  stages: Array<{ stage: string; message?: string }>;
  logs: string[];
  progress: number[];
  usage: Array<{ tokensIn?: number; tokensOut?: number; costUsd?: number }>;
  sessions: string[];
}

function fakeCtx(): { ctx: RunnerContext; rec: Recorded } {
  const rec: Recorded = { stages: [], logs: [], progress: [], usage: [], sessions: [] };
  const ctx = {
    task: { id: 't_test', prompt: 'x' },
    runId: 'r_test',
    dir: os.tmpdir(),
    signal: new AbortController().signal,
    broker: null,
    stage: (stage: string, message?: string) => rec.stages.push({ stage, message }),
    child: () => {},
    session: (id: string) => rec.sessions.push(id),
    log: (line: string) => rec.logs.push(line),
    progress: (f: number) => rec.progress.push(f),
    usage: (u: Recorded['usage'][number]) => rec.usage.push(u),
  } as unknown as RunnerContext;
  return { ctx, rec };
}

/** Feed a recorded transcript, line by line, exactly as spawnStreaming would. */
function feed(spec: CliSpec, lines: Array<[string, 'stdout' | 'stderr']>): { rec: Recorded; state: CliState } {
  const { ctx, rec } = fakeCtx();
  const state = initialCliState();
  for (const [line, stream] of lines) handleCliLine(spec, ctx, state, line, stream);
  return { rec, state };
}

// ------------------------------------------------------------- claude-code

test('claude stream-json: a full successful transcript exercises every branch', () => {
  const { rec, state } = feed(claudeCodeSpec, [
    ['{"type":"system","subtype":"init","session_id":"s1","tools":["Bash","Edit","Read"]}', 'stdout'],
    ['[WARN] telemetry disabled', 'stderr'],
    ['{"type":"assistant","message":{"content":[{"type":"text","text":"I will fix the bug."}],"usage":{"input_tokens":120,"output_tokens":15}}}', 'stdout'],
    ['{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}}],"usage":{"input_tokens":9,"output_tokens":3}}}', 'stdout'],
    ['{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/a.ts","old_string":"a","new_string":"b"}}],"usage":{"input_tokens":11,"output_tokens":4}}}', 'stdout'],
    ['{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}],"usage":{"input_tokens":7,"output_tokens":2}}}', 'stdout'],
    ['{"type":"assistant","message":{}}', 'stdout'], // no content, no usage: must not throw
    ['{"type":"result","subtype":"success","is_error":false,"result":"Fixed the bug; tests pass.","total_cost_usd":0.0421,"usage":{"input_tokens":2000,"output_tokens":400},"num_turns":4}', 'stdout'],
  ]);

  assert.equal(state.resultOk, true);
  assert.equal(state.lastText, 'Fixed the bug; tests pass.');
  // The init envelope names the conversation; the run row keeps it so a repair
  // round can --resume instead of re-buying the brief.
  assert.equal(state.sessionId, 's1');
  assert.deepEqual(rec.sessions, ['s1'], 'announced once, not once per event that carries it');
  assert.deepEqual(rec.stages.map((s) => s.stage), ['plan', 'work', 'test'], 'Read→plan, Edit→work, Bash npm test→test');
  assert.ok(rec.logs.includes('stderr: [WARN] telemetry disabled'));
  assert.ok(rec.logs.includes('I will fix the bug.'));
  assert.ok(rec.logs.some((l) => l.startsWith('→ Bash')));
  assert.equal(rec.progress.length, 5, 'one progress tick per assistant turn');
  assert.ok(rec.progress.every((p, i, a) => i === 0 || p >= a[i - 1]!), 'progress is monotonic');
  const tokensIn = rec.usage.reduce((n, u) => n + (u.tokensIn ?? 0), 0);
  const tokensOut = rec.usage.reduce((n, u) => n + (u.tokensOut ?? 0), 0);
  const cost = rec.usage.reduce((n, u) => n + (u.costUsd ?? 0), 0);
  assert.equal(tokensIn, 147);
  assert.equal(tokensOut, 24);
  assert.equal(cost, 0.0421);
});

test('claude stream-json: noise, malformed JSON and JSON scalars are logged, never fatal', () => {
  const { rec, state } = feed(claudeCodeSpec, [
    ['not json {', 'stdout'],
    ['null', 'stdout'], // JSON.parse succeeds with null; must not reach the event handler
    ['42', 'stdout'],
    ['[1,2]', 'stdout'],
    ['{"type":"result","subtype":"success","result":"done"}', 'stdout'],
  ]);
  assert.deepEqual(rec.logs.slice(0, 4), ['not json {', 'null', '42', '[1,2]']);
  assert.equal(state.resultOk, true, 'the run still resolves from the final result event');
  assert.equal(state.lastText, 'done');
});

test('claude stream-json: an error result marks the run failed', () => {
  const explicit = feed(claudeCodeSpec, [
    ['{"type":"result","subtype":"error_during_execution","is_error":true}', 'stdout'],
  ]);
  assert.equal(explicit.state.resultOk, false);

  const flagged = feed(claudeCodeSpec, [
    ['{"type":"result","subtype":"success","is_error":true,"result":"looked fine but was not"}', 'stdout'],
  ]);
  assert.equal(flagged.state.resultOk, false, 'is_error wins over a success subtype');
});

// --------------------------------------------------------------- codex-cli

test('codex --json: a full successful transcript exercises every branch', () => {
  const { rec, state } = feed(codexCliSpec, [
    ['{"id":"0","msg":{"type":"session_configured","session_id":"s"}}', 'stdout'],
    ['⚠ sandbox notice', 'stderr'],
    ['{"id":"1","msg":{"type":"agent_message","message":"Reading the failing module."}}', 'stdout'],
    ['{"id":"2","msg":{"type":"exec_command_begin","command":"ls -la src"}}', 'stdout'],
    ['{"id":"3","msg":{"type":"patch_apply_begin","path":"src/a.ts"}}', 'stdout'],
    ['{"id":"4","msg":{"type":"exec_command_begin","command":"npm test"}}', 'stdout'],
    ['{"id":"5","msg":{"type":"token_count","usage":{"input_tokens":500,"output_tokens":80}}}', 'stdout'],
    ['{"id":"6","msg":{"type":"task_complete","last_agent_message":"All fixed."}}', 'stdout'],
  ]);

  assert.equal(state.resultOk, true);
  assert.equal(state.lastText, 'All fixed.');
  assert.deepEqual(rec.stages.map((s) => s.stage), ['work', 'work', 'test']);
  assert.ok(rec.logs.includes('stderr: ⚠ sandbox notice'));
  assert.ok(rec.logs.includes('Reading the failing module.'));
  assert.deepEqual(rec.usage, [{ tokensIn: 500, tokensOut: 80 }]);
});

test('codex --json: error events and a task_complete carrying an error both fail the run', () => {
  const errored = feed(codexCliSpec, [
    ['{"id":"1","msg":{"type":"error","message":"model overloaded"}}', 'stdout'],
  ]);
  assert.equal(errored.state.resultOk, false);
  assert.ok(errored.rec.logs.some((l) => l.startsWith('error:')));

  const completeWithError = feed(codexCliSpec, [
    ['{"id":"1","msg":{"type":"task_complete","error":"ran out of context"}}', 'stdout'],
  ]);
  assert.equal(completeWithError.state.resultOk, false);
});

test('codex --json: malformed lines and scalars are logged as text', () => {
  const { rec, state } = feed(codexCliSpec, [
    ['{{nope', 'stdout'],
    ['false', 'stdout'],
    ['{"id":"1","msg":{"type":"task_complete","last_agent_message":"ok"}}', 'stdout'],
  ]);
  assert.deepEqual(rec.logs.slice(0, 2), ['{{nope', 'false']);
  assert.equal(state.resultOk, true);
  assert.equal(state.lastText, 'ok');
});

// ---------------------------------------------------- chunked line delivery

test('spawnStreaming reassembles lines split across chunks and flushes the tail', async () => {
  const lines: Array<[string, string]> = [];
  const script =
    `printf '{"type":"assi'; sleep 0.05; printf 'stant"}\\n'; ` +
    `printf 'warn\\n' >&2; printf 'tail-without-newline'`;
  const code = await spawnStreaming('/bin/sh', ['-c', script], {
    cwd: os.tmpdir(),
    signal: new AbortController().signal,
    onLine: (line, stream) => lines.push([line, stream]),
  });
  assert.equal(code, 0);
  const stdout = lines.filter(([, s]) => s === 'stdout').map(([l]) => l);
  assert.deepEqual(stdout, ['{"type":"assistant"}', 'tail-without-newline']);
  assert.deepEqual(lines.filter(([, s]) => s === 'stderr').map(([l]) => l), ['warn']);
});

test('a run that ran out of turns says so, instead of quoting the agent mid-sentence', () => {
  const { state } = feed(claudeCodeSpec, [
    [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now converting the quotes:' }] } }), 'stdout'],
    [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's1' }), 'stdout'],
  ]);
  assert.equal(state.resultOk, false);
  assert.equal(state.resultSubtype, 'error_max_turns');

  const reason = cliFailureReason(state.resultSubtype, 40);
  assert.match(reason!, /all 40 of its turns/);
  assert.match(reason!, /FOREMAN_MAX_TURNS_/, 'it names the knob that fixes it');
});

test('a clean run adds no failure reason', () => {
  assert.equal(cliFailureReason('success', 40), null);
  assert.equal(cliFailureReason(null, 40), null);
});
