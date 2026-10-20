import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { DOCTOR_DEADLINE_MS, DOCTOR_PING_TIMEOUT_MS } from './doctorTiming.ts';
import type { ReceiptWindow, Store } from './queue.ts';
import { REVIEW_SOURCE_MAX } from './queue.ts';
import type { Scheduler } from './scheduler.ts';
import { loadCatalog } from './agents.ts';
import { getPlaybook, loadPlaybooks } from './playbooks.ts';
import { readBench } from './bench.ts';
import { effectiveAssignee, envAssignee } from './assign.ts';
import { cloudDown, cloudFallback, localOnly, localOnlyMode, modeSummary } from './localOnly.ts';
import { missingTools, tierModel } from './roles.ts';
import { adoptedPersonas, personaReachable } from './align/personaHealth.ts';
import { personaServerUrl } from './align/personas.ts';
import { estimateFrom } from './archive.ts';
import {
  agreementReport, MAX_FALSE_PASS_RATE, MIN_AGREEMENT, MIN_SAMPLES, shadowEnabled,
} from './agreement.ts';
import { pruneDepsCache } from './deps.ts';
import { computeLatencyReport } from './latency.ts';
import { gatherEvidence, proposeImprovement, queueImprovement } from './improve.ts';
import { consolidate } from './assistant/memory.ts';
import { applyApproval, applyRejection, envGate, ShuttingDownError } from './gate.ts';
import { crewAdvisories } from './verify/crewReview.ts';
import { planAsk, queuePlan, type Plan } from './assistant/plan.ts';
import {
  cloneEpic, crewPlan, parseCrewPlan, queueCrewPlan, type CrewPlan, type QueuedEpic,
} from './assistant/crewPlan.ts';
import { critiquePlan, escalateForAuto, type PlanCritique } from './assistant/planCheck.ts';
import { approvePending, forgePlaybook, listPending, rejectPending } from './assistant/playbookForge.ts';
import { pruneJails } from './merge.ts';
import { listTools, removeTool, setQuarantine, getTool, toolsDir } from './tools/catalog.ts';
import { traceTask } from './trace.ts';
import { auditHasBans, formatAuditReport, type ProseAuditResult } from './prose/audit.ts';
import { auditDirAsync, AUDIT_TIMEOUT_MS } from './prose/auditWorker.ts';
import { claudeSpecs, probeCloud, reloadSpecs, specs } from './models.ts';
import { memoryWarning, modelSizeGb, readMemory } from './memory.ts';
import { getRunner, runnerIds } from './runners/index.ts';
import { modelForTask } from './roles.ts';
import { setTicketSkills } from './skills.ts';
import { withDroppedIssues } from './verify/crewReview.ts';
import { acquireVerifySlot, claimRunLease, slotsAhead, VerifyWaitAborted } from './verify/slots.ts';
import { testTimeoutMs } from './verify/tests.ts';
import { probeTask, STAGES } from './types.ts';
import type { Decision, GateMode, RunEvent, Sensitivity } from './types.ts';

const BOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'board');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Once a client's socket stops draining, every further SSE event sits in
 * daemon memory. Allow a bounded burst, then drop the client — a reader that
 * far behind can reconnect with ?since= and catch up from SQLite.
 */
export const SSE_MAX_PENDING = 1000;

/** Per-client SSE write policy: bounded buffering, then disconnection. */
export class SseClient {
  private readonly res: Pick<http.ServerResponse, 'write' | 'destroy' | 'writableEnded'>;
  private readonly maxPending: number;
  private pending = 0;
  private dropped = false;

  constructor(res: Pick<http.ServerResponse, 'write' | 'destroy' | 'writableEnded'>, maxPending = SSE_MAX_PENDING) {
    this.res = res;
    this.maxPending = maxPending;
  }

  get isDropped(): boolean {
    return this.dropped;
  }

  /** The socket drained; the client is keeping up again. */
  drained(): void {
    this.pending = 0;
  }

