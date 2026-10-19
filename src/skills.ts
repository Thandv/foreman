import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { boundBrief } from './context.ts';
import type { Finding } from './security/admit.ts';
import { admit, AdmissionBlocked } from './security/admit.ts';
import type { Playbook } from './playbooks.ts'; // type-only: erased, no runtime edge back into playbooks.ts
import type { Store } from './queue.ts'; // type-only, as above: queue.ts imports this file at runtime
import { probeTask, type Task } from './types.ts';

/**
 * Skills: short text procedures a crew role carries into a ticket.
 *
 * They live in a separate repository that FOREMAN_SKILLS_DIR points at:
 *
 *   <dir>/skills/<name>/skill.json   name, description, roles, kinds, when, status
 *   <dir>/skills/<name>/full.md      at most FULL_MAX_BYTES; for Claude workers and reviewers
 *   <dir>/skills/<name>/card.md      at most CARD_MAX_BYTES; for a small local model
 *   <dir>/loadouts.json              {"roles": {"<playbook>.<role>": {"default": [...], "allowed": [...]}}}
 *
 * Foreman reads this text and puts it in a brief. It never runs anything from
 * that directory, and nothing here writes to it. With FOREMAN_SKILLS_DIR unset
 * the feature is off: no skill is loaded and every brief and review prompt is
 * byte-for-byte what it was without this file.
 *
 * Which skills a ticket gets is decided here, by rule, never by the worker:
 * a 7B model asked to choose among descriptions is the failure this avoids.
 */
export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const FULL_MAX_BYTES = 4_000;
export const CARD_MAX_BYTES = 1_200;
const META_MAX_BYTES = 8_000;
const LOADOUTS_MAX_BYTES = 64_000;
/** A role carries at most this many skills per ticket; more cancels the gain out. */
export const MAX_SKILLS_PER_TICKET = 2;
/** The longest list checkTicketSkills reads name by name (repeats and blanks included); a longer one is refused whole. */
export const MAX_TICKET_SKILL_NAMES = 16;

const STATUSES = new Set<string>(['draft', 'measured', 'adopted']);

export type SkillVariant = 'full' | 'card';

export interface Skill {
  name: string;
  description: string;
  /** `<playbook>.<role>` ids that may carry it. */
  roles: string[];
  kinds: string[];
  when: string;
  status: 'draft' | 'measured' | 'adopted';
  full: string;
  card: string;
  fullBytes: number;
  cardBytes: number;
  source: string;
  findings: Finding[];
}

export interface Loadout {
  /** What the role carries when nothing names skills for it. */
  default: string[];
  /** What the role may be given. `default` names are allowed too. */
  allowed: string[];
}

export interface SkillCatalog {
  /** The skills repository in use, or null when the feature is off. */
  dir: string | null;
  skills: Skill[];
  refused: Array<{ id: string; reason: string }>;
  /** Keyed `<playbook>.<role>`. */
  loadouts: Record<string, Loadout>;
}

export const SKILLS_HEADER =
  "SKILLS FOR THIS TICKET (procedures; the ticket's brief, acceptance and operator demands outrank them):";

/**
 * What the admission probe does not look for. It screens commands (a wipe, a
 * fork bomb, a pipe into a shell); a skill is prose addressed to a model, and
 * the two ways prose attacks a model are text the operator cannot see when
 * they read the file, and text that tells the model its instructions changed.
 *
 * Hidden: C0 controls other than tab/LF/CR, DEL and the C1 block, the soft
 * hyphen, the Arabic letter mark, the Mongolian vowel separator, zero-width
 * and directional marks, line/paragraph separators, bidi embeddings, overrides
 * and isolates, the word joiner and invisible operators, the BOM, interlinear
 * annotation marks, and the Unicode tag block. Also the characters that
 * render as nothing or as a blank yet are not whitespace: the combining
 * grapheme joiner, the Hangul fillers, the Khmer inherent vowels, the Braille
 * blank, and both variation-selector blocks (a run of selectors after one
 * visible character carries arbitrary bytes a reader never sees).
 */
