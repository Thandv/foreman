// A local fake GitLab for tests and the demo: the REST v4 subset Foreman's merge-request landing uses, over node:http,
// backed by real bare git repos, with GitLab's field names and status codes. No network and no dependencies.
//   - importable: `startFakeGitlab({ projects: { 'group/app': '/path/to/bare.git' }, token })`
//   - runnable:   `node scripts/forge/fakeGitlab.ts --project group/app=/path/to/bare.git [--port N]
//                  [--checking-ms N] [--pipeline success|failed|manual] [--pipeline-delay-ms N]`, token in FAKE_GITLAB_TOKEN.
// A project id is the URL-encoded path ("group%2Fapp"), as GitLab accepts. Every request is recorded (method, path, query,
// body, never headers) in `requests`. A head sha gets one pipeline; POST /__fake/pipelines/:sha {status} flips it.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PipelinePolicy = 'success' | 'failed' | 'manual';
type PipelineStatus = 'running' | 'success' | 'failed' | 'canceled';
const PIPELINE_STATUSES: readonly string[] = ['running', 'success', 'failed', 'canceled'];

export interface FakeGitlabOptions {
  /** project path ("group/app") -> its bare repository. */
  projects: Record<string, string>;
  /** When set, every request must carry PRIVATE-TOKEN equal to it. It is never printed or logged. */
  token?: string;
  port?: number;
  /** How long detailed_merge_status reads 'checking' after a push or a pipeline change (default 0). */
  checkingMs?: number;
  /**
   * How long an open MR's `sha` keeps reading the old head after a push to its source branch (default 0). GitLab
   * refreshes an existing MR's head in a background job, so a read just after a push can still show the old commit.
   */
  refreshDelayMs?: number;
  /** New pipelines: 'success' after pipelineDelayMs, 'failed' at once, or 'manual' (left running). Default 'success'. */
  pipeline?: PipelinePolicy;
  pipelineDelayMs?: number;
  /** The project requires a passing pipeline to merge (default true). */
  requirePipeline?: boolean;
  /** The merge_method every project reports (default 'merge'); the merge itself is always --no-ff. */
  mergeMethod?: string;
  /** More project fields every project reports, as GitLab names them (squash_option, merge_trains_enabled, ...). */
  projectExtra?: Record<string, unknown>;
}

export interface FakeGitlab {
  url: string;
  /** `body` is the raw request body, when there was one. */
  requests: Array<{ method: string; path: string; query: Record<string, string>; body?: string }>;
  close(): Promise<void>;
}

interface Pipeline { id: number; sha: string; createdAt: number; status?: PipelineStatus }
interface MergeRequest {
  iid: number; source: string; target: string; title: string; description: string; squash: boolean; removeSource: boolean;
  state: 'opened' | 'merged'; sha: string; checkingUntil: number; mergeCommitSha: string | null;
  /** A head pushed but not yet taken into `sha` (refreshDelayMs), and when it was first seen. */
  seenHead?: string; seenAt?: number;
}
interface Project { id: number; path: string; bare: string; mrs: MergeRequest[] }

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=Fake GitLab', '-c', 'user.email=gitlab@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd });
  return stdout.trim();
}

const flag = (v: unknown): boolean => v === true || v === 'true';