  /** Returns false once the client has been dropped or has gone away. */
  write(chunk: string): boolean {
    if (this.dropped || this.res.writableEnded) return false;
    if (this.res.write(chunk)) {
      this.pending = 0;
      return true;
    }
    if (++this.pending >= this.maxPending) {
      this.dropped = true;
      this.res.destroy(); // 'close' fires and tears the listeners down
      return false;
    }
    return true;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The body of a decision route (approve, cancel, retry, reopen): what the
 * caller says about the decision, for the `decisions` row. An empty body is no
 * statement and is fine. A body that cannot be read, or a field of the wrong
 * shape, throws (a 400 from the catch in createServer) BEFORE anything is
 * decided: these routes used to go ahead as if nothing had been sent, so a
 * retry whose note was mangled on the way requeued the ticket without it.
 */
async function readDecisionBody(req: http.IncomingMessage): Promise<{
  body: Record<string, unknown>; note: string | null; corrected: boolean | null; reviewSource: string | null;
}> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch (err) {
    throw new Error(`the request body could not be read, so nothing was done: ${(err as Error).message.slice(0, 200)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the request body must be a JSON object; nothing was done');
  const body = raw as Record<string, unknown>;
  const text = (key: string, max?: number): string | null => {
    const v = body[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new Error(`${key} must be text; nothing was done`);
    if (max !== undefined && v.length > max) throw new Error(`${key} is ${v.length} characters; at most ${max} are kept, so nothing was done`);
    return v;
  };
  const corrected = body['corrected'];
  if (corrected !== undefined && corrected !== null && typeof corrected !== 'boolean') {
    throw new Error('corrected must be true (--corrected), false (--clean) or left out; nothing was done');
  }
  return { body, note: text('note'), corrected: corrected ?? null, reviewSource: text('reviewSource', REVIEW_SOURCE_MAX) };
}

/**
 * A cancel's note, read without ever refusing the cancel: cancel is the stop button, and `curl -d 'stop' …/cancel`
 * answered 400 with the worker still running. A body that is absent or empty is no note; one that cannot be read
 * (not JSON, not an object, over the limit, a note that is not text) is dropped and `problem` says why.
 */
async function readCancelNote(req: http.IncomingMessage, limit = 1_000_000): Promise<{ note: string | null; problem: string | null }> {
  // Not readJsonBody: leaving its loop early destroys the request, and with it the socket the answer goes out on.
  // Past the limit the rest is drained unread, so a cancel with an over-long body is still answered.
  const text = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.once('error', () => resolve(null));
    req.once('close', () => resolve(null));
  });
  if (text === null) return { note: null, problem: `the request body could not be read (too large, over ${limit} bytes, or cut off)` };
  if (!text.trim()) return { note: null, problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { note: null, problem: `the request body is not JSON (${(err as Error).message.slice(0, 120)})` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { note: null, problem: 'the request body is not a JSON object' };
  const note = (raw as Record<string, unknown>)['note'];
  if (note === undefined || note === null) return { note: null, problem: null };
  if (typeof note !== 'string') return { note: null, problem: 'note is not text' };
  return { note, problem: null };
}

/**
 * `--corrected` / `--clean` say whether APPROVED work needed a correction (the `decisions` row of an approval).
 * On a reject, retry or reopen they mean nothing and used to be dropped unseen; they are refused, before anything
 * is decided, like any other field these routes cannot take.
 */
function refuseCorrected(body: unknown, action: string): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const stated = (body as Record<string, unknown>)['corrected'];
  if (stated === undefined || stated === null) return;
  throw new Error(`corrected (--corrected / --clean) only means something on approve; it cannot be recorded on a ${action}, so nothing was done`);
}

/**
 * The row a decision route has just written, for its answer. Null when the
 * ledger did not take it (Store.noteDecision said so on the timeline): never
 * an older row of the same ticket, which would confirm something else.
 */
function justRecorded(store: Store, taskId: string, action: Decision['action'], since: number): Decision | null {
  try {
    const last = store.decisionsForTask(taskId).at(-1);
    return last && last.action === action && last.at >= since ? last : null;
  } catch {
    // The decision has taken effect; a ledger that cannot be read back must not turn its answer into an error.
    return null;
  }
}

/** Snapshot-only stub length for the long free-text task fields (full text lives at /api/tasks/:id). */
const SNAPSHOT_TEXT_STUB_LEN = 200;
/** `error` is shown inline on cards and epic headers, so it keeps more room than a stub, but still bounded. */
const SNAPSHOT_ERROR_STUB_LEN = 500;

/**
 * Truncates a long free-text field for the snapshot and reports whether it
 * actually cut anything, via one consistent `<field>Truncated` flag rather
 * than making callers infer it from string length.
 */
function stub(text: string | null, len: number): { value: string | null; truncated: boolean } {
  if (text == null || text.length <= len) return { value: text, truncated: false };
  return { value: text.slice(0, len), truncated: true };
}

function snapshot(store: Store, scheduler: Scheduler): unknown {
  // Two grouped queries rather than two per task: the board polls this on
  // every event, so it must not scale with the length of the history.
  const runs = store.latestRunByTask();
  const provisional = new Set(store.provisionalAwaiting(1000).map((t) => t.id));
  const artifacts = store.artifactsByTask();
  // Resolved once per snapshot, not once per task: loadPlaybooks() is cached
  // on the dir's mtime+size fingerprint (see playbooks.ts), but even a cache
  // hit is a readdir+statSync sweep, and a 50-task crew board would otherwise
  // pay that sweep 50 times per poll for no reason.
  const catalog = loadPlaybooks();
  const houseDefault = store.defaultAssignee();
  // Archived tasks are deliberately absent from the board payload: the Closed
  // lane is "what just happened", and an unbounded history buries it. They are
  // not gone — `GET /api/archive` serves them, and the count below is what the
  // lane renders as its "N older" affordance.
  const tasks = store.listTasks().filter((t) => t.archivedAt == null).map((task) => {
    // The board polls this on every SSE event, and a crew epic can carry
    // dozens of tasks with multi-KB prompts/acceptance/repair notes — sending
    // those in full on every poll is the payload this snapshot exists to
    // avoid. Only a short stub goes out here; the drawer's Prompt tab and
    // anything else needing the full text reads it from GET /api/tasks/:id,
    // which still returns the task unstubbed.
    const prompt = stub(task.prompt, SNAPSHOT_TEXT_STUB_LEN);
    const acceptance = stub(task.acceptance, SNAPSHOT_TEXT_STUB_LEN);
    const repairNotes = stub(task.repairNotes, SNAPSHOT_TEXT_STUB_LEN);
    const error = stub(task.error, SNAPSHOT_ERROR_STUB_LEN);
    return {
      ...task,
      prompt: prompt.value,
      promptTruncated: prompt.truncated,
      acceptance: acceptance.value,
      acceptanceTruncated: acceptance.truncated,
      repairNotes: repairNotes.value,
      repairNotesTruncated: repairNotes.truncated,
      error: error.value,
      errorTruncated: error.truncated,
      // Same derivation-not-storage argument as `model` below: the board needs
      // to show whether a card will be worked by a model or by the operator,
      // and that answer lives in the playbook + env, not in the row.
      resolvedAssignee: effectiveAssignee(task, catalog, houseDefault),
      // Resolved model is derived, not stored — the same resolution order the
      // scheduler uses (agent pin → playbook role tier → generic role tier),
      // recomputed here so the board can show what a task will actually run on
      // (or did run on) without duplicating that logic client-side.
      model: modelForTask(task, catalog),
      run: runs.get(task.id) ?? null,
      // Reviewed on stepped-down models; the scheduler re-checks it when the
      // full council fits (scheduler.ts:runDueRechecks).
      provisional: provisional.has(task.id),
      artifacts: artifacts.get(task.id) ?? [],
    };
  });
  const lastEvent = store.db.prepare('SELECT MAX(id) AS id FROM events').get() as Record<string, unknown> | undefined;
  const today = new Date().toISOString().slice(0, 10);
  const callsByLocal = store.receiptCallCountsByLocal(today);
  return {
    tasks,
    archivedCount: store.archiveCount(),
    // What the board's toggle should read, and what it means. `effective` is
    // what a new task with no opinion of its own would actually get.
    gate: {
      houseDefault: store.defaultGate(),
      // What a ticket with no opinion of its own would get. The playbook still
      // outranks this, so a publishing ticket can read 'owner' here and still
      // park for a person — which is why the board shows the resolved value
      // per card as well.
      // Local-only forces every gate to the human (local-only policy, enforced in
      // gate.ts). The toggle must say so: a board reading "Auto-gate" while
      // every ticket parks for a person is the mode-you-forget-you-are-in
      // failure the toggle exists to prevent.
      effective: localOnly() || cloudFallback() ? 'human' : store.defaultGate() ?? envGate(),
      forcedHuman: localOnly() || cloudFallback(),
      waiting: store.awaitingApproval(1000).length,
    },
    mode: {
      localOnly: localOnly(),
      fallback: cloudFallback(),
      setting: localOnlyMode(),
      cloudDown: cloudDown(),
    },
    assignee: {
      houseDefault,
      effective: houseDefault ?? envAssignee() ?? 'ai',
      fromEnv: envAssignee(),
    },
    stats: store.stats(),
    stages: STAGES,
    workers: {
      max: scheduler.workers,
      active: scheduler.activeCount,
      verifying: scheduler.verifyingCount,
      verifyLane: scheduler.verifyLaneSize,
    },
    budget: {
      spentToday: store.spentToday(),
      // The cap governs metered spend only; this is every dollar recorded,
      // including subscription calls that were never billed.
      spentTodayAll: store.spentTodayIncludingSubscription(),
      dailyCapUsd: scheduler.broker.dailyCap,
      callsToday: callsByLocal.total,
      nonLocalCallsToday: callsByLocal.nonLocal,
    },
    roster: readBench()?.roster ?? null,
    lastEventId: Number(lastEvent?.['id'] ?? 0),
    serverTime: Date.now(),
  };
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 127.0.0.1 and localhost name the same daemon; everything else compares
 * literally. Brackets come off first: URL.hostname keeps them on an IPv6
 * literal ("[::1]") while the Host header split does not, so the board served
 * on [::1] had every write refused as cross-origin by its own page.
 */
function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return LOOPBACK_HOSTNAMES.has(lower) ? '127.0.0.1' : lower;
}

/** Splits a Host header ("host:port" or "[::1]:port") into its parts. */
function splitHostHeader(hostHeader: string, defaultPort: string): { hostname: string; port: string } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostHeader);
  if (bracketed) return { hostname: normalizeHostname(bracketed[1]!), port: bracketed[2] ?? defaultPort };
  const idx = hostHeader.lastIndexOf(':');
  if (idx === -1) return { hostname: normalizeHostname(hostHeader), port: defaultPort };
  return { hostname: normalizeHostname(hostHeader.slice(0, idx)), port: hostHeader.slice(idx + 1) };
}

/**
 * CSRF guard: a cross-origin page cannot be trusted to only make GET requests
 * (a plain <form> or a text/plain fetch needs no preflight), so any write has
 * to be checked by hand. Same-origin browser requests, and any client that
 * sends no Origin header at all (curl, the CLI, server-to-server calls), are
 * both let through — only a *mismatched* Origin is refused.
 *
 * Compared against the request's own Host header rather than config.host/port
 * directly: that's what the browser actually targeted, and it is the only
 * value that is right whether the daemon is bound to its configured port or
 * (as in tests) an OS-assigned ephemeral one.
 */
/**
 * Names this daemon will answer to, for DNS-rebinding defence.
 *
 * The CSRF check compares Origin against the HOST HEADER, which the attacker
 * controls. Point `evil.com` at 127.0.0.1 and a page served from it sends
 * `Origin: http://evil.com:4100` and `Host: evil.com:4100` — they match, the
 * request reads as same-origin, and any page on the internet can POST
 * /api/tasks. Binding to loopback does not help: the browser IS on the box.
 *
 * That composes with the one limitation this system already documents — that
 * `run_shell` screening is "a guardrail, not a sandbox" — into a drive-by that
 * queues a shell task. The screening was never meant to stop a determined
 * command; it was meant to stop a careless one, on the assumption that only
 * the operator could queue anything at all. This restores that assumption.
 *
 * So a request whose Host is not a name we actually serve is refused outright,
 * on every method: rebinding cannot survive a check that never trusts the
 * header it is attacking. `FOREMAN_ALLOWED_HOSTS` extends the list for an
 * operator who reverse-proxies or reaches the board by LAN name.
 */
function hostIsAllowed(req: http.IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  // No Host at all is the CLI, curl, or HTTP/1.0 — not a browser, so not the
  // attack this defends against.
  if (!hostHeader) return true;
  const { hostname } = splitHostHeader(Array.isArray(hostHeader) ? hostHeader[0]! : hostHeader, String(config.port));

  const allowed = new Set(
    ['127.0.0.1', 'localhost', '::1', '0.0.0.0', normalizeHostname(config.host)]
      .concat((process.env['FOREMAN_ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean))
      .map(normalizeHostname),
  );
  return allowed.has(hostname);
}

export function isCrossOriginWrite(req: Pick<http.IncomingMessage, 'headers'>): boolean {
  const originHeader = req.headers.origin;
  if (!originHeader) return false;
  const originValue = Array.isArray(originHeader) ? originHeader[0]! : originHeader;
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    return true; // an Origin header that doesn't even parse is not one to trust
  }
  const originDefaultPort = origin.protocol === 'https:' ? '443' : '80';
  const originHostname = normalizeHostname(origin.hostname);
  const originPort = origin.port || originDefaultPort;

  const hostHeader = req.headers.host;
  const { hostname: selfHostname, port: selfPort } = hostHeader
    ? splitHostHeader(hostHeader, '80')
    : { hostname: normalizeHostname(config.host), port: String(config.port) };

  return originHostname !== selfHostname || originPort !== selfPort;
}

function serveBoard(res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(BOARD_DIR, rel);
  // Containment check: never serve anything outside board/.
  if (file !== BOARD_DIR && !file.startsWith(BOARD_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

export function createServer(store: Store, scheduler: Scheduler): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    // Before anything else, including the board: a Host we do not serve is a
    // rebinding attempt, and the whole point is not to trust that header.
    if (!hostIsAllowed(req)) {
      return json(res, 403, {
        error: 'refused: unrecognised Host header (DNS-rebinding defence). ' +
          'Set FOREMAN_ALLOWED_HOSTS if you reach this daemon by another name.',
      });
    }

    if (seg[0] !== 'api') {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return serveBoard(res, url.pathname);
    }

    // Any non-GET /api request from a page the browser identifies as a
    // different origin is refused outright — see isCrossOriginWrite() above.
    // A request with no Origin header (curl, the CLI, server-to-server) is
    // unaffected: this is a same-origin-vs-cross-origin check, not auth.
    if (method !== 'GET' && isCrossOriginWrite(req)) {
      return json(res, 403, { error: 'cross-origin write refused' });
    }

    // --- SSE -------------------------------------------------------------
    if (seg[1] === 'events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Without an explicit flush the client sees nothing until the first
      // event, so EventSource.onopen (and any fetch on this URL) stalls.
      res.flushHeaders();
      const since = Number(url.searchParams.get('since') ?? '0');
      const client = new SseClient(res);
      const send = (ev: RunEvent): void => {
        client.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      if (Number.isFinite(since) && since > 0) for (const ev of store.eventsSince(since)) send(ev);
      const onEvent = (ev: RunEvent): void => send(ev);
      store.on('event', onEvent);
      const beat = setInterval(() => {
        client.write(': ping\n\n');
      }, 15_000);
      beat.unref?.();
      const teardown = (): void => {
        clearInterval(beat);
        store.off('event', onEvent);
      };
      res.on('drain', () => client.drained());
      res.on('close', teardown);
      res.on('error', teardown);
      return;
    }

    // --- verify-slot lease (src/verify/testSlot.ts) -----------------------
    // A worker's own full-suite run takes one of the slots Foreman's gate runs
    // use. The lease IS this response: held open while the caller runs its
    // suite, released the moment the connection closes, however the caller died.
    if (seg[1] === 'verify-slot' && method === 'POST') {
      // Which run is asking, when the wrapper says (x-foreman-run): a run holds one suite run at a time — a second
      // request while the first is open is refused before it takes a place — and its wait for a slot is not charged
      // to its deadline. The claim, like the slot, lasts exactly as long as this response.
      const lease = claimRunLease(req.headers);
      if (lease.busy) {
        res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`${lease.busy}\n`);
        return;
      }
      let waiting = false;
      const queued = (on: boolean): void => {
        if (!lease.runId || waiting === on) return;
        waiting = on;
        scheduler.slotQueued(lease.runId, on);
      };
      const gone = new AbortController();
      let release: (() => void) | null = null;
      const end = (): void => {
        gone.abort();
        release?.();
        queued(false);
        lease.release();
      };
      res.on('close', end);
      // A caller already gone gets no 'close' here: nothing may stay claimed for it.
      if (req.socket.destroyed) end();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.write('queued\n');
      // Said only when it will wait, so the wrapper can show the wait in the worker's transcript.
      const ahead = slotsAhead();
      if (ahead !== null) res.write(`ahead ${ahead}\n`);
      // Keeps an idle lease visibly alive, and turns a peer that vanished
      // without a FIN into a write error, which closes the response.
      const beat = setInterval(() => res.write('.\n'), 15_000);
      beat.unref?.();
      gone.signal.addEventListener('abort', () => clearInterval(beat), { once: true });
      try {
        queued(true);
        const slot = await acquireVerifySlot(gone.signal);
        queued(false);
        release = slot.release;
        if (gone.signal.aborted) return slot.release();
        res.write(`granted ${slot.waitedMs}\n`);
      } catch (err) {
        queued(false);
        if (err instanceof VerifyWaitAborted) return;
        throw err;
      }
      // A suite runs at most testTimeoutMs() under the wrapper; a lease held
      // well past that belongs to something hung, and every gate is behind it.
      const cap = setTimeout(() => res.destroy(), testTimeoutMs() + 5 * 60_000);
      cap.unref?.();
      gone.signal.addEventListener('abort', () => clearTimeout(cap), { once: true });
      return;
    }

    if (seg[1] === 'state' && method === 'GET') return json(res, 200, snapshot(store, scheduler));

    if (seg[1] === 'settings' && seg[2] === 'gate' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const valid = (v: unknown): boolean => v === null || v === 'human' || v === 'owner';

      // Two independent effects, and a caller may want either alone:
      // `gate` changes the house default for work queued from now on;
      // `applyToWaiting` hands the CURRENT backlog over. Handing over the
      // backlog without also changing the default is a legitimate thing to
      // want — "decide these for me, but keep asking me about new work" — so
      // an absent `gate` leaves the default exactly where it was.
      if ('gate' in body) {
        if (!valid(body['gate'])) return json(res, 400, { error: "gate must be 'human', 'owner', or null" });
        store.setDefaultGate(body['gate'] as never);
      }

      let applied: string[] = [];
      if (body['applyToWaiting'] !== undefined && body['applyToWaiting'] !== false) {
        const to = body['applyToWaiting'] === true ? store.defaultGate() : body['applyToWaiting'];
        if (!valid(to) || to === null) {
          return json(res, 400, { error: "applyToWaiting needs a gate: pass 'human'/'owner', or set the house default first" });
        }
        applied = store.gateWaiting(to as never);
      }
      void scheduler.tick().catch(() => {});
      return json(res, 200, { houseDefault: store.defaultGate(), applied: applied.length });
    }

    if (seg[1] === 'settings' && seg[2] === 'assignee' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const raw = body['assignee'];
      // null clears the house default and hands resolution back to the
      // environment, which is a genuinely different state from setting 'ai'.
      const next = raw === null ? null : String(raw);
      if (next !== null && next !== 'ai' && next !== 'human') {
        return json(res, 400, { error: "assignee must be 'ai', 'human', or null" });
      }
      store.setDefaultAssignee(next as never);
      void scheduler.tick().catch(() => {});
      return json(res, 200, {
        houseDefault: store.defaultAssignee(),
        effective: store.defaultAssignee() ?? envAssignee() ?? 'ai',
      });
    }

    if (seg[1] === 'agreement' && method === 'GET') {
      return json(res, 200, {
        enabled: shadowEnabled(),
        total: store.shadowCount(),
        criterion: { minSamples: MIN_SAMPLES, minAgreement: MIN_AGREEMENT, maxFalsePassRate: MAX_FALSE_PASS_RATE },
        rows: agreementReport(store),
      });
    }

    if (seg[1] === 'archive') {
      if (method === 'GET') {
        const q = url.searchParams.get('q');
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
        if (q) {
          const pool = store.archiveCandidates({
            playbook: url.searchParams.get('playbook'),
            role: url.searchParams.get('role'),
            limit: 2000,
          });
          const est = estimateFrom(pool, {
            text: q,
            playbook: url.searchParams.get('playbook'),
            role: url.searchParams.get('role'),
          }, limit);
          const byId = new Map(pool.map((r) => [r.taskId, r]));
          return json(res, 200, {
            records: est.basis.map((b) => byId.get(b.taskId)).filter(Boolean),
            estimate: est,
            total: store.archiveCount(),
          });
        }
        return json(res, 200, {
          records: store.listArchive(limit, Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)),
          total: store.archiveCount(),
        });
      }
      if (method === 'POST') {
        const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
        const days = body['days'] == null ? undefined : Number(body['days']);
        return json(res, 200, { archived: store.archiveClosed(days) });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (seg[1] === 'runners' && method === 'GET') {
      return json(res, 200, { runners: runnerIds() });
    }

    if (seg[1] === 'tasks') {
      const taskId = seg[2];

      if (!taskId && method === 'GET') return json(res, 200, { tasks: store.listTasks() });

      if (!taskId && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        // Shape only. Whether the ticket may carry these skills is addTask's
        // check, and its refusal is answered as a 400 by the catch in createServer.
        const skills = body['skills'] ?? null;
        if (skills !== null && !(Array.isArray(skills) && skills.every((s) => typeof s === 'string'))) {
          return json(res, 400, { error: 'skills must be a list of skill names' });
        }
        const task = store.addTask({
          title: String(body['title'] ?? ''),
          prompt: String(body['prompt'] ?? ''),
          kind: body['kind'] as never,
          repo: (body['repo'] as string) || null,
          runner: body['runner'] as never,
          sensitivity: body['sensitivity'] as never,
          agent: (body['agent'] as string) || null,
          priority: body['priority'] === undefined ? 0 : Number(body['priority']),
          budgetUsd: body['budgetUsd'] == null ? null : Number(body['budgetUsd']),
          testCmd: (body['testCmd'] as string) || null,
          role: (body['role'] as string) || null,
          playbook: (body['playbook'] as string) || null,
          points: body['points'] == null ? null : Number(body['points']),
          acceptance: (body['acceptance'] as string) || null,
          allowCore: body['allowCore'] === true,
          mergeOnApprove: body['mergeOnApprove'] === undefined ? undefined : Boolean(body['mergeOnApprove']),
          maxRepairs: body['maxRepairs'] === undefined ? undefined : Number(body['maxRepairs']),
          maxAttempts: body['maxAttempts'] === undefined ? undefined : Number(body['maxAttempts']),
          deps: Array.isArray(body['deps']) ? (body['deps'] as string[]) : [],
          assignee: (body['assignee'] as never) || null,
          skills: skills as string[] | null,
        });
        void scheduler.tick().catch(() => {});
        return json(res, 201, task);
      }

      if (taskId && method === 'GET' && !seg[3]) {
        const task = store.getTask(taskId);
        if (!task) return json(res, 404, { error: 'task not found' });
        return json(res, 200, {
          task,
          runs: store.runsForTask(taskId),
          // Dropped review issues are merged in even when later events pushed them out of the window.
          events: withDroppedIssues(store, taskId, store.eventsForTask(taskId, 800)),
          artifacts: store.artifactsForTask(taskId),
          verdicts: store.verdictsForTask(taskId),
          decisions: store.decisionsForTask(taskId),
          receipts: store.receiptsForTask(taskId),
          // A re-review that climbs writes a row per rung; this says when it is over.
          reverifying: scheduler.isReverifying(taskId),
        });
      }

      if (taskId && method === 'DELETE' && !seg[3]) {
        store.deleteTask(taskId);
        return json(res, 200, { ok: true });
      }

      if (taskId && method === 'POST' && seg[3]) {
        const action = seg[3];
        if (action === 'approve') {
          const { body, note, corrected, reviewSource } = await readDecisionBody(req);
          // Shared with the owner gate (gate.ts): decide, remember, merge,
          // register. One approve path, whoever is standing at it.
          let approved: Awaited<ReturnType<typeof applyApproval>>;
          try {
            approved = await applyApproval(store, taskId, {
              note,
              // What the person states for the record (`--corrected` / `--clean`, who verified): recorded, never acted on.
              corrected,
              reviewSource,
              selfRoot: scheduler.selfRoot,
              // `foreman approve --as-is <sha>`: a person lands a tree that is
              // not the reviewed one by naming it (merge.ts).
              source: 'human',
              acceptTree: typeof body['acceptTree'] === 'string' ? body['acceptTree'] : null,
            });
          } catch (err) {
            if (err instanceof ShuttingDownError) return json(res, 503, { error: err.message });
            throw err;
          }
          const { task, merge, registration, decision } = approved;
          void scheduler.tick().catch(() => {});
          return json(res, 200, { ...task, merge, registration, decision: decision ?? null });
        }
        if (action === 'reject') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          refuseCorrected(body, 'reject');
          const note = String(body['note'] ?? 'rejected by operator');
          const asked = Date.now();
          const rejected = applyRejection(store, taskId, note);
          return json(res, 200, { ...rejected, decision: justRecorded(store, taskId, 'reject', asked) });
        }
        if (action === 'reverify') {
          // Accepted, not awaited. A council reading a whole chapter takes
          // minutes, and undici abandons a request whose response takes longer
          // than its 300s header timeout — which the CLI then reported as a
          // dead daemon, on a daemon that was forty minutes into its uptime.
          // A long job does not belong inside one request/response.
          //
          // The synchronous refusals still happen here, so a caller learns
          // immediately that a task is not re-reviewable; only the review
          // itself moves to the background.
          const task = store.getTask(taskId);
          if (!task) return json(res, 404, { error: 'task not found' });
          if (task.status !== 'awaiting-approval') {
            return json(res, 409, { error: `task ${taskId} is ${task.status}; only work parked at the gate can be re-reviewed` });
          }
          if (scheduler.isReverifying(taskId)) {
            return json(res, 409, { error: `task ${taskId} is already being re-reviewed (an automatic re-check may be running)` });
          }
          const before = store.verdictsForTask(taskId).length;
          void scheduler.reverify(taskId)
            .then(() => scheduler.tick().catch(() => {}))
            .catch((err: Error) => store.record({ taskId, type: 'error', message: `re-review failed: ${err.message}` }));
          return json(res, 202, { started: true, verdictsBefore: before });
        }
        if (action === 'gate') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const to = body['gate'] === null ? null : String(body['gate']);
          try {
            return json(res, 200, store.setGate(taskId, to as never));
          } catch (err) {
            return json(res, 409, { error: (err as Error).message });
          }
        }
        if (action === 'assign') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const to = String(body['assignee'] ?? '');
          try {
            const task = store.reassign(taskId, to as never);
            void scheduler.tick().catch(() => {});
            return json(res, 200, task);
          } catch (err) {
            return json(res, 409, { error: (err as Error).message });
          }
        }
        if (action === 'unarchive') {
          if (!store.unarchive(taskId)) return json(res, 404, { error: 'task is not archived' });
          return json(res, 200, { ok: true });
        }
        if (action === 'cancel') {
          // Never refused over its note (readCancelNote): whatever came with it, the cancel goes ahead.
          const { note, problem } = await readCancelNote(req);
          const asked = Date.now();
          const canceled = store.cancel(taskId, note);
          return json(res, 200, {
            ...canceled,
            decision: justRecorded(store, taskId, 'cancel', asked),
            ...(problem ? { warning: `note not recorded: ${problem}` } : {}),
          });
        }
        if (action === 'retry') {
          const task = store.getTask(taskId);
          if (!task) return json(res, 404, { error: 'task not found' });
          if (!['failed', 'rejected', 'canceled'].includes(task.status)) {
            return json(res, 409, { error: `task is ${task.status}; only ended tasks can be retried` });
          }
          const { body, note } = await readDecisionBody(req);
          refuseCorrected(body, 'retry');
          // A list sets the ticket's skills, null or "default" clears them, no
          // key leaves them. Before the requeue: a refused list throws here
          // (a 400 from the catch in createServer) with the ticket as it was.
          if ('skills' in body) {
            const skills = body['skills'] === 'default' ? null : body['skills'];
            if (skills !== null && !(Array.isArray(skills) && skills.every((s) => typeof s === 'string'))) {
              return json(res, 400, { error: 'skills must be a list of skill names, or "default"' });
            }
            setTicketSkills(store, taskId, skills);
          }
          const asked = Date.now();
          const retried = store.retry(taskId, note, 'skills' in body ? { skills: body['skills'] === 'default' ? null : body['skills'] } : null);
          void scheduler.tick().catch(() => {});
          return json(res, 200, { ...retried, decision: justRecorded(store, taskId, 'retry', asked) });
        }
        if (action === 'reopen') {
          const { body, note } = await readDecisionBody(req);
          refuseCorrected(body, 'reopen');
          try {
            const asked = Date.now();
            const reopened = store.reopen(taskId, note);
            return json(res, 200, { ...reopened, decision: justRecorded(store, taskId, 'reopen', asked) });
          } catch (err) {
            return json(res, 409, { error: (err as Error).message });
          }
        }
        return json(res, 404, { error: `unknown action: ${action}` });
      }
    }

    // --- receipts ---------------------------------------------------------
    // The spend ledger, one request: what today (or the whole history) cost,
    // grouped by who charged and what for, plus the tail of the rows. The
    // board renders all four from this; nothing here re-derives spentToday().
    if (seg[1] === 'receipts' && method === 'GET' && !seg[2]) {
      const day: ReceiptWindow = url.searchParams.get('day') === 'all' ? 'all' : 'today';
      const limit = Number(url.searchParams.get('limit') ?? '50');
      return json(res, 200, {
        day,
        totals: store.receiptTotals(day),
        byProvider: store.receiptGroups('provider', day),
        byKind: store.receiptGroups('kind', day),
        recent: store.recentReceipts(Number.isFinite(limit) ? limit : 50, day),
        dailyCapUsd: scheduler.broker.dailyCap,
      });
    }

    // --- prose ------------------------------------------------------------
    // The same audit the scheduler runs at the test stage (auditWorker.ts),
    // on a directory the operator names. A worker thread with the module's own
    // 60s cap, so a pathological manuscript cannot wedge the daemon's loop.
    if (seg[1] === 'prose' && seg[2] === 'audit' && method === 'POST' && !seg[3]) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const dir = String(body['dir'] ?? '').trim();
      if (!dir) return json(res, 400, { error: 'dir is required' });
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dir);
      } catch {
        return json(res, 400, { error: `no such directory: ${dir}` });
      }
      if (!stat.isDirectory()) return json(res, 400, { error: `not a directory: ${dir}` });
      let report: ProseAuditResult;
      try {
        report = await auditDirAsync(dir, { timeoutMs: AUDIT_TIMEOUT_MS });
      } catch (err) {
        // A timeout or a dead worker is a failed request, not a clean book.
        return json(res, 400, { error: (err as Error).message });
      }
      return json(res, 200, {
        report,
        text: formatAuditReport(report),
        hasBans: auditHasBans(report),
      });
    }

    // --- memory ----------------------------------------------------------
    if (seg[1] === 'memory') {
      if (method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'global';
        const limit = Number(url.searchParams.get('limit') ?? '200');
        return json(res, 200, {
          scope,
          scopes: store.memoryScopes(),
          facts: store.recallFacts(scope, Number.isFinite(limit) && limit > 0 ? Math.min(1000, limit) : 200),
        });
      }
      if (method === 'POST' && !seg[2]) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const key = String(body['key'] ?? '').trim();
        const value = String(body['value'] ?? '').trim();
        if (!key || !value) return json(res, 400, { error: 'key and value are required' });
        return json(res, 201, store.rememberFact({
          scope: String(body['scope'] ?? 'global'),
          key,
          value,
          confidence: body['confidence'] === undefined ? undefined : Number(body['confidence']),
          source: 'operator',
        }));
      }
      if (method === 'DELETE' && seg[2]) {
        store.forgetFact(seg[2]);
        return json(res, 200, { ok: true });
      }
    }

    // --- schedules --------------------------------------------------------
    if (seg[1] === 'schedules') {
      if (method === 'GET') return json(res, 200, { schedules: store.listSchedules() });
      if (method === 'POST' && !seg[2]) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        return json(res, 201, store.addSchedule({
          title: String(body['title'] ?? ''),
          spec: String(body['spec'] ?? ''),
          template: body['template'] as never,
          ask: (body['ask'] as string) || null,
          repo: (body['repo'] as string) || null,
          action: body['action'] as never,
        }));
      }
      if (method === 'DELETE' && seg[2]) {
        store.deleteSchedule(seg[2]);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && seg[2] && seg[3] === 'toggle') {
        return json(res, 200, store.toggleSchedule(seg[2]));
      }
    }

    // --- doctor -----------------------------------------------------------
    if (seg[1] === 'doctor' && method === 'GET') {
      reloadSpecs();
      // One deadline for the whole endpoint: the CLI's request gives up at
      // 300s, and a swapping machine — the one doctor most needs to diagnose —
      // is exactly where every cold load is slow.
      const deadline = Date.now() + DOCTOR_DEADLINE_MS;
      const left = (): number => deadline - Date.now();
      await probeCloud().catch(() => null);
      const { chat, TruncatedReply } = await import('./models.ts');
      type Spec = ReturnType<typeof specs> extends Map<string, infer V> ? V : never;
      const skipped = (spec: Spec) => ({
        ...spec, ok: false, latencyMs: 0,
        error: 'not pinged — doctor ran out of time on slower models; re-run it, or check memory',
      });
      const ping = async (spec: Spec) => {
        if (left() < 20_000) return skipped(spec);
        const started = Date.now();
        try {
          await chat({
            alias: spec.alias, messages: [{ role: 'user', content: 'ping' }], sensitivity: 'S1', maxTokens: 1,
            timeoutMs: Math.min(DOCTOR_PING_TIMEOUT_MS, left() - 15_000),
          });
          return { ...spec, ok: true, latencyMs: Date.now() - started, error: null };
        } catch (err) {
          // One token was asked for, so a reply cut off at one token is the
          // model ANSWERING. The truncation guard exists so a cut-off verdict
          // never counts as a verdict; a liveness probe is not a verdict, and
          // reading it as one reported every working local model as DOWN.
          if (err instanceof TruncatedReply) return { ...spec, ok: true, latencyMs: Date.now() - started, error: null };
          return { ...spec, ok: false, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 200) };
        }
      };
      const all = [...specs().values()];
      const models: Awaited<ReturnType<typeof ping>>[] = [];
      // Local pings run one at a time: this machine holds one roster model at
      // once, so parallel loads only evict each other and time out.
      for (const spec of all.filter((s) => s.local)) models.push(await ping(spec));
      // Only the Claude CLI's aliases share its sign-in; a gateway or an
      // OpenAI-compatible models.json entry is pinged on its own merits. All
      // remote pings run together — they do not compete for local memory.
      const reason = cloudDown();
      const remote = all.filter((s) => !s.local);
      models.push(...await Promise.all(remote.map((spec) =>
        spec.provider === 'claude-cli' && reason
          ? Promise.resolve({ ...spec, ok: false, latencyMs: 0, error: reason })
          : ping(spec))));
      // Unregistered while the fallback holds — still named, so the operator
      // sees what is missing rather than a shorter list.
      if (cloudFallback()) {
        for (const spec of claudeSpecs()) {
          if (!models.some((m) => m.alias === spec.alias)) models.push({ ...spec, ok: false, latencyMs: 0, error: reason });
        }
      }
      // Memory is judged against the largest local model, the one a full
      // ladder will eventually have to load.
      const sizes = await Promise.all(all.filter((s) => s.provider === 'ollama').map((s) => modelSizeGb(s.model)));
      const largest = Math.max(0, ...sizes.filter((n): n is number => n !== null));
      const runners = await Promise.all(
        runnerIds().map(async (id) => {
          const reason = await getRunner(id).preflight(probeTask({ prompt: 'probe', runner: id }));
          return { id, ok: reason === null, reason };
        }),
      );
      const catalog = loadCatalog();
      // The cutover readiness block. `doctor` is what the operator runs before
      // flipping FOREMAN_LOCAL_ONLY on, so it has to answer the two questions
      // that decide whether the flip works: are the tiers pointing at local
      // models, and is every adopted persona actually being served (an adopted
      // persona is already routed live work, so a dead server is a refusal
      // waiting to happen — see align/personaHealth.ts).
      const personas = await Promise.all(
        adoptedPersonas().map(async (p) => ({
          id: p.id,
          alias: p.alias,
          base: p.base,
          url: personaServerUrl(p.id),
          serving: await personaReachable(p),
        })),
      );
      return json(res, 200, {
        localOnly: localOnly(),
        mode: modeSummary(),
        memory: memoryWarning(await readMemory(), largest || undefined),
        tiers: {
          owner: tierModel('owner'),
          senior: tierModel('senior'),
          worker: tierModel('worker'),
        },
        personas,
        bench: readBench(),
        models,
        runners,
        agents: catalog.agents.map((a) => ({ id: a.id, description: a.description, model: a.model ?? null, findings: a.findings })),
        refusedAgents: catalog.refused,
        budget: { spentToday: store.spentToday(), dailyCapUsd: scheduler.broker.dailyCap },
        home: config.home,
        workers: {
          max: scheduler.workers,
          active: scheduler.activeCount,
          verifying: scheduler.verifyingCount,
          verifyLane: scheduler.verifyLaneSize,
        },
      });
    }

