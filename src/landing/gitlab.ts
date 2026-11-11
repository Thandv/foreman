import http from 'node:http';
import https from 'node:https';
import { ForgeError, type Forge, type ForgeProject, type MergeOutcome, type Mr, type MrPipeline, type MrState, type NewMr } from './forge.ts';

/**
 * The forge port over GitLab's REST v4 (merge requests), with node:https, or
 * node:http for a loopback GitLab such as the test fake. One request per call,
 * cut at the timeout (15 s by default), never retried: the caller polls.
 * Responses are capped at 1 MB and read field by field; anything unexpected is
 * a ForgeError, never a guess. The token goes only in the PRIVATE-TOKEN header
 * and is replaced by [redacted] in every error and detail text. Nothing here
 * decides landing policy.
 */

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MR_STATES: readonly string[] = ['opened', 'merged', 'closed', 'locked'] satisfies MrState[];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface GitlabForgeOptions {
  /** The GitLab root, e.g. https://gitlab.example.com (a path prefix is kept). http:// only for a loopback host. */
  baseUrl: string;
  /** Sent as PRIVATE-TOKEN when set. */
  token?: string;
  timeoutMs?: number;
}

type Obj = Record<string, unknown>;

const unexpected = (field: string, want: string): ForgeError => new ForgeError(`GitLab answered an unexpected ${field}: expected ${want}`);

function object(v: unknown, field: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw unexpected(field, 'an object');
  return v as Obj;
}

function text(o: Obj, key: string, of: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw unexpected(`${of}.${key}`, 'a non-empty string');
  return v;
}

function commit(o: Obj, key: string, of: string): string {
  const v = text(o, key, of);
  if (!SHA.test(v)) throw unexpected(`${of}.${key}`, 'a commit sha');
  return v;
}

function pipeline(v: unknown): MrPipeline | null {
  if (v === null) return null;
  const p = object(v, 'head_pipeline');
  return { sha: commit(p, 'sha', 'head_pipeline'), status: text(p, 'status', 'head_pipeline'), webUrl: text(p, 'web_url', 'head_pipeline') };
}

function bool(o: Obj, key: string, of: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw unexpected(`${of}.${key}`, 'true or false');
  return v;
}

function projectId(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw unexpected(`merge request.${key}`, 'a positive integer');
  return v;
}

function readIid(o: Obj): number {
  const iid = o['iid'];
  if (typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid < 1) throw unexpected('merge request.iid', 'a positive integer');
  return iid;
}

function readMr(v: unknown): Mr {
  const o = object(v, 'merge request');
  const iid = readIid(o);
  const state = text(o, 'state', 'merge request');
  if (!MR_STATES.includes(state)) throw unexpected('merge request.state', MR_STATES.join(', '));
  return {
    iid,
    state: state as MrState,
    headSha: commit(o, 'sha', 'merge request'),
    targetBranch: text(o, 'target_branch', 'merge request'),
    squash: bool(o, 'squash', 'merge request'),
    sourceProjectId: projectId(o, 'source_project_id'),
    targetProjectId: projectId(o, 'target_project_id'),
    mergeStatus: text(o, 'detailed_merge_status', 'merge request'),
    pipeline: pipeline(o['head_pipeline']),
    mergeCommitSha: o['merge_commit_sha'] === null ? null : commit(o, 'merge_commit_sha', 'merge request'),
    webUrl: text(o, 'web_url', 'merge request'),
  };
}

function checkIid(iid: number): void {
  if (!Number.isSafeInteger(iid) || iid < 1) throw new ForgeError(`merge request iid must be a positive integer, not ${iid}`);
}

/**
 * `raw` as a URL a token may be sent to: https://, or http:// on a loopback host (the fake, a local GitLab), with no
 * credentials, query or fragment. `what` names it in the error.
 */
export function forgeUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ForgeError(`${what} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new ForgeError(`${what} must be https://, or http:// on a loopback host`);
  }
  if (url.username || url.password || url.search || url.hash) throw new ForgeError(`${what} must not carry credentials, a query or a fragment`);
  return url;
}

