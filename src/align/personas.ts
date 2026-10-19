import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { admit, type Finding } from '../security/admit.ts';
import { probeTask } from '../types.ts';
import { alignDir } from './extract.ts';

/**
 * A persona is one local model trained for one job.
 *
 * The key is `<playbook>.<role>`, because that pair is already how Foreman
 * names a job: the publishing playbook's `author` writes chapters, its
 * `dev-editor` writes editorial letters, its `copyeditor` fixes commas. They
 * want different training data and they fail in different ways, so pooling
 * their examples into one adapter trains a model that is mediocre at all three.
 *
 * `general` is the catch-all key for work that belongs to no playbook role.
 */
export interface Persona {
  /** `<playbook>.<role>`, or `general`. */
  id: string;
  playbook: string | null;
  role: string | null;
  description: string;
  /** Hugging Face id or local path of the base model this persona fine-tunes. */
  base: string;
  /**
   * Prompt patterns that claim a history sample for this persona. Session
   * transcripts carry no role tag, so a persona says in its own manifest what
   * its work looks like — the same way a playbook declares its triggers.
   */
  triggers: string[];
  /** Training hyper-parameters. Deliberately small: this runs behind your work. */
  training: {
    iters: number;
    batchSize: number;
    loraLayers: number;
    learningRate: number;
    mode: 'sft' | 'dpo';
    /**
     * Token ceiling per training example. The single biggest lever on peak
     * memory — cost grows with sequence length, and on a 17 GB machine a long
     * context is the difference between training behind your work and swapping
     * the machine to a halt.
     */
    maxSeqLength: number;
    /** Trade compute for memory by recomputing activations in the backward pass. */
    gradCheckpoint: boolean;
  };
  /** How many NEW samples since the last adoption before retraining is worth it. */
  retrainAfter: number;
  status: 'draft' | 'candidate' | 'adopted' | 'retired';
  /** Set once an adapter has been adopted: the alias tasks route to. */
  alias: string | null;
  trainedAt: string | null;
  adoptedAt: string | null;
  /** Samples the last build wrote, so `retrainAfter` has something to compare to. */
  lastBuild: { sft: number; dpo: number; at: string } | null;
  source: string;
  findings: Finding[];
}

export interface PersonaCatalog {
  personas: Persona[];
  /** Manifests that failed to load or were refused, with the reason. */
  refused: Array<{ file: string; reason: string }>;
}

export function personasDir(): string {
  return process.env['FOREMAN_PERSONAS_DIR'] ?? path.join(config.home, 'personas');
}

/** Where a persona's datasets and adapter live. Everything is per-persona. */
export function personaDataDir(id: string): string {
  return path.join(alignDir(), 'personas', id, 'data');
}

export function personaAdapterDir(id: string): string {
  return path.join(alignDir(), 'personas', id, 'adapter');
}

/**
 * The port an adopted persona's own `mlx_lm.server` listens on.
 *
 * Derived from the id rather than assigned, so the port survives a restart and
 * two personas cannot be handed the same one by accident. The base is
 * configurable for the case where something else already owns that range.
 */
export function personaPort(id: string): number {
  const base = Number(process.env['FOREMAN_PERSONA_PORT_BASE'] ?? 4200);
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 200;
  return base + hash;
}

export function personaServerUrl(id: string): string {
  return process.env[`FOREMAN_PERSONA_URL_${id.replace(/\W/g, '_').toUpperCase()}`] ?? `http://127.0.0.1:${personaPort(id)}/v1`;
}

const DEFAULT_BASE = process.env['FOREMAN_PERSONA_BASE'] ?? 'mlx-community/Qwen2.5-7B-Instruct-4bit';

/**
 * Training defaults sized to run BEHIND the operator's work rather than
 * instead of it: a small adapter over few layers at batch size 1. A bigger
 * configuration trains a better adapter and makes the machine unusable while
 * it does, which is not a trade this system is allowed to make silently.
 */
const DEFAULT_TRAINING: Persona['training'] = {
  iters: 300,
  batchSize: 1,
  loraLayers: 8,
  learningRate: 1e-5,
  mode: 'sft',
  maxSeqLength: 1024,
  gradCheckpoint: true,
};

