/**
 * `node <foreman>/src/verify/testSlot.ts [-- <cmd>]` — the one way a worker
 * session runs a full test suite.
 *
 * slots.ts caps the test commands Foreman spawns, but a worker running
 * `npm run verify` in its own session was invisible to it: a worker's suite ran
 * beside two gate verifies under a cap of 2, at load 64-90. This wrapper asks
 * the running daemon for one of the same slots (POST /api/verify-slot), runs the
 * command in the foreground while it holds it, and exits with the result. The
 * lease is the HTTP connection itself: when this process exits, however it
 * dies, the socket closes and the daemon releases the slot.
 *
 * One suite run per ticket at a time: the wrapper tells the daemon which run it
 * is (FOREMAN_RUN_ID), and the daemon refuses a second request while the first
 * is open — this one then exits 4 without running anything. And nobody runs a
 * suite again to read more of it: the whole output goes to a file
 * (suiteOutput.ts); what is printed is the end, the failing tests last, and a
 * final line naming the file. `--saved` prints the newest saved output of this
 * run and runs nothing.
 *
 * It runs the test-shaped commands the worker could already run directly,
 * the ticket's own test command (with extra arguments, to run one file), and
 * a test command detected from the project only exactly as detected. That is
 * not "no shell": the command goes to sh, and extra arguments to the ticket's
 * command are as wide as that command's own argument surface — which is why a
 * detected command, which nobody chose for this ticket, takes none.
 */
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config, daemonUrl } from '../config.ts';
import { installProcessRecorder } from '../runners/freezeInstall.ts';
import { OUTPUT_HEADER, RUN_HEADER, WRAPPER_PID_HEADER } from './slots.ts';
import { outputDir, savedOutputs, SuiteLog } from './suiteOutput.ts';
import { detectTestCmd, runTests } from './tests.ts';

/** The ticket's test command, handed to the worker session by the CLI runner. */
export const WORKER_TEST_CMD_ENV = 'FOREMAN_WORKER_TEST_CMD';
/** Which run the worker session belongs to, handed to it the same way. Unset (an older worker env, a person at a shell): as before. */
export const RUN_ID_ENV = 'FOREMAN_RUN_ID';

/** Exit code when this run already has a suite run in progress: nothing was run, and no slot was taken. */
export const EXIT_ALREADY_RUNNING = 4;
/** Lines of the suite's own output printed at the end; the whole of it is in the saved file. */
const TAIL_LINES_FAILED = 40;
const TAIL_LINES_PASSED = 20;
/** A daemon too old to say how many are ahead: the wait is announced once it has lasted this long. */
const QUEUED_NOTICE_MS = 2_000;

/** Who is asking for a slot, when the worker env says: the daemon then holds this run to one suite run at a time. */
export interface SlotCaller {
  runId: string;
  /** Where this run's output will be saved, so a refused second invocation can be told. */
  output?: string | null;
}

/** The daemon's refusal: this run already has a slot request open (waiting or running its suite). */
export interface SlotBusy {
  busy: { secs: number; pid: number | null; output: string | null };
}

function parseBusy(body: string): SlotBusy {
  // `busy <seconds> <pid|-> <path…>` (slots.ts claimRunLease); anything else still means busy.
  const m = /^busy (\d+) (\d+|-)(?: (.+))?$/.exec(body.trim().split('\n')[0] ?? '');
  return { busy: { secs: m ? Number(m[1]) : 0, pid: m && m[2] !== '-' ? Number(m[2]) : null, output: m?.[3] ?? null } };
}

/**
 * Whether `cmd` may run through the wrapper: the ticket's own test command, or
 * one of the test-shaped commands the worker allowlist already grants. The
 * ticket's command with extra arguments (`python3 -m pytest -q tests/x.py`) is
 * how a non-npm project runs one file, since that command is no longer granted
 * directly. Anything chained, substituted or redirected is refused — the
 * wrapper hands the command to sh.
 */