export async function startFakeGitlab(opts: FakeGitlabOptions): Promise<FakeGitlab> {
  const checkingMs = opts.checkingMs ?? 0;
  const refreshDelayMs = opts.refreshDelayMs ?? 0;
  const policy = opts.pipeline ?? 'success';
  const pipelineDelayMs = opts.pipelineDelayMs ?? 0;
  const requirePipeline = opts.requirePipeline ?? true;
  const projects = new Map<string, Project>(Object.entries(opts.projects).map(([p, bare], i) => [p, { id: i + 1, path: p, bare, mrs: [] }]));
  const pipelines = new Map<string, Pipeline>();
  const requests: FakeGitlab['requests'] = [];
  let nextPipelineId = 1;
  let nextNoteId = 1;
  let url = '';
  // Merges rewrite a branch, so they run one at a time.
  let mergeChain: Promise<unknown> = Promise.resolve();

  const pipelineFor = (sha: string): Pipeline => {
    let p = pipelines.get(sha);
    if (!p) { p = { id: nextPipelineId++, sha, createdAt: Date.now() }; pipelines.set(sha, p); }
    return p;
  };
  const pipelineStatus = (p: Pipeline): PipelineStatus =>
    p.status ?? (policy === 'failed' ? 'failed' : policy === 'success' && Date.now() - p.createdAt >= pipelineDelayMs ? 'success' : 'running');

  /**
   * The source branch head, read live; a change since the last look is a push: a new pipeline and a 'checking' window,
   * taken into the MR's `sha` only refreshDelayMs after it was first seen.
   */
  const observe = async (project: Project, mr: MergeRequest): Promise<void> => {
    if (mr.state === 'merged') return;
    const head = await git(project.bare, 'rev-parse', `refs/heads/${mr.source}`);
    if (head !== mr.sha) {
      if (head !== mr.seenHead) { mr.seenHead = head; mr.seenAt = Date.now(); }
      if (Date.now() - mr.seenAt! >= refreshDelayMs) { mr.sha = head; mr.checkingUntil = Date.now() + checkingMs; }
    }
    pipelineFor(mr.sha);
  };
  const mergeStatus = (mr: MergeRequest): string => {
    if (mr.state === 'merged') return 'not_open';
    if (Date.now() < mr.checkingUntil) return 'checking';
    if (!requirePipeline) return 'mergeable';
    const status = pipelineStatus(pipelineFor(mr.sha));
    return status === 'success' ? 'mergeable' : status === 'running' ? 'ci_still_running' : 'ci_must_pass';
  };
  const view = (project: Project, mr: MergeRequest): Record<string, unknown> => {
    const pl = pipelineFor(mr.sha);
    return {
      iid: mr.iid, id: mr.iid, state: mr.state, title: mr.title, description: mr.description,
      source_branch: mr.source, target_branch: mr.target, sha: mr.sha, squash: mr.squash,
      source_project_id: project.id, target_project_id: project.id,
      web_url: `${url}/${project.path}/-/merge_requests/${mr.iid}`,
      detailed_merge_status: mergeStatus(mr),
      head_pipeline: { id: pl.id, sha: pl.sha, status: pipelineStatus(pl), web_url: `${url}/${project.path}/-/pipelines/${pl.id}` },
      merge_commit_sha: mr.mergeCommitSha,
    };
  };

  /** git merge --no-ff (or --squash) of the reviewed sha into the target, in a temp worktree of the bare repo. */
  const merge = async (project: Project, mr: MergeRequest): Promise<string> => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fakegitlab-'));
    try {
      await git(project.bare, 'worktree', 'add', '--detach', wt, `refs/heads/${mr.target}`);
      if (mr.squash) {
        await git(wt, 'merge', '--squash', mr.sha);
        await git(wt, 'commit', '-m', mr.title);
      } else {
        await git(wt, 'merge', '--no-ff', '-m', `Merge branch '${mr.source}' into '${mr.target}'`, mr.sha);
      }
      const merged = await git(wt, 'rev-parse', 'HEAD');
      await git(project.bare, 'update-ref', `refs/heads/${mr.target}`, merged);
      if (mr.removeSource) await git(project.bare, 'update-ref', '-d', `refs/heads/${mr.source}`);
      return merged;
    } catch (e) {
      throw new HttpError(406, `Branch cannot be merged: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      await git(project.bare, 'worktree', 'prune');
    }
  };

  const route = async (method: string, segs: string[], query: URLSearchParams, body: Record<string, unknown>): Promise<unknown> => {
    if (segs[0] === '__fake' && segs[1] === 'pipelines' && segs[2] && method === 'POST') {
      const status = String(body['status']);
      if (!PIPELINE_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${PIPELINE_STATUSES.join(', ')}`);
      pipelineFor(segs[2]).status = status as PipelineStatus;
      for (const p of projects.values()) for (const mr of p.mrs) if (mr.sha === segs[2]) mr.checkingUntil = Date.now() + checkingMs;
      return { sha: segs[2], status };
    }
    if (segs[0] !== 'api' || segs[1] !== 'v4' || segs[2] !== 'projects' || !segs[3]) throw new HttpError(404, '404 Not Found');
    const project = projects.get(decodeURIComponent(segs[3]));
    if (!project) throw new HttpError(404, '404 Project Not Found');
    const rest = segs.slice(4);
    if (rest.length === 0 && method === 'GET') {
      const head = await git(project.bare, 'symbolic-ref', '--short', 'HEAD');
      return { path_with_namespace: project.path, default_branch: head, merge_method: opts.mergeMethod ?? 'merge', squash_option: 'default_off', ...opts.projectExtra };
    }
    if (rest[0] !== 'merge_requests') throw new HttpError(404, '404 Not Found');
    if (rest.length === 1 && method === 'GET') {
      const mrs = project.mrs.filter((m) => (!query.has('source_branch') || m.source === query.get('source_branch'))
        && (!query.has('target_branch') || m.target === query.get('target_branch')) && (!query.has('state') || m.state === query.get('state')));
      for (const mr of mrs) await observe(project, mr);
      // GitLab's list returns MergeRequestBasic, which has no head_pipeline.
      return mrs.map((m) => ({ ...view(project, m), head_pipeline: undefined }));
    }
    if (rest.length === 1 && method === 'POST') {
      const source = String(body['source_branch']);
      const target = String(body['target_branch']);
      if (project.mrs.some((m) => m.state === 'opened' && m.source === source && m.target === target)) throw new HttpError(409, 'Another open merge request already exists for this source branch');
      const mr: MergeRequest = {
        iid: project.mrs.length + 1, source, target, title: String(body['title'] ?? source), description: String(body['description'] ?? ''),
        squash: flag(body['squash']), removeSource: flag(body['remove_source_branch']), state: 'opened', sha: '', checkingUntil: 0, mergeCommitSha: null,
      };
      try {
        await git(project.bare, 'rev-parse', '--verify', `refs/heads/${target}`);
        mr.sha = await git(project.bare, 'rev-parse', '--verify', `refs/heads/${source}`);
      } catch {
        throw new HttpError(400, 'source_branch or target_branch does not exist');
      }
      mr.checkingUntil = Date.now() + checkingMs;
      pipelineFor(mr.sha);
      project.mrs.push(mr);
      return view(project, mr);
    }
    const mr = project.mrs.find((m) => String(m.iid) === rest[1]);
    if (!mr) throw new HttpError(404, '404 Merge Request Not Found');
    if (rest.length === 2 && method === 'GET') {
      await observe(project, mr);
      return view(project, mr);
    }
    if (rest.length === 3 && rest[2] === 'notes' && method === 'POST') {
      const text = body['body'];
      if (typeof text !== 'string' || text === '') throw new HttpError(400, 'body is missing');
      return { id: nextNoteId++, body: text, noteable_type: 'MergeRequest', noteable_iid: mr.iid };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const run = async (): Promise<unknown> => {
        await observe(project, mr);
        if (mr.state !== 'opened') throw new HttpError(405, 'Method Not Allowed');
        if (query.has('sha') && query.get('sha') !== mr.sha) throw new HttpError(409, 'SHA does not match HEAD of source branch');
        if (mergeStatus(mr) !== 'mergeable') throw new HttpError(405, 'Method Not Allowed');
        mr.mergeCommitSha = await merge(project, mr);
        mr.state = 'merged';
        return view(project, mr);
      };
      const result = mergeChain.then(run, run);
      mergeChain = result.catch(() => undefined);
      return result;
    }
    throw new HttpError(404, '404 Not Found');
  };

  const server = http.createServer((req, res) => {
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    };
    const parsed = new URL(req.url ?? '/', 'http://fake.invalid');
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), ...(text ? { body: text } : {}) });
      if (opts.token !== undefined && req.headers['private-token'] !== opts.token) return reply(401, { message: '401 Unauthorized' });
      void (async () => {
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        reply(200, await route(method, parsed.pathname.split('/').filter(Boolean), parsed.searchParams, { ...Object.fromEntries(parsed.searchParams), ...body }));
      })().catch((e: unknown) => {
        if (e instanceof HttpError) return reply(e.status, { message: e.message });
        reply(e instanceof SyntaxError ? 400 : 500, { message: (e as Error).message });
      });
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(opts.port ?? 0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mergeChain;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      project: { type: 'string', multiple: true },
      port: { type: 'string' },
      'checking-ms': { type: 'string' },
      pipeline: { type: 'string' },
      'pipeline-delay-ms': { type: 'string' },
    },
  });
  const projects = Object.fromEntries((values.project ?? []).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (Object.keys(projects).length === 0) throw new Error('usage: fakeGitlab.ts --project group/app=/path/to/bare.git [--port N] [--checking-ms N] [--pipeline success|failed|manual] [--pipeline-delay-ms N]');
  const pipeline = values.pipeline ?? 'success';
  if (pipeline !== 'success' && pipeline !== 'failed' && pipeline !== 'manual') throw new Error(`--pipeline must be success, failed or manual, not ${pipeline}`);
  const token = process.env['FAKE_GITLAB_TOKEN'];
  const fake = await startFakeGitlab({
    projects, pipeline, ...(token ? { token } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values['checking-ms'] ? { checkingMs: Number(values['checking-ms']) } : {}),
    ...(values['pipeline-delay-ms'] ? { pipelineDelayMs: Number(values['pipeline-delay-ms']) } : {}),
  });
  console.log(`fake GitLab listening on ${fake.url}`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void fake.close().then(() => process.exit(0)));
}