function parseManifest(text: string, file: string): { persona: Persona | null; reason?: string } {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return { persona: null, reason: 'no --- front-matter block' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fm[1]!) as Record<string, unknown>;
  } catch (err) {
    return { persona: null, reason: `front-matter is not JSON: ${(err as Error).message}` };
  }
  const id = String(raw['id'] ?? '').trim();
  if (!id) return { persona: null, reason: 'no id' };
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return { persona: null, reason: `id is not a safe filename: ${id}` };

  const training = (raw['training'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const lastBuild = raw['lastBuild'] as Record<string, unknown> | undefined;

  const persona: Persona = {
    id,
    playbook: typeof raw['playbook'] === 'string' ? raw['playbook'] : null,
    role: typeof raw['role'] === 'string' ? raw['role'] : null,
    description: String(raw['description'] ?? ''),
    base: String(raw['base'] ?? DEFAULT_BASE),
    triggers: Array.isArray(raw['triggers'])
      ? raw['triggers'].filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [],
    training: {
      iters: num(training['iters'], DEFAULT_TRAINING.iters),
      batchSize: num(training['batchSize'], DEFAULT_TRAINING.batchSize),
      loraLayers: num(training['loraLayers'], DEFAULT_TRAINING.loraLayers),
      learningRate: Number(training['learningRate']) || DEFAULT_TRAINING.learningRate,
      mode: training['mode'] === 'dpo' ? 'dpo' : 'sft',
      maxSeqLength: num(training['maxSeqLength'], DEFAULT_TRAINING.maxSeqLength),
      gradCheckpoint: training['gradCheckpoint'] !== false,
    },
    retrainAfter: num(raw['retrainAfter'], 200),
    status: (['draft', 'candidate', 'adopted', 'retired'] as const).find((s) => s === raw['status']) ?? 'draft',
    alias: typeof raw['alias'] === 'string' && raw['alias'].trim() ? raw['alias'].trim() : null,
    trainedAt: typeof raw['trainedAt'] === 'string' ? raw['trainedAt'] : null,
    adoptedAt: typeof raw['adoptedAt'] === 'string' ? raw['adoptedAt'] : null,
    lastBuild: lastBuild
      ? { sft: Number(lastBuild['sft'] ?? 0), dpo: Number(lastBuild['dpo'] ?? 0), at: String(lastBuild['at'] ?? '') }
      : null,
    source: file,
    findings: [],
  };

  // Manifests are files on disk like playbooks and agents, so they get the
  // same admission scan: the description and triggers reach a prompt. admit()
  // THROWS on a blocking finding, and one bad manifest must cost its own file
  // and nothing else — catching here is what turns it into a refusal.
  try {
    persona.findings = admit(
      probeTask({ id: `persona:${id}`, title: id, prompt: `${persona.description}\n${persona.triggers.join('\n')}` }),
    );
  } catch (err) {
    return { persona: null, reason: `admission blocked: ${(err as Error).message}` };
  }

  return { persona };
}

function serialize(persona: Persona): string {
  const { source: _source, findings: _findings, ...rest } = persona;
  return `---\n${JSON.stringify(rest, null, 2)}\n---\n\n${personaBody(persona)}`;
}

function personaBody(persona: Persona): string {
  return [
    `# ${persona.id}`,
    '',
    persona.description || '(no description)',
    '',
    '## What claims a sample for this persona',
    '',
    persona.triggers.length
      ? persona.triggers.map((t) => `- \`${t}\``).join('\n')
      : '- (nothing — this persona only collects Foreman tickets of its own role)',
  ].join('\n');
}

/**
 * loadPersonas() sits on the /api/state hot path (roles.ts:modelForTask ->
 * personaForTask, once per task per snapshot), and every manifest it parses
 * costs an admission scan — a `frisk-scan` spawn, failed or not. Cache the
 * catalog per personas-dir on a cheap fingerprint, as playbooks.ts does: a
 * statSync sweep every call, a re-parse and re-scan only when a manifest was
 * changed, added or removed.
 *
 * What is cached decides local-model routing (personaForTask), so the cache
 * must not serve a manifest the disk no longer holds:
 *  - the fingerprint is name:ino:mtimeMs:ctimeMs:size:mode per entry. mtime
 *    and size alone miss a same-length rewrite whose mtime was put back
 *    ("adopted" -> "retired", then `touch -r`) and miss a chmod; ctime cannot
 *    be set from userland, and mode is what decides whether the file can be
 *    read at all.
 *  - an entry is a miss once it is PERSONA_TTL_MS old, whatever the
 *    fingerprint says. The admission verdict depends on which `frisk-scan` is
 *    on PATH, which no stat of this directory can see; a scanner installed or
 *    removed is applied within the minute, at one re-scan a minute.
 * A hit returns the same object, deep-frozen: a caller that tries to mutate
 * it throws instead of leaking the change into every later caller.
 */
export const PERSONA_TTL_MS = 60_000;

const catalogCache = new Map<string, { fingerprint: string | null; loadedAt: number; catalog: PersonaCatalog }>();

/** Force the next loadPersonas() to re-read from disk. */
export function clearPersonaCache(): void {
  catalogCache.clear();
}

/** Null when the dir does not exist, so that state is distinguishable from an empty dir. */
function fingerprintDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const parts: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`);
    } catch {
      parts.push(`${name}:unreadable`);
    }
  }
  return parts.join('|');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function loadPersonas(): PersonaCatalog {
  const dir = personasDir();
  const fingerprint = fingerprintDir(dir);
  const cached = catalogCache.get(dir);
  // Date.now() so a test can drive the clock with node:test mock timers. A
  // clock that stepped backwards is a miss too, not an entry that never ages.
  const now = Date.now();
  const age = cached ? now - cached.loadedAt : 0;
  if (cached && cached.fingerprint === fingerprint && age >= 0 && age < PERSONA_TTL_MS) return cached.catalog;

  const catalog = deepFreeze(loadPersonasFrom(dir));
  catalogCache.set(dir, { fingerprint, loadedAt: now, catalog });
  return catalog;
}

function loadPersonasFrom(dir: string): PersonaCatalog {
  const personas: Persona[] = [];
  const refused: PersonaCatalog['refused'] = [];
  if (!fs.existsSync(dir)) return { personas, refused };

  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      refused.push({ file, reason: (err as Error).message });
      continue;
    }
    const { persona, reason } = parseManifest(text, file);
    if (!persona) {
      refused.push({ file, reason: reason ?? 'unparseable' });
      continue;
    }
    personas.push(persona);
  }
  return { personas, refused };
}

export function getPersona(id: string): Persona | null {
  return loadPersonas().personas.find((p) => p.id === id) ?? null;
}

export function savePersona(persona: Persona): string {
  const dir = personasDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${persona.id}.md`);
  fs.writeFileSync(file, serialize(persona));
  // A write through this module never relies on the fingerprint to be seen.
  // (ctime in the fingerprint catches this rewrite as well; the clear stays so
  // that does not depend on the filesystem's ctime resolution.)
  clearPersonaCache();
  return file;
}

