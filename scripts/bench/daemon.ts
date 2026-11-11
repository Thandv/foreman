// A throwaway daemon for a bench: `foreman serve` from a checkout, in a temp FOREMAN_HOME and on a free loopback port,
// with a clean environment, the OS sandbox off and the local model server pointed at a dead port (no model is called).
// Imported after ./env.ts, which removes everything it made when the bench exits.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { scratch } from './env.ts';
import { assertIsolated } from './isolation.ts';

export interface Daemon {
  name: string;
  home: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

export interface FeedEvent { id: number; taskId: string | null; type: string; message: string }

/** The daemon's live event stream (GET /api/events), read in the background from the moment it is opened. */
export interface Feed {
  events: FeedEvent[];
  /** The first event matching `pred`, waiting for it; throws after `ms`, or when the stream ended first. */
  waitFor(pred: (e: FeedEvent) => boolean, ms: number): Promise<FeedEvent>;
  close(): void;
}

const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Starts the daemon of `checkout`; `files` are written under its home first (mode 0600, as a secret needs), `env` is added to its environment. */
export async function startDaemon(
  name: string,
  checkout: string,
  opts: { files?: Record<string, string>; env?: Record<string, string> } = {},
): Promise<Daemon> {
  const home = scratch(`${name}-home`);
  const port = await freePort();
  assertIsolated(home, port);
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), text, { mode: 0o600 });
  }
  const log: string[] = [];
  const child = spawn(process.execPath, [path.join(checkout, 'src', 'cli.ts'), 'serve'], {
    cwd: checkout,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: scratch(`${name}-user`), FOREMAN_HOME: home, FOREMAN_PORT: String(port),
      FOREMAN_SANDBOX: 'off', FOREMAN_OLLAMA_URL: 'http://127.0.0.1:9', ...opts.env,
    },
  });
  running.add(child);
  const exited = new Promise<void>((r) => child.once('exit', () => { running.delete(child); r(); }));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d: Buffer) => log.push(d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${name} daemon exited at start: ${log.join('').slice(-500)}`);
    if (await fetch(`${url}/api/state`).then(() => true, () => false)) break;
    if (Date.now() > deadline) throw new Error(`${name} daemon did not answer in 30 s: ${log.join('').slice(-500)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    name, home, port, url,
    async stop() {
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(killer);
    },
  };
}

export async function openFeed(url: string): Promise<Feed> {
  const ctl = new AbortController();
  const events: FeedEvent[] = [];
  const wake = new Set<() => void>();
  let ended: string | null = null;
  const res = await fetch(`${url}/api/events`, { signal: ctl.signal });
  void (async () => {
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += Buffer.from(chunk).toString('utf8');
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice('data: '.length)) as FeedEvent);
        }
        for (const w of wake) w();
      }
      ended = 'the stream ended';
    } catch (err) {
      ended = ctl.signal.aborted ? 'the feed was closed' : (err as Error).message;
    }
    for (const w of wake) w();
  })();
  return {
    events,
    async waitFor(pred, ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (ended !== null) throw new Error(`event not seen: ${ended}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`event not seen in ${ms} ms`);
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); wake.delete(done); resolve(); };
          const timer = setTimeout(done, left);
          wake.add(done);
        });
      }
    },
    close: () => ctl.abort(),
  };
}