export class GitlabForge implements Forge {
  readonly #root: string;
  readonly #https: boolean;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  constructor(opts: GitlabForgeOptions) {
    const url = forgeUrl(opts.baseUrl, 'GitLab baseUrl');
    if (opts.token === '') throw new ForgeError('GitLab token is empty');
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ForgeError('GitLab timeoutMs must be a positive integer');
    this.#root = `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v4/projects/`;
    this.#https = url.protocol === 'https:';
    this.#token = opts.token;
    this.#timeoutMs = timeoutMs;
  }

  async project(projectRef: string): Promise<ForgeProject> {
    const o = object(await this.#ok('GET', projectRef, ''), 'project');
    return { defaultBranch: text(o, 'default_branch', 'project'), mergeMethod: text(o, 'merge_method', 'project') };
  }

  async findOpenMr(projectRef: string, sourceBranch: string, targetBranch: string): Promise<Mr | null> {
    const query = new URLSearchParams({ source_branch: sourceBranch, target_branch: targetBranch, state: 'opened' });
    const list = await this.#ok('GET', projectRef, `/merge_requests?${query}`);
    if (!Array.isArray(list)) throw unexpected('merge request list', 'an array');
    // The list includes MRs from forks with the same branch name: only the project's own branch is Foreman's.
    const own = list.map((e) => object(e, 'merge request')).filter((o) => projectId(o, 'source_project_id') === projectId(o, 'target_project_id'));
    if (own.length > 1) throw new ForgeError(`GitLab lists ${own.length} open merge requests from ${sourceBranch} into ${targetBranch}; expected at most one`);
    // A list entry is GitLab's MergeRequestBasic (no head_pipeline): take its iid and read the full MR.
    return own.length === 0 ? null : this.getMr(projectRef, readIid(own[0]!));
  }

  async openMr(projectRef: string, mr: NewMr): Promise<Mr> {
    return readMr(await this.#ok('POST', projectRef, '/merge_requests', {
      source_branch: mr.sourceBranch,
      target_branch: mr.targetBranch,
      title: mr.title,
      description: mr.description,
      remove_source_branch: true,
      squash: false,
    }));
  }

  async getMr(projectRef: string, iid: number): Promise<Mr> {
    checkIid(iid);
    return readMr(await this.#ok('GET', projectRef, `/merge_requests/${iid}`));
  }

  async merge(projectRef: string, iid: number, sha: string): Promise<MergeOutcome> {
    checkIid(iid);
    if (!SHA.test(sha)) throw new ForgeError('merge needs a full commit sha');
    const path = `/merge_requests/${iid}/merge?${new URLSearchParams({ sha })}`;
    const reply = await this.#request('PUT', projectRef, path);
    const detail = (): string => this.#redact(this.#message(reply));
    if (reply.status === 409) return { merged: false, reason: 'head-moved', detail: detail() };
    if (reply.status === 405 || reply.status === 406 || reply.status === 422) return { merged: false, reason: 'not-mergeable', detail: detail() };
    // 401 is GitLab's answer when the caller may not merge into the target branch (merge_requests.rb `unauthorized!`).
    if (reply.status === 401 || reply.status === 403) return { merged: false, reason: 'refused', detail: detail() };
    const merged = readMr(this.#json('PUT', path, reply));
    if (merged.state !== 'merged' || merged.mergeCommitSha === null) throw new ForgeError(`GitLab answered the merge of !${iid} with state ${merged.state} and no merge commit`);
    return { merged: true, mergeCommitSha: merged.mergeCommitSha };
  }

  async addNote(projectRef: string, iid: number, body: string): Promise<void> {
    checkIid(iid);
    const note = object(await this.#ok('POST', projectRef, `/merge_requests/${iid}/notes`, { body }), 'note');
    if (typeof note['id'] !== 'number') throw unexpected('note.id', 'a number');
  }

  /** A 2xx reply's JSON, or a ForgeError naming the status and GitLab's message. */
  async #ok(method: 'GET' | 'POST', projectRef: string, path: string, body?: Obj): Promise<unknown> {
    return this.#json(method, path, await this.#request(method, projectRef, path, body));
  }

  #json(method: string, path: string, reply: { status: number; body: string }): unknown {
    if (reply.status < 200 || reply.status >= 300) throw this.#error(`${method} ${path}: ${reply.status} ${this.#message(reply)}`, reply.status);
    try {
      return JSON.parse(reply.body);
    } catch {
      throw this.#error(`${method} ${path}: ${reply.status} with a body that is not JSON`, reply.status);
    }
  }

  /** GitLab's `message` (or `error`), else the start of the body. */
  #message(reply: { body: string }): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.body);
    } catch {
      return reply.body.slice(0, 200);
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const m = (parsed as Obj)['message'] ?? (parsed as Obj)['error'];
      if (m !== undefined) return typeof m === 'string' ? m : JSON.stringify(m);
    }
    return reply.body.slice(0, 200);
  }

  #redact(s: string): string {
    return this.#token === undefined ? s : s.split(this.#token).join('[redacted]');
  }

  #error(message: string, status: number | null = null): ForgeError {
    return new ForgeError(this.#redact(`GitLab ${message}`), status);
  }

  #request(method: 'GET' | 'POST' | 'PUT', projectRef: string, path: string, body?: Obj): Promise<{ status: number; body: string }> {
    if (projectRef === '') return Promise.reject(new ForgeError('GitLab project path is empty'));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#token !== undefined) headers['private-token'] = this.#token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const where = `${method} ${path}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string, status: number | null = null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(this.#error(`${where}: ${why}`, status));
      };
      const req = (this.#https ? https : http).request(`${this.#root}${encodeURIComponent(projectRef)}${path}`, { method, headers }, (res) => {
        const status = res.statusCode ?? 0;
        if (Number(res.headers['content-length']) > MAX_BODY_BYTES) return fail('response body is over 1 MB', status);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) fail('response body is over 1 MB', status);
          else chunks.push(c);
        });
        res.on('error', (e) => fail(e.message, status));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      const timer = setTimeout(() => fail(`no answer within ${this.#timeoutMs} ms`), this.#timeoutMs);
      req.on('error', (e: NodeJS.ErrnoException) => fail(e.code ?? e.message));
      req.end(payload);
    });
  }
}