export function personaId(playbook: string | null, role: string | null): string {
  return playbook && role ? `${playbook}.${role}` : 'general';
}

/**
 * The persona a task belongs to, or null when none is defined for it. Only an
 * ADOPTED persona is returned: a draft or a candidate has not beaten the model
 * it would replace, and routing live work to it would be training in public.
 */
export function personaForTask(
  task: { playbook: string | null; role: string | null },
  catalog?: PersonaCatalog,
): Persona | null {
  const cat = catalog ?? loadPersonas();
  const id = personaId(task.playbook, task.role);
  const match = cat.personas.find((p) => p.id === id);
  return match?.status === 'adopted' && match.alias ? match : null;
}

/**
 * Which persona claims a free-text history sample, by trigger match. Returns
 * null when nothing claims it — an unclaimed sample belongs to `general`, and
 * the caller decides whether it wants those.
 */
export function personaForText(text: string, catalog: PersonaCatalog): Persona | null {
  const haystack = text.toLowerCase();
  let best: { persona: Persona; score: number } | null = null;
  for (const persona of catalog.personas) {
    if (persona.status === 'retired') continue;
    let score = 0;
    for (const trigger of persona.triggers) {
      // Scored by the LENGTH of what matched, not by a count of matches.
      // "Write an editorial letter on whether the chapter earns its length"
      // hits the editor's "editorial letter" and the author's "chapter" once
      // each; the longer phrase is the more specific claim, and counting hits
      // would hand the sample to whichever persona happened to load first.
      if (haystack.includes(trigger.toLowerCase())) score += trigger.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { persona, score };
  }
  return best?.persona ?? null;
}

/** The starter set: one persona per role of the playbooks that ship with Foreman. */
export function seedPersonas(): Persona[] {
  const now = new Date().toISOString();
  const make = (
    playbook: string | null,
    role: string | null,
    description: string,
    triggers: string[],
    mode: 'sft' | 'dpo' = 'sft',
  ): Persona => ({
    id: personaId(playbook, role),
    playbook,
    role,
    description,
    base: DEFAULT_BASE,
    triggers,
    training: { ...DEFAULT_TRAINING, mode },
    retrainAfter: 200,
    status: 'draft',
    alias: null,
    trainedAt: null,
    adoptedAt: null,
    lastBuild: null,
    source: `seed:${now}`,
    findings: [],
  });

  return [
    make('publishing', 'author', 'Drafts and revises manuscript chapters against an outline and a style sheet.', [
      'draft chapter', 'chapter', 'manuscript', 'prose', 'scene', 'outline', 'style sheet', 'revise chapter',
    ]),
    make('publishing', 'dev-editor', 'Writes developmental editorial letters: structure, pacing, whether the piece earns its length.', [
      'editorial letter', 'developmental', 'does the chapter', 'structural revision', 'pacing', 'read-through',
    ]),
    make('publishing', 'copyeditor', 'Enforces house style and cross-checks names, dates and timeline against the style sheet.', [
      'copyedit', 'style sheet', 'consistency', 'timeline check', 'chicago', 'spelling', 'punctuation',
    ]),
    make('software', 'dev', 'Implements code tickets: services, APIs, tests.', [
      'implement', 'refactor', 'add a test', 'fix the bug', 'typescript', 'function', 'module', 'api endpoint',
    ]),
    make('software', 'senior', 'Reviews diffs for correctness, security and scope.', [
      'review this', 'code review', 'is this safe', 'regression', 'edge case', 'diff',
    ], 'dpo'),
    make('research', 'researcher', 'Investigates questions and reports findings with sources.', [
      'research', 'investigate', 'find out', 'sources', 'evidence', 'summarize the literature',
    ]),
    make(null, null, 'Everything that belongs to no playbook role. The fallback corpus.', []),
  ];
}
