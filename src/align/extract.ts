import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { assertClean, redact, type Redaction } from './redact.ts';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface Sample {
  source: string;
  sessionId: string;
  prompt: string;
  completion: string;
  /** Approximate token count, for budgeting the training set. */
  tokens: number;
}

export interface ExtractStats {
  filesRead: number;
  filesSkipped: number;
  turnsSeen: number;
  samples: number;
  droppedShort: number;
  droppedNoise: number;
  droppedDuplicate: number;
  redactions: Redaction[];
}

export function alignDir(): string {
  return process.env['FOREMAN_ALIGN_DIR'] ?? path.join(config.home, 'align');
}

export function claudeProjectsDir(): string {
  return process.env['FOREMAN_CLAUDE_PROJECTS'] ?? path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Cowork keeps its transcripts somewhere else and calls them audit logs, but
 * the shape is the same JSONL. They are the same operator's decisions and are
 * worth exactly as much as training data, so both roots are read by default.
 */
export function coworkSessionsDir(): string {
  return (
    process.env['FOREMAN_COWORK_SESSIONS'] ??
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  );
}

/** Every history root that exists on this machine. */
export function historyRoots(): string[] {
  return [claudeProjectsDir(), coworkSessionsDir()].filter((dir) => fs.existsSync(dir));
}

/** Meta turns that are interface noise rather than anything the user said. */
const NOISE = [
  /^<command-name>/, /^<local-command/, /^Caveat: The messages below/, /^\[Request interrupted/,
  /^<system-reminder>/, /^This session is being continued from/, /^<task-notification>/,
  // An automated run of a scheduled task is the machine talking to itself.
  /^<scheduled-task/,
];

const isNoise = (text: string): boolean => NOISE.some((re) => re.test(text.trim()));

/** Text blocks only: thinking and tool traffic are noise for style alignment. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
    .filter((b) => b['type'] === 'text')
    .map((b) => String(b['text'] ?? ''))
    .join('\n')
    .trim();
}

/** One session file → ordered user/assistant turns, sidechains excluded. */
export function readSession(file: string): { sessionId: string; turns: Turn[] } {
  const turns: Turn[] = [];
  let sessionId = path.basename(file, '.jsonl');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated or corrupt line is not worth failing the file for
    }
    // Claude Code writes `sessionId`; cowork's audit log writes `session_id`.
    if (row['sessionId']) sessionId = String(row['sessionId']);
    else if (row['session_id']) sessionId = String(row['session_id']);
    if (row['isSidechain'] === true) continue; // subagent chatter is not the user's voice
    // The cowork spelling of the same thing: a turn produced inside a tool call
    // belongs to a subagent, not to the conversation.
    if (row['parent_tool_use_id']) continue;
    const type = String(row['type'] ?? '');
    if (type !== 'user' && type !== 'assistant') continue;
    const message = row['message'];
    if (!message || typeof message !== 'object') continue;
    const text = textOf((message as Record<string, unknown>)['content']);
    if (!text.trim()) continue;
    turns.push({ role: type, text: text.trim() });
  }
  return { sessionId, turns };
}

export interface ExtractOptions {
  dir?: string;
  minChars?: number;
  maxChars?: number;
  limitFiles?: number;
  /** Only sessions modified within this many days. */
  withinDays?: number;
  onProgress?: (line: string) => void;
}

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Build SFT samples from real session history: a user request paired with the
 * assistant reply that followed it. Every sample is redacted before it is
 * returned, and the result is asserted clean — nothing reaches a dataset that
 * still matches a known credential shape.
 */
export function extractSamples(opts: ExtractOptions = {}): { samples: Sample[]; stats: ExtractStats } {
  // An explicit dir that does not exist is an empty corpus, not an error: a
  // caller pointing at a machine's history should get zero samples back, the
  // same as a machine with no history on it.
  const roots = (opts.dir ? [opts.dir] : historyRoots()).filter((dir) => fs.existsSync(dir));
  const minChars = opts.minChars ?? 40;
  const maxChars = opts.maxChars ?? 8000;
  const stats: ExtractStats = {
    filesRead: 0, filesSkipped: 0, turnsSeen: 0, samples: 0,
    droppedShort: 0, droppedNoise: 0, droppedDuplicate: 0, redactions: [],
  };
  const samples: Sample[] = [];
  const seen = new Set<string>();
  const redactionTotals = new Map<string, number>();

  if (!roots.length) return { samples, stats };

  const files = roots.flatMap((root) => listSessions(root, opts.withinDays)).sort();
  for (const file of opts.limitFiles ? files.slice(0, opts.limitFiles) : files) {
    let session: { sessionId: string; turns: Turn[] };
    try {
      session = readSession(file);
      stats.filesRead++;
    } catch {
      stats.filesSkipped++;
      continue;
    }
    stats.turnsSeen += session.turns.length;

    for (let i = 0; i < session.turns.length - 1; i++) {
      const user = session.turns[i]!;
      const assistant = session.turns[i + 1]!;
      if (user.role !== 'user' || assistant.role !== 'assistant') continue;
      if (isNoise(user.text) || isNoise(assistant.text)) {
        stats.droppedNoise++;
        continue;
      }
      if (user.text.length < minChars || assistant.text.length < minChars) {
        stats.droppedShort++;
        continue;
      }

      const prompt = redact(user.text.slice(0, maxChars));
      const completion = redact(assistant.text.slice(0, maxChars));
      for (const r of [...prompt.redactions, ...completion.redactions]) {
        redactionTotals.set(r.rule, (redactionTotals.get(r.rule) ?? 0) + r.count);
      }

      const key = `${prompt.text.slice(0, 200)}|${completion.text.slice(0, 200)}`;
      if (seen.has(key)) {
        stats.droppedDuplicate++;
        continue;
      }
      seen.add(key);

      // Per sample, not over a joined corpus: 1300 sessions is hundreds of
      // megabytes, and a sample that fails is dropped rather than failing all.
      try {
        assertClean(`${prompt.text}\n${completion.text}`);
      } catch {
        stats.droppedNoise++;
        continue;
      }

      samples.push({
        source: file,
        sessionId: session.sessionId,
        prompt: prompt.text,
        completion: completion.text,
        tokens: approxTokens(prompt.text) + approxTokens(completion.text),
      });
    }
    opts.onProgress?.(`${path.basename(file)}: ${samples.length} samples so far`);
  }

  stats.samples = samples.length;
  stats.redactions = [...redactionTotals.entries()].map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);

  return { samples, stats };
}

function listSessions(root: string, withinDays?: number): string[] {
  const out: string[] = [];
  const cutoff = withinDays ? Date.now() - withinDays * 86_400_000 : 0;
  const walk = (dir: string, depth = 0): void => {
    // Cowork nests a session three directories deep under its own ids, so the
    // walk has to reach further than a Claude Code project layout needs.
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) {
        if (cutoff && fs.statSync(full).mtimeMs < cutoff) continue;
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}