export const HIDDEN_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/**
 * Lines Foreman itself writes into a brief or a review prompt to open a
 * section the reader is told to obey: the `---` rule that ends the role part
 * of a worker's brief, and the labels in scheduler.ts and crewReview.ts. A
 * skill that carries one of them at the start of a line could pass for that
 * section — a forged acceptance list, a forged operator finding, a forged
 * "tests passed" — so it is refused. Unlike the phrase list below this is a
 * closed set: it is Foreman's own vocabulary, not a guess at an attacker's.
 */
const RESERVED_LINE =
  /^[ \t]*(?:-{3,}[ \t]*$|…[ \t]*\[FOREMAN\b|#+[ \t]*role:|(?:#+[ \t]*)?(?:ACCEPTANCE CRITERIA\b|OPERATOR DEMANDS?\b|A HUMAN rejected\b|CORE GUARD\b|FOREMAN CHECK\b|DEFINITION OF DONE\b|TEST GATE\b|REVIEW STYLE\b|WORK UNDER REVIEW\b|Hard constraints:|Reply with JSON only\b|SKILLS FOR THIS TICKET\b|Foreman left out:))/im;
/** The one-word labels, in Foreman's own capitals only: "Ticket:" and "Brief:" are ordinary words in a report template. */
const RESERVED_LABEL = /^[ \t]*(?:TICKET|BRIEF|SHELL):/m;

const INJECTION: Array<{ pattern: RegExp; what: string }> = [
  {
    pattern: /\b(ignore|disregard)\s+(?:(?:all|any|the|your|every|of)\s+)*(previous|prior|above)\s+instructions?\b/i,
    what: 'tells the reader to ignore its earlier instructions',
  },
  { pattern: /\bsystem\s+prompt\b/i, what: 'names the system prompt' },
  { pattern: /\byou\s+are\s+now\b/i, what: 'reassigns the reader ("you are now")' },
];

/** The reason a skill's text is refused, or null. Exported for the listing; the loader is what enforces it. */
export function textRefusal(text: string): string | null {
  const hidden = HIDDEN_CHAR.exec(text);
  if (hidden) {
    const code = hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    return `hidden character U+${code} (zero-width, bidi or control) at offset ${hidden.index}`;
  }
  if (text.includes('\uFFFD')) return 'a replacement character (U+FFFD): the file was not valid text when it was written';
  const reserved = RESERVED_LINE.exec(text) ?? RESERVED_LABEL.exec(text);
  if (reserved) return `a line that opens like one of Foreman's own brief sections ("${printable(reserved[0].trim()).slice(0, 40)}")`;
  // Matched on whitespace-collapsed text so a phrase split across a line break is still the phrase.
  const flat = text.replace(/\s+/g, ' ');
  for (const rule of INJECTION) {
    if (rule.pattern.test(flat)) return `injection phrase: ${rule.what}`;
  }
  return null;
}

class Refused extends Error {}

/**
 * Read one regular file of at most `maxBytes`, never through a symlink.
 *
 * lstat gives the reason a person can act on; O_NOFOLLOW on the open is what
 * holds if the entry is swapped for a link between the two, and the size is
 * checked again on the descriptor that is actually read. O_NONBLOCK is for the
 * same swap with a FIFO: a blocking open of one waits for a writer for ever,
 * on the daemon's only thread. Bytes that are not UTF-8 are refused rather
 * than decoded into something the operator never wrote.
 */
function readPlain(file: string, label: string, maxBytes: number): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new Refused(`${label} is missing`);
  }
  if (st.isSymbolicLink()) throw new Refused(`${label} is a symlink; symlinks are not followed`);
  if (!st.isFile()) throw new Refused(`${label} is not a regular file`);
  if (st.size > maxBytes) throw new Refused(`${label} is ${st.size} bytes, over the ${maxBytes} byte cap`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    throw new Refused(`${label} could not be opened without following a link: ${(err as Error).message}`);
  }
  try {
    const now = fs.fstatSync(fd);
    if (!now.isFile()) throw new Refused(`${label} is not a regular file`);
    if (now.size > maxBytes) throw new Refused(`${label} is ${now.size} bytes, over the ${maxBytes} byte cap`);
    const buf = Buffer.alloc(maxBytes + 1);
    const n = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
    if (n > maxBytes) throw new Refused(`${label} is over the ${maxBytes} byte cap`);
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, n));
    } catch {
      throw new Refused(`${label} is not valid UTF-8`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** A real directory (not a link to one) that resolves to exactly where it was asked for. */
function assertPlainDir(dir: string, label: string, expectReal: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    throw new Refused(`${label} is missing`);
  }
  if (st.isSymbolicLink()) throw new Refused(`${label} is a symlink; symlinks are not followed`);
  if (!st.isDirectory()) throw new Refused(`${label} is not a directory`);
  // Belt to the lstat's braces: whatever the entry is, what gets read must be
  // the path under the skills dir and nothing it resolves to elsewhere.
  if (fs.realpathSync(dir) !== expectReal) throw new Refused(`${label} resolves outside the skills dir`);
}

/** File-supplied text on its way into a refusal reason: short, and nothing a terminal would act on. */
export function printable(text: string): string {
  return text.slice(0, 80).replace(/[^\x20-\x7E]/g, '?');
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function loadSkill(skillsRoot: string, name: string): Skill {
  if (!SKILL_NAME_RE.test(name)) throw new Refused('bad name: a skill name is 1-64 characters of a-z, 0-9 and -');
  const dir = path.join(skillsRoot, name);
  assertPlainDir(dir, 'the skill directory', dir);

  const metaText = readPlain(path.join(dir, 'skill.json'), 'skill.json', META_MAX_BYTES);
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(metaText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    meta = parsed as Record<string, unknown>;
  } catch (err) {
    throw new Refused(`skill.json is not valid JSON: ${(err as Error).message}`);
  }
  if (meta['name'] !== name) {
    throw new Refused(`bad name: skill.json names ${printable(JSON.stringify(meta['name']) ?? 'nothing')}, the directory is '${name}'`);
  }
  const status = meta['status'];
  if (status === 'retired') throw new Refused('retired');
  // An absent or misspelt status is refused rather than read as "draft": the
  // field is how a skill is withdrawn, so a typo must not put one back.
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    throw new Refused(`status ${printable(JSON.stringify(status) ?? 'missing')} is not one of draft, measured, adopted`);
  }

  const full = readPlain(path.join(dir, 'full.md'), 'full.md', FULL_MAX_BYTES);
  const card = readPlain(path.join(dir, 'card.md'), 'card.md', CARD_MAX_BYTES);
  if (!full.trim()) throw new Refused('full.md is empty');
  if (!card.trim()) throw new Refused('card.md is empty');

  const description = typeof meta['description'] === 'string' ? meta['description'] : '';
  const when = typeof meta['when'] === 'string' ? meta['when'] : '';
  for (const [label, text] of [['full.md', full], ['card.md', card], ['skill.json', `${description}\n${when}`]] as const) {
    const reason = textRefusal(text);
    if (reason) throw new Refused(`${label}: ${reason}`);
  }

  // The same probe agents and playbooks pass at load, on everything that can
  // reach a prompt. It throws AdmissionBlocked on a blocking finding.
  const findings = admit(probeTask({ id: `skill:${name}`, title: name, prompt: `${full}\n\n${card}\n\n${description}\n${when}` }));

  return {
    name,
    description,
    roles: strings(meta['roles']),
    kinds: strings(meta['kinds']),
    when,
    status: status as Skill['status'],
    full,
    card,
    fullBytes: Buffer.byteLength(full),
    cardBytes: Buffer.byteLength(card),
    source: dir,
    findings,
  };
}

function loadLoadouts(root: string, refused: SkillCatalog['refused']): Record<string, Loadout> {
  // No prototype: the keys come from a file, and one of them may be `__proto__`.
  const out: Record<string, Loadout> = Object.create(null) as Record<string, Loadout>;
  const file = path.join(root, 'loadouts.json');
  if (!fs.existsSync(file) && !isLink(file)) return out;
  try {
    const parsed: unknown = JSON.parse(readPlain(file, 'loadouts.json', LOADOUTS_MAX_BYTES));
    const roles = (parsed as { roles?: unknown } | null)?.roles;
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Refused('loadouts.json has no "roles" object');
    for (const [key, raw] of Object.entries(roles as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        refused.push({ id: `loadouts.json:${printable(key)}`, reason: 'not an object with "default" and "allowed" lists' });
        continue;
      }
      const entry = raw as { default?: unknown; allowed?: unknown };
      out[key] = { default: strings(entry.default), allowed: strings(entry.allowed) };
    }
  } catch (err) {
    // No loadouts is no defaults: a role then carries only what a playbook
    // names for it, and each of those is still checked against the skill.
    refused.push({ id: 'loadouts.json', reason: err instanceof Refused ? err.message : `not valid JSON: ${(err as Error).message}` });
    return Object.create(null) as Record<string, Loadout>;
  }
  return out;
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The uncached loader. `root` is the skills repository; the directory the
 * operator named is resolved once (they may keep it behind a link of their
 * own), and nothing below it is read through a link.
 */
export function loadSkillsFrom(root: string): SkillCatalog {
  const skills: Skill[] = [];
  const refused: SkillCatalog['refused'] = [];
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    refused.push({ id: root, reason: 'the skills dir does not exist' });
    return { dir: root, skills, refused, loadouts: Object.create(null) as Record<string, Loadout> };
  }
  const loadouts = loadLoadouts(real, refused);
  const skillsRoot = path.join(real, 'skills');
  if (!fs.existsSync(skillsRoot) && !isLink(skillsRoot)) return { dir: root, skills, refused, loadouts };
  let names: string[];
  try {
    assertPlainDir(skillsRoot, 'skills/', skillsRoot);
    names = fs.readdirSync(skillsRoot).sort();
  } catch (err) {
    refused.push({ id: 'skills/', reason: err instanceof Refused ? err.message : `unreadable: ${(err as Error).message}` });
    return { dir: root, skills, refused, loadouts };
  }
  for (const name of names) {
    if (name.startsWith('.')) continue; // .DS_Store, .gitkeep: not a skill, not worth a refusal line
    try {
      skills.push(loadSkill(skillsRoot, name));
    } catch (err) {
      // Refusal is not overridable: a refused skill is not in the catalog, so
      // no loadout, playbook or ticket can select it.
      const reason = err instanceof Refused || err instanceof AdmissionBlocked ? err.message : `unreadable: ${(err as Error).message}`;
      refused.push({ id: printable(name), reason });
    }
  }
  return { dir: root, skills, refused, loadouts };
}

/**
 * loadSkills() is called for every crew brief and every crew review prompt,
 * and each skill it parses costs an admission scan. Cached per skills dir on
 * a fingerprint, as agents.ts does, and for the same two reasons kept honest
 * the same two ways: the fingerprint is ino:mtime:ctime:size:mode of every
 * entry that is read (lstat, so a file swapped for a link is a change), and
 * an entry is a miss once it is SKILLS_TTL_MS old, because the admission
 * verdict also depends on which `frisk-scan` is on PATH. A hit returns the
 * same deep-frozen object.
 */
export const SKILLS_TTL_MS = 60_000;

const catalogCache = new Map<string, { fingerprint: string; loadedAt: number; catalog: SkillCatalog }>();

/** Force the next loadSkills() to re-read from disk. */
export function clearSkillCache(): void {
  catalogCache.clear();
}

function stamp(file: string): string {
  try {
    const st = fs.lstatSync(file);
    return `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`;
  } catch {
    return 'absent';
  }
}

function fingerprintDir(root: string): string {
  const parts = [`.:${stamp(root)}`, `loadouts.json:${stamp(path.join(root, 'loadouts.json'))}`];
  const skillsRoot = path.join(root, 'skills');
  parts.push(`skills:${stamp(skillsRoot)}`);
  let names: string[] = [];
  try {
    // A linked skills/ is refused by the loader; do not list through it here either.
    if (fs.lstatSync(skillsRoot).isDirectory()) names = fs.readdirSync(skillsRoot).sort();
  } catch {
    // absent or unreadable: the stamp above already says so
  }
  for (const name of names) {
    const dir = path.join(skillsRoot, name);
    parts.push(`${name}:${stamp(dir)}`);
    for (const file of ['skill.json', 'full.md', 'card.md']) parts.push(`${name}/${file}:${stamp(path.join(dir, file))}`);
  }
  return parts.join('|');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const OFF: SkillCatalog = deepFreeze({ dir: null, skills: [], refused: [], loadouts: Object.create(null) as Record<string, Loadout> });

export function loadSkills(): SkillCatalog {
  const dir = config.skillsDir;
  if (!dir) return OFF;
  const fingerprint = fingerprintDir(dir);
  const cached = catalogCache.get(dir);
  const now = Date.now();
  const age = cached ? now - cached.loadedAt : 0;
  if (cached && cached.fingerprint === fingerprint && age >= 0 && age < SKILLS_TTL_MS) return cached.catalog;

  let catalog: SkillCatalog;
  try {
    catalog = deepFreeze(loadSkillsFrom(dir));
  } catch (err) {
    // This sits on the launch path of every crew ticket. A skills dir that
    // cannot be read costs the ticket its skills, never its run.
    catalog = deepFreeze({
      dir, skills: [], loadouts: Object.create(null) as Record<string, Loadout>,
      refused: [{ id: dir, reason: `unreadable: ${(err as Error).message}` }],
    });
  }
  catalogCache.set(dir, { fingerprint, loadedAt: now, catalog });
  return catalog;
}

export interface SkillSelection {
  skills: Skill[];
  /** Every name that was asked for and not served, with why. Never dropped silently. */
  dropped: Array<{ name: string; reason: string }>;
}

/**
 * The skills one ticket's role carries.
 *
 * `opts.names` is an explicit list (the ticket's own, or a playbook's `skills`
 * key; see carriedSkills for the order). With none, the role's loadout
 * `default` applies. Either way every name must be in the role's loadout
 * (`allowed` or `default`), must be a loaded skill — a refused one is not —
 * and that skill must itself list `<playbook>.<role>`: the loadout says what
 * the role may ask for, the skill says who it was written for, and both must
 * agree. The first MAX_SKILLS_PER_TICKET that pass are served.
 */
export function skillsFor(playbookId: string, role: string, opts: { names?: readonly string[] | null } = {}): SkillSelection {
  const catalog = loadSkills();
  const out: SkillSelection = { skills: [], dropped: [] };
  if (!catalog.dir) return out;
  const key = `${playbookId}.${role}`;
  const loadout = Object.prototype.hasOwnProperty.call(catalog.loadouts, key) ? catalog.loadouts[key]! : { default: [], allowed: [] };
  const wanted = opts.names?.length ? opts.names : loadout.default;
  const seen = new Set<string>();
  for (const name of wanted) {
    if (typeof name !== 'string' || seen.has(name)) continue;
    seen.add(name);
    if (!SKILL_NAME_RE.test(name)) {
      out.dropped.push({ name, reason: 'not a valid skill name' });
      continue;
    }
    if (!loadout.allowed.includes(name) && !loadout.default.includes(name)) {
      out.dropped.push({ name, reason: `not in the allowed list for ${key}` });
      continue;
    }
    const skill = catalog.skills.find((s) => s.name === name);
    if (!skill) {
      // The load-time reason can quote the skill's own file, and this line
      // reaches a prompt: say that it was refused, and leave why to the listing.
      const wasRefused = catalog.refused.some((r) => r.id === name);
      out.dropped.push({ name, reason: wasRefused ? 'refused at load (see: foreman skills)' : 'no such skill is loaded' });
      continue;
    }
    if (!skill.roles.includes(key)) {
      out.dropped.push({ name, reason: `the skill does not list ${key} in its roles` });
      continue;
    }
    if (out.skills.length >= MAX_SKILLS_PER_TICKET) {
      out.dropped.push({ name, reason: `over the limit of ${MAX_SKILLS_PER_TICKET} skills per ticket` });
      continue;
    }
    out.skills.push(skill);
  }
  return out;
}

/** One line naming what was left out. Only well-formed names are echoed into a prompt. */
function droppedLine(dropped: SkillSelection['dropped'], fellBack = false): string {
  if (!dropped.length) return '';
  const items = dropped.map((d) => `${SKILL_NAME_RE.test(d.name) ? d.name : '(invalid name)'} — ${d.reason}`);
  return `Foreman left out: ${items.join('; ')}.${fellBack ? " The role's usual skills apply instead." : ''}`;
}

export interface CarriedSkills extends SkillSelection {
  /** Whose list was served: the ticket's own, the playbook's `skills` key, or the loadout default. */
  source: 'ticket' | 'playbook' | 'default';
  /** True when the ticket named skills and none of them could be served, so the role's usual ones are. */
  fellBack: boolean;
}

/**
 * What one ticket's role carries, in order of precedence: the ticket's own
 * list (tasks.skills), else the playbook's `skills` key for the role, else the
 * loadout default. Every level goes through skillsFor, so a ticket's list is
 * checked again here, at brief time, against the catalogue as it is now.
 *
 * A ticket's name that no longer passes (retired, refused, taken off the
 * role's list since it was queued) is dropped and reported. If none of the
 * ticket's names is left the role's usual skills are served rather than none:
 * a ticket with no procedure at all is worse off than one with the default.
 */
export function carriedSkills(pb: Pick<Playbook, 'id' | 'skills'>, role: string, ticket?: readonly string[] | null, exact = false): CarriedSkills {
  // A crew reviewer's own list is exact: what cannot be served is dropped and the
  // role's usual skills never stand in, and an empty list is no skills at all.
  if (exact && ticket) {
    const own: SkillSelection = ticket.length ? skillsFor(pb.id, role, { names: ticket }) : { skills: [], dropped: [] };
    return { ...own, source: 'ticket', fellBack: false };
  }
  const named = pb.skills?.[role]?.length ? pb.skills[role]! : null;
  const usual = (): CarriedSkills => ({ ...skillsFor(pb.id, role, { names: named }), source: named ? 'playbook' : 'default', fellBack: false });
  if (!ticket?.length) return usual();
  const own = skillsFor(pb.id, role, { names: ticket });
  if (own.skills.length) return { ...own, source: 'ticket', fellBack: false };
  const base = usual();
  return { ...base, dropped: [...own.dropped, ...base.dropped], fellBack: true };
}

/**
 * The skills block for one playbook role, or '' when there is none to serve
 * (the feature is off, the role has no loadout, or every name was dropped —
 * `foreman skills show` still prints the drops). The block is bounded to
 * `skillBriefBytes`, and a cut is marked. `ticket` is the ticket's own list;
 * a ticket whose names were all dropped still gets the line that says so.
 */
export function skillBlock(
  pb: Pick<Playbook, 'id' | 'skills'>, role: string, variant: SkillVariant, ticket?: readonly string[] | null, exact = false,
): string {
  if (!config.skillsDir) return '';
  const selection = carriedSkills(pb, role, ticket, exact);
  const left = droppedLine(selection.dropped, selection.fellBack);
  if (!selection.skills.length) return selection.fellBack && left ? boundBrief(left, config.skillBriefBytes, 'skills') : '';
  const sections = selection.skills.map((s) => `## ${s.name}\n${(variant === 'card' ? s.card : s.full).trim()}`);
  return boundBrief([SKILLS_HEADER, ...sections, ...(left ? [left] : [])].join('\n\n'), config.skillBriefBytes, 'skills');
}

/** skillBlock, joined the way toolBrief is: it follows the role prompt, constraints and tools. */
export function skillBrief(pb: Pick<Playbook, 'id' | 'skills'>, role: string, variant: SkillVariant, ticket?: readonly string[] | null): string {
  const block = skillBlock(pb, role, variant, ticket);
  return block ? `\n\n${block}` : '';
}

/** The JSON a run's `skills` event carries: what its brief was given, in which text, and what was left out. */
export function skillsRunRecord(
  pb: Pick<Playbook, 'id' | 'skills'>, role: string, variant: SkillVariant, ticket?: readonly string[] | null,
  resumed = false, exact = false,
): string {
  const sel = carriedSkills(pb, role, ticket, exact);
  return JSON.stringify({
    role: `${pb.id}.${role}`,
    source: sel.source,
    variant,
    skills: sel.skills.map((s) => s.name),
    dropped: sel.dropped.map((d) => ({ name: SKILL_NAME_RE.test(d.name) ? d.name : '(invalid name)', reason: d.reason })),
    ...(sel.fellBack ? { fellBack: true } : {}),
    // A resumed round sends the critique only; the session holds the brief its first round was given.
    ...(resumed ? { resumed: true } : {}),
  });
}

// ------------------------------------------------------- a ticket's own list

/** The ticket a list of skills is being set on. Only an agent-less playbook role carries skills (scheduler.ts briefFor). */
export interface SkillTarget {
  playbook?: string | null;
  role?: string | null;
  agent?: string | null;
}

export interface TicketSkillCheck {
  /** The names that may be stored on the ticket: each one skillsFor serves today, at most MAX_SKILLS_PER_TICKET. */
  names: string[];
  /** Every name asked for and not accepted, with why. */
  refused: Array<{ name: string; reason: string }>;
  /** What the role may be given: its default, then its allowed list. */
  allowed: string[];
}

export class TicketSkillsRefused extends Error {}

/** A name on its way into a refusal a person reads: a well-formed one as it is, anything else quoted and made printable. */
export const shown = (name: string): string => (SKILL_NAME_RE.test(name) ? name : JSON.stringify(printable(name)));

/**
 * The one check behind every way a ticket's skills are set — `foreman add`,
 * `foreman retry`, a plan's ticket, the store itself. It asks skillsFor, so
 * what is accepted here is exactly what a brief would serve: a loaded skill,
 * on the role's list, that lists the role, and no more than two. `raw` is
 * whatever arrived (a model's reply, a request body).
 *
 * This reports; the caller decides. A person's request is refused whole on any
 * refusal (assertTicketSkills); a plan keeps `names` and shows `refused` as
 * warnings, because one bad name must not cost an epic its plan.
 */
export function checkTicketSkills(target: SkillTarget, raw: unknown): TicketSkillCheck {
  const out: TicketSkillCheck = { names: [], refused: [], allowed: [] };
  if (raw === null || raw === undefined) return out;
  if (!Array.isArray(raw)) {
    out.refused.push({ name: typeof raw === 'string' ? raw : '(not a list)', reason: 'skills must be a list of skill names' });
    return out;
  }
  // A list this long is not a request for two skills. One refusal, not one per
  // entry: the refusals are echoed (a 400, a plan's warnings), and a request
  // body of short names would otherwise come back many times its own size.
  if (raw.length > MAX_TICKET_SKILL_NAMES) {
    out.refused.push({ name: `(${raw.length} names)`, reason: `a ticket names at most ${MAX_SKILLS_PER_TICKET} skills` });
    return out;
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) names.push(entry.trim());
    else out.refused.push({ name: '(not a name)', reason: 'a skill is named by a string' });
  }
  const all = (reason: string): TicketSkillCheck => {
    for (const name of new Set(names)) out.refused.push({ name, reason });
    return out;
  };
  if (!names.length) return out;
  const catalog = loadSkills();
  if (!catalog.dir) return all('skills are off (FOREMAN_SKILLS_DIR is not set where Foreman runs)');
  if (target.agent) return all(`the ticket names an agent ('${printable(target.agent)}'); only a playbook role carries skills`);
  if (!target.playbook || !target.role) return all('the ticket has no playbook role to carry skills (it needs both a playbook and a role)');
  const key = `${target.playbook}.${target.role}`;
  const loadout = Object.prototype.hasOwnProperty.call(catalog.loadouts, key) ? catalog.loadouts[key]! : { default: [], allowed: [] };
  out.allowed = [...new Set([...loadout.default, ...loadout.allowed])];
  const sel = skillsFor(target.playbook, target.role, { names });
  out.names = sel.skills.map((s) => s.name);
  out.refused.push(...sel.dropped);
  return out;
}

/** One refusal as a sentence: the skill, why, and what the role may carry instead. */
export function ticketSkillRefusal(target: SkillTarget, check: TicketSkillCheck, refused: { name: string; reason: string }): string {
  const role = target.playbook && target.role ? `${printable(target.playbook)}.${printable(target.role)}` : 'this ticket';
  const may = check.allowed.length
    ? `${role} may carry: ${check.allowed.map(shown).join(', ')} (at most ${MAX_SKILLS_PER_TICKET})`
    : `${role} has no skills it may carry`;
  return `skill ${shown(refused.name)} refused — ${refused.reason}; ${may}`;
}

/**
 * The list to store for a ticket, or null for "the role's default" (nothing
 * asked for). Throws TicketSkillsRefused naming every refused skill: a
 * request a person made is never trimmed to the part that passed.
 */
export function assertTicketSkills(target: SkillTarget, raw: unknown): string[] | null {
  const check = checkTicketSkills(target, raw);
  if (check.refused.length) {
    throw new TicketSkillsRefused(check.refused.map((r) => ticketSkillRefusal(target, check, r)).join('\n'));
  }
  return check.names.length ? check.names : null;
}

/**
 * Change the skills of a ticket that already exists (`foreman retry --skills`):
 * a checked list, or null to go back to the role's default. Through the
 * store's own handle and event log; the check is assertTicketSkills.
 */
export function setTicketSkills(store: Pick<Store, 'db' | 'getTask' | 'record'>, taskId: string, raw: unknown): Task {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const names = assertTicketSkills(task, raw);
  store.db.prepare('UPDATE tasks SET skills = ?, updated_at = ? WHERE id = ?').run(names ? JSON.stringify(names) : null, Date.now(), taskId);
  store.record({ taskId, type: 'status', message: names ? `skills set: ${names.join(', ')}` : 'skills cleared: the role default applies' });
  return store.getTask(taskId)!;
}

/** `foreman skills`: what is loaded and what was refused, as text. */
export function formatSkillList(catalog: SkillCatalog = loadSkills()): string {
  if (!catalog.dir) return 'skills are off — set FOREMAN_SKILLS_DIR to a skills repository to turn them on\n';
  const lines = [`skills dir: ${catalog.dir}`];
  if (!catalog.skills.length) lines.push('no skills loaded');
  for (const s of catalog.skills) {
    lines.push(
      `  ok   ${s.name.padEnd(28)} ${s.status.padEnd(9)} full ${String(s.fullBytes).padStart(4)}B  card ${String(s.cardBytes).padStart(4)}B  ` +
        `${s.roles.map(printable).join(', ') || '(no roles)'}`,
    );
  }
  for (const r of catalog.refused) lines.push(`  REFUSED ${r.id} — ${r.reason}`);
  const roles = Object.keys(catalog.loadouts).sort();
  if (roles.length) {
    lines.push('loadouts:');
    for (const key of roles) {
      const l = catalog.loadouts[key]!;
      lines.push(`  ${printable(key).padEnd(28)} default [${l.default.map(printable).join(' ')}]  allowed [${l.allowed.map(printable).join(' ')}]`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The one line `foreman doctor` prints. */
export function skillsDoctorLine(catalog: SkillCatalog = loadSkills()): string {
  if (!catalog.dir) return 'skills: off (FOREMAN_SKILLS_DIR is not set)';
  return `skills: ${catalog.dir} — ${catalog.skills.length} loaded, ${catalog.refused.length} refused` +
    `${catalog.refused.length ? ' (run: foreman skills)' : ''}`;
}