    if (seg[1] === 'agents' && method === 'GET') return json(res, 200, loadCatalog());

    // Read-only, zero-token: the same rows `foreman crew report` renders.
    if (seg[1] === 'crew' && seg[2] === 'report' && method === 'GET' && !seg[3]) {
      const rows = store.crewReport();
      return json(res, 200, { rows, advisories: crewAdvisories(rows) });
    }

    // --- playbooks + the forge --------------------------------------------
    if (seg[1] === 'playbooks') {
      if (method === 'GET' && !seg[2]) {
        const catalog = loadPlaybooks();
        // Tools a playbook asks for that nobody has built. A standing request,
        // surfaced where it can be acted on rather than left in a file.
        return json(res, 200, {
          ...catalog,
          missingTools: catalog.playbooks.flatMap((p) => missingTools(p)),
        });
      }
      if (method === 'GET' && seg[2] === 'pending' && !seg[3]) return json(res, 200, listPending());
      if (method === 'POST' && seg[2] === 'forge' && !seg[3]) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const domain = String(body['domain'] ?? '').trim();
        if (!domain) return json(res, 400, { error: 'domain is required' });
        try {
          const forged = await forgePlaybook({ domain, ask: (body['ask'] as string) || undefined, store });
          // 201, but nothing is installed: the draft parked in pending/ and
          // only a human calling /approve can move it into the catalog.
          return json(res, 201, forged);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      // Approve/reject mirror the tool-approval routes: localhost-only like the
      // rest of the API, no other authentication, one explicit human action.
      if (method === 'POST' && seg[2] && (seg[3] === 'approve' || seg[3] === 'reject')) {
        try {
          return json(
            res,
            200,
            seg[3] === 'approve' ? { installed: approvePending(seg[2]) } : { ok: true, ...rejectPending(seg[2]) },
          );
        } catch (err) {
          return json(res, 404, { error: (err as Error).message });
        }
      }
    }

    // --- improve ----------------------------------------------------------
    if (seg[1] === 'improve' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const evidence = gatherEvidence(store);
      const proposal = await proposeImprovement(scheduler.broker, evidence, {
        area: (body['area'] as string) || null,
      });
      if (body['confirm'] !== true) return json(res, 200, { proposal, evidence, queued: null });
      const task = queueImprovement(store, proposal, {
        allowCore: body['allowCore'] === true,
        budgetUsd: body['budgetUsd'] == null ? undefined : Number(body['budgetUsd']),
        runner: body['runner'] as never,
      });
      void scheduler.tick().catch(() => {});
      return json(res, 201, { proposal, queued: task });
    }

    // --- ask -------------------------------------------------------------
    if (seg[1] === 'ask' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const ask = String(body['ask'] ?? '').trim();
      if (!ask) return json(res, 400, { error: 'ask is required' });

      // A plan supplied by the caller is one we already showed them.
      const plan = (body['plan'] as Plan | undefined) ?? await planAsk({
        ask,
        store,
        broker: scheduler.broker,
        repo: (body['repo'] as string) || null,
        sensitivity: body['sensitivity'] as never,
        runner: body['runner'] as never,
      });

      if (body['confirm'] !== true) return json(res, 200, { plan, queued: [] });
      const queued = queuePlan(store, plan, {
        sensitivity: (body['sensitivity'] as never) ?? 'S1',
        budgetUsd: body['budgetUsd'] == null ? null : Number(body['budgetUsd']),
        priority: body['priority'] === undefined ? 0 : Number(body['priority']),
      });
      void scheduler.tick().catch(() => {});
      return json(res, 201, { plan: queued.plan, queued: queued.tasks });
    }

    // --- build (crew epic) -------------------------------------------------
    // Same contract as /api/ask — {plan, queued} — plus the epic container the
    // queued tickets hang off. `auto` is build's spelling of ask's `confirm`.
    if (seg[1] === 'build' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const fromEpic = (body['fromEpic'] as string) || null;
      const ask = String(body['ask'] ?? '').trim();
      if (!ask && !fromEpic) return json(res, 400, { error: 'ask (or fromEpic) is required' });

      const rawSensitivity = body['sensitivity'] == null ? 'S1' : String(body['sensitivity']);
      if (rawSensitivity !== 'S0' && rawSensitivity !== 'S1' && rawSensitivity !== 'S2') {
        return json(res, 400, { error: `unknown sensitivity: ${rawSensitivity}` });
      }
      const sensitivity: Sensitivity = rawSensitivity;

      // Opt-in autonomy is per epic and explicit: anything but 'owner' leaves
      // the tickets on the default resolution (playbook, then FOREMAN_GATE).
      const rawGate = body['gate'] == null ? null : String(body['gate']);
      if (rawGate !== null && rawGate !== 'human' && rawGate !== 'owner') {
        return json(res, 400, { error: `unknown gate: ${rawGate}` });
      }
      const gate: GateMode | null = rawGate;

      const usedFromEpic = body['plan'] === undefined && Boolean(fromEpic);
      let plan: CrewPlan;
      try {
        plan = body['plan'] !== undefined
          // A plan from the wire is not a plan this process produced: rebuild
          // every field before it can become task rows.
          ? parseCrewPlan(body['plan'])
          : fromEpic
            ? cloneEpic(store, fromEpic, { repo: (body['repo'] as string) || undefined })
            : await crewPlan({
              ask,
              store,
              repo: (body['repo'] as string) || null,
              playbook: (body['playbook'] as string) || null,
              parentId: (body['parentId'] as string) || null,
              sensitivity,
            });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }

      // Only --auto escalates warnings to blockers; the board's Queue button
      // sends `confirm` after a person has already seen the warnings.
      const auto = body['auto'] === true;
      const confirm = auto || body['confirm'] === true;
      // `revise` asks for one corrective round when the critic calls the plan
      // risky — which needs the critic, so it implies a check.
      const revise = body['revise'] === true && body['plan'] === undefined && !usedFromEpic;
      if (auto) escalateForAuto(plan.findings);
      let blocking = plan.findings.filter((f) => f.level === 'error');
      let willRefuse = confirm && blocking.length > 0;

      // Layer B (senior critique) is the only part of plan checking that costs
      // a token, so it runs only when it is likely to earn its keep: an
      // explicit ask, a plan big enough that coordination risk is real, or a
      // plan Layer A already flagged as broken. Skipped outright when the plan
      // is about to be refused anyway (no point critiquing what is not going
      // to run) and when --from-epic supplied it — that is the zero-planning-
      // token path and a critique call would quietly
      // reintroduce the cost it exists to avoid.
      const checkFlag = body['check'];
      const noCheck = checkFlag === false && !revise;
      const explicitCheck = checkFlag === true || revise;
      let critique: PlanCritique | null = null;
      // `empty-plan` is the only error-level finding, so an error-triggered
      // critique of a zero-ticket plan would spend a senior call on nothing —
      // require tickets to exist before any critique fires.
      if (!usedFromEpic && !noCheck && !willRefuse && plan.tickets.length > 0) {
        const hasErrors = blocking.length > 0;
        if (explicitCheck || plan.tickets.length >= 5 || hasErrors) {
          const pb = plan.playbook ? getPlaybook(plan.playbook) : null;
          if (pb) {
            critique = await critiquePlan(plan, pb, {
              store, taskId: (body['parentId'] as string) || null,
              // A plan preview is interactive; never let the critique hold the
              // response for ownerCall's full 180s default.
              timeoutMs: 60_000,
            });
          }
        }
      }

      // One revision round, never more: a second risky verdict is reported,
      // not chased — each round is a full owner plan plus a senior call.
      let revision: { notes: string[]; applied: boolean; reason?: string } | null = null;
      if (revise && critique?.verdict === 'risky' && critique.notes.length && !plan.degraded) {
        const revised = await crewPlan({
          ask,
          store,
          repo: (body['repo'] as string) || null,
          playbook: plan.playbook || null,
          parentId: (body['parentId'] as string) || null,
          sensitivity,
          revise: { previous: plan, notes: critique.notes },
        }).catch((err: Error) => err);
        if (revised instanceof Error || revised.degraded || revised.findings.some((f) => f.level === 'error')) {
          // The original plan stands; a failed revision must not replace a
          // usable plan with the single-ticket fallback.
          revision = {
            notes: critique.notes, applied: false,
            reason: revised instanceof Error ? revised.message : revised.notes,
          };
        } else {
          revision = { notes: critique.notes, applied: true };
          plan = revised;
          if (auto) escalateForAuto(plan.findings);
          blocking = plan.findings.filter((f) => f.level === 'error');
          willRefuse = confirm && blocking.length > 0;
          const pb = plan.playbook ? getPlaybook(plan.playbook) : null;
          critique = pb && !willRefuse
            ? await critiquePlan(plan, pb, { store, taskId: (body['parentId'] as string) || null, timeoutMs: 60_000 })
            : null;
        }
      }

      if (willRefuse) {
        return json(res, 422, {
          error: `plan has ${blocking.length} blocking finding(s) (${blocking.map((f) => f.code).join(', ')}) — rerun without --auto to override interactively`,
          plan, findings: plan.findings, critique: null, revision,
        });
      }
      if (!confirm) return json(res, 200, { plan, findings: plan.findings, critique, revision, epic: null, queued: [] });
      let queued: QueuedEpic;
      try {
        queued = queueCrewPlan(store, plan, {
          sensitivity,
          budgetUsd: body['budgetUsd'] == null ? null : Number(body['budgetUsd']),
          priority: body['priority'] === undefined ? 0 : Number(body['priority']),
          runner: body['runner'] as never,
          parentId: (body['parentId'] as string) || null,
          gate,
        });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      void scheduler.tick().catch(() => {});
      return json(res, 201, { plan, findings: plan.findings, critique, revision, epic: queued.epic, queued: queued.tickets });
    }

    if (seg[1] === 'memory' && seg[2] === 'consolidate' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      return json(res, 200, await consolidate(store, scheduler.broker, String(body['scope'] ?? 'global')));
    }

    // --- tools -----------------------------------------------------------
    if (seg[1] === 'tools') {
      if (method === 'GET' && !seg[2]) return json(res, 200, { tools: listTools(), dir: toolsDir() });
      if (method === 'GET' && seg[2]) {
        const tool = getTool(seg[2]);
        return tool ? json(res, 200, tool) : json(res, 404, { error: 'no such tool' });
      }
      if (method === 'DELETE' && seg[2]) {
        if (!getTool(seg[2])) return json(res, 404, { error: 'no such tool' });
        removeTool(seg[2]);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && seg[2] && (seg[3] === 'quarantine' || seg[3] === 'release')) {
        return json(res, 200, setQuarantine(seg[2], seg[3] === 'quarantine'));
      }
    }

    if (seg[1] === 'latency' && method === 'GET') {
      const n = Number(url.searchParams.get('n') ?? '20');
      const raw = store.recentRunsForLatency(Number.isFinite(n) && n > 0 ? Math.min(500, n) : 20);
      return json(res, 200, computeLatencyReport(raw));
    }

    if (seg[1] === 'bench' && method === 'GET') {
      const report = readBench();
      return report ? json(res, 200, report) : json(res, 404, { error: 'no bench yet — run: foreman doctor --bench' });
    }

    if (seg[1] === 'prune' && method === 'POST') {
      const rows = store.db
        .prepare(
          `SELECT t.id AS task_id, t.status AS status, t.repo AS repo, r.id AS run_id, r.branch AS branch, r.worktree_path AS worktree_path
             FROM runs r JOIN tasks t ON t.id = r.task_id
            WHERE r.branch IS NOT NULL`,
        )
        .all() as Record<string, unknown>[];
      // Which run of each task is its latest: for an approved task, that run's
      // branch is the approved work, and prune keeps it until it has landed.
      const latestRun = new Map<string, string | null>();
      const latestOf = (taskId: string): string | null => {
        if (!latestRun.has(taskId)) latestRun.set(taskId, store.latestRun(taskId)?.id ?? null);
        return latestRun.get(taskId)!;
      };
      const result = await pruneJails(
        rows.map((r) => ({
          status: String(r['status']) as never,
          repo: r['repo'] == null ? null : String(r['repo']),
          branch: r['branch'] == null ? null : String(r['branch']),
          worktreePath: r['worktree_path'] == null ? null : String(r['worktree_path']),
          latest: latestOf(String(r['task_id'])) === String(r['run_id']),
        })),
      );
      const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
      const days = body['olderThanDays'] === undefined ? 90 : Number(body['olderThanDays']);
      const ledgers = store.pruneLedgers(Number.isFinite(days) && days >= 0 ? days : 90);
      const depsDropped = pruneDepsCache(
        body['keepDepsCaches'] === undefined ? 5 : Number(body['keepDepsCaches']),
      );
      return json(res, 200, { ...result, ledgers, depsCachesDropped: depsDropped });
    }

    if (seg[1] === 'trace' && seg[2] && method === 'GET') return json(res, 200, traceTask(store, seg[2]));

    if (seg[1] === 'artifacts' && seg[2] && seg[3] === 'content' && method === 'GET') {
      // Only paths already recorded in the DB are readable — no client-supplied paths.
      const row = store.db.prepare('SELECT path, type FROM artifacts WHERE id = ?').get(seg[2]) as
        | Record<string, unknown>
        | undefined;
      if (!row) return json(res, 404, { error: 'artifact not found' });
      const filePath = String(row['path']);
      let text: string;
      try {
        const stat = fs.statSync(filePath);
        const cap = 512 * 1024;
        if (stat.size > cap) {
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(cap);
          fs.readSync(fd, buf, 0, cap, stat.size - cap);
          fs.closeSync(fd);
          text = `… truncated, showing last ${cap} bytes …\n${buf.toString('utf8')}`;
        } else {
          text = fs.readFileSync(filePath, 'utf8');
        }
      } catch (err) {
        return json(res, 410, { error: `artifact unreadable: ${(err as Error).message}` });
      }
      return json(res, 200, { id: seg[2], type: row['type'], path: filePath, content: text });
    }

    return json(res, 404, { error: 'not found' });
  }

  return server;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function listen(store: Store, scheduler: Scheduler): Promise<http.Server> {
  // The API can queue shell commands, so binding it to the network is an
  // explicit decision, never a default.
  if (!LOOPBACK.has(config.host) && process.env['FOREMAN_ALLOW_REMOTE'] !== '1') {
    throw new Error(
      `refusing to bind ${config.host}: the foreman API can run shell commands. ` +
        'Set FOREMAN_ALLOW_REMOTE=1 if you really mean to expose it.',
    );
  }
  const server = createServer(store, scheduler);
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`port ${config.port} is already in use — set FOREMAN_PORT to pick another`)
          : err,
      );
    });
    server.listen(config.port, config.host, () => resolve(server));
  });
}
