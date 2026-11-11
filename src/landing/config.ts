import fs from 'node:fs';
import path from 'node:path';
import { ForgeError, type Forge, type ForgeProject } from './forge.ts';
import { forgeUrl, GitlabForge } from './gitlab.ts';
import { ForgeMirror } from './push.ts';
import { readForgeToken } from '../security/forgeToken.ts';

/**
 * Where each repo lands by merge request: <FOREMAN_HOME>/landing.json maps a resolved repo path to
 * {mode: 'mr', forge: 'gitlab', baseUrl, project, pushUrl, targetBranch, requirePipeline}. It counts only with
 * FOREMAN_LANDING=mr as well, so a stray file changes nothing; a repo not in it lands as today. The file is read and
 * validated once, at start: anything unexpected is a LandingConfigError naming the repo and the field. The GitLab
 * token (src/security/forgeToken.ts) is read with it and held here; callers see only whether it is set.
 */

export interface LandingMapping {
  /** The repo path, absolute and resolved. */
  repo: string;
  mode: 'mr';
  forge: 'gitlab';
  /** The GitLab root the API is called on. */
  baseUrl: string;
  /** GitLab's project path, "group/app". */
  project: string;
  /** Where the reviewed commit is pushed: an http(s) URL, or an absolute local path (a bare repo, as the fake uses). */
  pushUrl: string;
  targetBranch: string;
  requirePipeline: boolean;
}

export class LandingConfigError extends Error {
  override readonly name = 'LandingConfigError';
}

const FIELDS = ['mode', 'forge', 'baseUrl', 'project', 'pushUrl', 'targetBranch', 'requirePipeline'] as const;
const PROJECT = /^[\w.-]+(?:\/[\w.-]+)+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/;

export function landingFile(home: string): string {
  return path.join(home, 'landing.json');
}

function mapping(file: string, repo: string, v: unknown): LandingMapping {
  const bad = (why: string): LandingConfigError => new LandingConfigError(`${file}: ${repo}: ${why}`);
  if (!path.isAbsolute(repo) || path.resolve(repo) !== repo) throw bad('the repo must be an absolute, resolved path');
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad('the mapping must be an object');
  const o = v as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw bad(`unknown key ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
  const missing = FIELDS.filter((k) => o[k] === undefined);
  if (missing.length) throw bad(`missing ${missing.join(', ')}`);
  const str = (k: (typeof FIELDS)[number]): string => {
    const s = o[k];
    if (typeof s !== 'string' || s === '') throw bad(`${k} must be a non-empty string`);
    return s;
  };
  if (o['mode'] !== 'mr') throw bad(`mode must be "mr", not ${JSON.stringify(o['mode'])}`);
  if (o['forge'] !== 'gitlab') throw bad(`forge must be "gitlab", not ${JSON.stringify(o['forge'])}`);
  const url = (k: 'baseUrl' | 'pushUrl'): string => {
    try {
      forgeUrl(str(k), k);
      return str(k);
    } catch (err) {
      if (err instanceof ForgeError) throw bad(err.message);
      throw err;
    }
  };
  const pushUrl = path.isAbsolute(str('pushUrl')) ? str('pushUrl') : url('pushUrl');
  if (!PROJECT.test(str('project'))) throw bad('project must be a GitLab path like "group/app"');
  if (!BRANCH.test(str('targetBranch'))) throw bad('targetBranch is not a branch name');
  if (typeof o['requirePipeline'] !== 'boolean') throw bad('requirePipeline must be true or false');
  return {
    repo, mode: 'mr', forge: 'gitlab', baseUrl: url('baseUrl'), project: str('project'), pushUrl,
    targetBranch: str('targetBranch'), requirePipeline: o['requirePipeline'],
  };
}

/** The validated mappings and the GitLab token, which only `forge()` and `mirror()` hand on. */
export class Landing {
  readonly mappings: readonly LandingMapping[];
  readonly #token: string | null;

  constructor(mappings: LandingMapping[], token: string | null) {
    this.mappings = mappings;
    this.#token = token;
  }

  get tokenSet(): boolean {
    return this.#token !== null;
  }

  /** The forge a mapping lands through, carrying the token. */
  forge(m: LandingMapping): Forge {
    return new GitlabForge({ baseUrl: m.baseUrl, ...(this.#token === null ? {} : { token: this.#token }) });
  }

  /** The Foreman-owned mirror a mapping's commits cross to and from the forge through (./push.ts), carrying the token. */
  mirror(m: LandingMapping, home: string): ForgeMirror {
    return new ForgeMirror(home, m, this.#token);
  }

  /** What `foreman config --effective` and the start print: each mapping, and the token as set or unset. */
  describe(home: string): string[] {
    return [
      `landing: FOREMAN_LANDING=mr, ${this.mappings.length} repo(s) from ${landingFile(home)}`,
      ...this.mappings.map((m) =>
        `  ${m.repo}  ${m.forge} ${m.project} at ${m.baseUrl}  push ${m.pushUrl}  target ${m.targetBranch}  pipeline ${m.requirePipeline ? 'required' : 'not required'}`),
      `  token: ${this.tokenSet ? 'set' : 'unset'}`,
    ];
  }
}

/**
 * The landing configuration, or null when merge-request landing is off: FOREMAN_LANDING is not `mr`, or there is no
 * landing.json. A file that is not valid, or a token file that is refused, throws.
 */
export function loadLanding(home: string, mode: 'merge' | 'mr'): Landing | null {
  if (mode !== 'mr') return null;
  const file = landingFile(home);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LandingConfigError(`${file}: not JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LandingConfigError(`${file}: must be an object mapping repo paths to their landing`);
  }
  const mappings = Object.entries(parsed).map(([repo, v]) => mapping(file, repo, v));
  return new Landing(mappings, readForgeToken(home));
}

/**
 * Why MR landing cannot work in a project with these settings, or null. A landing is confirmed by a merge commit whose
 * second parent is the reviewed commit, so merge_method must be `merge` and squash must not be required (GitLab's
 * squash_option `always`; the others leave it to the MR, which Foreman opens without squash). The pipeline gate reads
 * the pipeline of the source branch head, so merged results pipelines and merge trains are not supported.
 */
export function projectRefusal(p: ForgeProject): string | null {
  if (p.mergeMethod !== 'merge') return `merge_method ${p.mergeMethod}; MR landing needs merge`;
  if (p.squashOption === 'always') return 'squash_option always; MR landing needs a merge commit, so squash must not be required';
  if (p.mergePipelines) return 'merged results pipelines are on; MR landing does not support them';
  if (p.mergeTrains) return 'merge trains are on; MR landing does not support them';
  return null;
}

/**
 * `foreman doctor`'s landing lines: each mapping's project as the forge reports it, checked by projectRefusal. A forge
 * that cannot be asked is a FAIL line, not a throw.
 */
export async function landingDoctorLines(landing: Landing): Promise<string[]> {
  const lines: string[] = [];
  for (const m of landing.mappings) {
    const head = `landing ${m.repo} (${m.project})`;
    try {
      const p = await landing.forge(m).project(m.project);
      const refused = projectRefusal(p);
      lines.push(refused === null
        ? `${head}: ok  merge_method merge, default branch ${p.defaultBranch}, target ${m.targetBranch}`
        : `${head}: FAIL ${refused}`);
    } catch (err) {
      if (!(err instanceof ForgeError)) throw err;
      lines.push(`${head}: FAIL ${err.message}`);
    }
  }
  return lines;
}