export function wrappableCommand(cmd: string, ticketCmd: string | null, detectedCmd: string | null = null): boolean {
  const c = cmd.trim();
  if (!c) return false;
  const ticket = ticketCmd?.trim();
  if (ticket && c === ticket) return true;
  // Detected, not chosen for this ticket: exactly as detected, no extra arguments.
  if (detectedCmd?.trim() && c === detectedCmd.trim()) return true;
  if (/[;&|`$<>()\n\\]/.test(c)) return false;
  if (ticket && c.startsWith(`${ticket} `)) return true;
  return /^(npm (test|t|run [\w:.-]+)|node --test|npx tsc)(\s|$)/.test(c);
}

/**
 * Hold a verify slot on the daemon at `base`. Resolves with a release function
 * once the slot is granted, or null when there is no daemon to ask (refused, or
 * one too old to have the endpoint) — the caller then runs unslotted, as it
 * would have before. `onQueued` is called at most once, when the caller is
 * known to be waiting, with how many are ahead of it (null: the daemon did not
 * say). With `caller`, a daemon that already has a request open for that run
 * answers busy: nothing is held, and the caller must not run.
 */
export function holdSlot(
  base: string,
  onQueued: (ahead: number | null) => void,
  maxWaitMs = Infinity,
  caller?: SlotCaller | null,
): Promise<(() => void) | null | 'timeout' | SlotBusy> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let notice: NodeJS.Timeout | undefined;
    let told = false;
    const waiting = (ahead: number | null): void => {
      clearTimeout(notice);
      if (told || settled) return;
      told = true;
      onQueued(ahead);
    };
    const done = (v: (() => void) | null | 'timeout' | SlotBusy): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(notice);
      resolve(v);
    };
    const headers: Record<string, string> = {};
    if (caller?.runId) {
      headers[RUN_HEADER] = caller.runId;
      headers[WRAPPER_PID_HEADER] = String(process.pid);
      // A header takes no control characters or non-ASCII: such a path is simply not announced.
      if (caller.output && /^[\x20-\x7e]+$/.test(caller.output)) headers[OUTPUT_HEADER] = caller.output;
    }
    // Client-side: a wait past this gives up (the closed socket drops our place
    // in the daemon's queue) rather than hold the worker's whole turn.
    if (Number.isFinite(maxWaitMs)) {
      timer = setTimeout(() => {
        done('timeout');
        req.destroy();
      }, maxWaitMs);
      timer.unref?.();
    }
    const req = http.request(`${base}/api/verify-slot`, { method: 'POST', headers }, (res) => {
      if (res.statusCode === 409 && caller?.runId) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { if (body.length < 4096) body += chunk; });
        res.on('end', () => done(parseBusy(body)));
        res.on('close', () => done(parseBusy(body)));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === 'queued') {
            if (!told && !notice) {
              notice = setTimeout(() => waiting(null), QUEUED_NOTICE_MS);
              notice.unref?.();
            }
          } else if (/^ahead \d+$/.test(line)) waiting(Number(line.slice(6)));
          else if (line.startsWith('granted')) done(() => req.destroy());
        }
      });
      // The daemon ended the lease (stopping, or the lease outlived its cap).
      res.on('close', () => done(null));
    });
    req.on('error', () => done(null));
    req.end();
  });
}

/** How long the wrapper waits for a slot before giving up, FOREMAN_SLOT_WAIT_MS (default 10 minutes). */
export function slotWaitMs(): number {
  const ms = Number(process.env['FOREMAN_SLOT_WAIT_MS']);
  return Number.isFinite(ms) && ms > 0 ? ms : 10 * 60_000;
}

/** stdout, for a reader that may have gone: `| head -1` closing the pipe must not end the wrapper (or its suite). */
let stdoutGone = false;
function out(text: string): void {
  if (!stdoutGone) process.stdout.write(text);
}

/** `--saved`: print the newest saved output of this run. Runs nothing and takes no slot. */
async function printSaved(runId: string | null): Promise<number> {
  const dir = outputDir(process.cwd());
  const newest = dir ? savedOutputs(dir, runId)[0] : undefined;
  if (!newest) {
    process.stderr.write('testSlot: no saved suite output for this run yet\n');
    return 2;
  }
  process.stderr.write(`testSlot: ${newest}\n`);
  await new Promise<void>((resolve) => {
    const src = fs.createReadStream(newest);
    src.on('error', () => resolve());
    src.on('close', () => resolve());
    process.stdout.on('error', () => src.destroy());
    src.pipe(process.stdout, { end: false });
  });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // A reader that closed the pipe gets no more output; the suite and its saved file are not its to end.
  process.stdout.on('error', () => { stdoutGone = true; });
  const runId = process.env[RUN_ID_ENV]?.trim() || null;
  // This wrapper's to send, not the suite's to inherit: a suite that starts wrappers of its own is not this run asking again.
  delete process.env[RUN_ID_ENV];
  if (argv[0] === '--saved') return printSaved(runId);
  const dash = argv.indexOf('--');
  const ticketCmd = process.env[WORKER_TEST_CMD_ENV]?.trim() || null;
  const detected = ticketCmd ? null : detectTestCmd(process.cwd());
  const cmd = dash >= 0 ? argv.slice(dash + 1).join(' ').trim() : ticketCmd ?? detected ?? '';
  if (!cmd) {
    process.stderr.write('testSlot: no test command found for this directory; pass one after --\n');
    return 2;
  }
  if (!wrappableCommand(cmd, ticketCmd, detected)) {
    process.stderr.write(
      `testSlot: refused '${cmd}': only the ticket's test command, npm test, npm run <script>, ` +
        'node --test or npx tsc run through here\n',
    );
    return 2;
  }

  const base = daemonUrl(config.host, config.port);
  const started = Date.now();
  const maxWait = slotWaitMs();
  // Named before the slot is asked for, so a second invocation refused meanwhile can be told where to look.
  const outputPath = SuiteLog.pathFor(process.cwd(), runId);
  let waited = false;
  const release = await holdSlot(
    base,
    (ahead) => {
      waited = true;
      process.stderr.write(`testSlot: waiting for a test slot${ahead === null ? '' : ` (${ahead} ahead)`}\n`);
    },
    maxWait,
    runId ? { runId, output: outputPath } : null,
  );
  if (release === 'timeout') {
    // Never run unslotted here: the slot exists because the machine is loaded.
    process.stderr.write(
      `testSlot: slot wait exceeded (${Math.round(maxWait / 1000)}s, FOREMAN_SLOT_WAIT_MS); ${cmd} was NOT run. ` +
        'Retry later, or run targeted test files directly with `node --test <file>`.\n',
    );
    return 3;
  }
  if (release && typeof release !== 'function') {
    const { secs, pid, output } = release.busy;
    process.stderr.write(
      `testSlot: a suite run for this ticket is already in progress (started ${secs} s ago${pid === null ? '' : `, pid ${pid}`}); ` +
        `wait for it — its full output will be at ${output ?? 'the path on its last line'}\n`,
    );
    return EXIT_ALREADY_RUNNING;
  }
  const waitedS = Math.round((Date.now() - started) / 1000);
  if (release) {
    if (waited) process.stderr.write(`testSlot: test slot granted after ${waitedS} s\n`);
    process.stderr.write(`testSlot: slot held after ${waitedS}s; running ${cmd}\n`);
  } else {
    process.stderr.write(`testSlot: no Foreman daemon at ${base} to share slots with; running ${cmd} unslotted\n`);
  }

  // The marker and any frozen leftover groups of the suite go in <home>/frozen; refused to a sandboxed worker (said on stderr).
  await installProcessRecorder(config.home);
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(sig, () => controller.abort());
  }
  const log = SuiteLog.open(outputPath, runId, TAIL_LINES_FAILED);
  try {
    const result = await runTests(process.cwd(), cmd, controller.signal, (line) => log.line(line));
    if (controller.signal.aborted) log.line('testSlot: stopped by a signal before the suite finished; this output is cut short');
    log.close();
    // The end of the output, then every failing test LAST: whatever slice of this a reader keeps (`| tail`), the
    // assertions and the two lines below are in it.
    const tail = log.lastLines(result.passed ? TAIL_LINES_PASSED : TAIL_LINES_FAILED);
    if (tail.length) out(`--- last ${tail.length} of ${log.lines} lines ---\n${tail.join('\n')}\n`);
    if (!result.passed && log.failing.lines.length) {
      out(`--- failing tests ---\n${log.failing.lines.join('\n')}\n`);
      if (log.failing.dropped) out(`(${log.failing.dropped} more lines of failing tests are in the saved output)\n`);
    }
    process.stderr.write(`testSlot: ${cmd} ${result.passed ? 'PASSED' : 'FAILED'}\n`);
    out(
      log.file && !log.problem
        ? `testSlot: full output saved to ${log.file} (${log.lines} lines)\n`
        : `testSlot: full output NOT saved (${log.problem ?? 'unknown'})\n`,
    );
    return result.passed ? 0 : 1;
  } finally {
    log.close();
    release?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    // Whatever was printed has left this process before it exits (a reader that is gone is not waited for).
    (code) => (stdoutGone ? process.exit(code) : process.stdout.write('', () => process.exit(code))),
    (err: unknown) => {
      process.stderr.write(`testSlot: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
