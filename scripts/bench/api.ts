// What the scripts that drive a throwaway daemon through its HTTP API share (identity.ts, scripts/demo/mr-landing.ts):
// a call, the first mint, a repo with its forge, and a ticket that parks at the gate. Imported after ./env.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scratch } from './env.ts';
import type { Daemon } from './daemon.ts';
import { ensureHostSecret, HOST_SECRET_HEADER } from '../../src/security/hostSecret.ts';

/** How long a ticket may take to reach a status before a script gives up. */
const WAIT_MS = 60_000;

export async function call(d: Daemon, method: string, urlPath: string, o: { body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${d.url}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** The first mint latches auth on. `d` is on this machine, so the host-admin secret is read from its home as the CLI does. */
export async function mint(d: Daemon, name: string): Promise<string> {
  const res = await call(d, 'POST', '/api/tokens', { body: { name }, headers: { [HOST_SECRET_HEADER]: ensureHostSecret(d.home) } });
  if (res.status !== 201) throw new Error(`mint ${name} on ${d.name}: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json['token'] as string;
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repo with a commit on main, and the forge's bare project that has the same main. */
export function forgeFixture(): { repo: string; bare: string } {
  const repo = scratch('repo');
  const bare = path.join(scratch('forge'), 'app.git');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'bench@example.invalid');
  git(repo, 'config', 'user.name', 'Bench');
  fs.writeFileSync(path.join(repo, 'README.md'), 'bench\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'base');
  git(path.dirname(bare), 'init', '-q', '--bare', '-b', 'main', bare);
  git(repo, 'push', '-q', bare, 'main:refs/heads/main');
  return { repo, bare };
}

/** A shell ticket by `token`'s principal that writes one file in `repo`; `extra` adds fields to the ticket (deps, testCmd). Its id. */
export async function submit(d: Daemon, token: string, repo: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await call(d, 'POST', '/api/tasks', { token, body: { title: `${name}'s change`, prompt: `printf 'x\\n' > ${name}.txt`, runner: 'shell', kind: 'code', repo, ...extra } });
  return made.json['id'] as string;
}

/** Waits until ticket `id` has status `want`; throws after a minute. */
export async function untilStatus(d: Daemon, token: string, id: string, want: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const tasks = (await call(d, 'GET', '/api/state', { token })).json['tasks'] as Array<{ id: string; status: string }>;
    const status = tasks.find((t) => t.id === id)?.status;
    if (status === want) return;
    if (Date.now() > deadline) throw new Error(`${id} did not reach ${want}: it is ${status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A ticket submitted as above, once it is parked at the gate. */
export async function parked(d: Daemon, token: string, repo: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await submit(d, token, repo, name, extra);
  await untilStatus(d, token, id, 'awaiting-approval');
  return id;
}
