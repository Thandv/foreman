import type { Probe } from '../bench.ts';

/**
 * A golden set for a persona whose job is to WRITE.
 *
 * The adoption gate scored `publishing.author` at 0.75 against a base of 0.75,
 * and that number was never going to move: `scoreGolden` runs `bench.ts`'s
 * PROBES, which are four reasoning puzzles, four code-review diffs and four
 * instruction-fidelity checks. They are the right probes for choosing a model
 * to review code with. They are irrelevant to an adapter trained on novel
 * prose, so candidate and base answer them identically — by construction, not
 * by coincidence. The gate was measuring something the adapter does not affect.
 *
 * These probes measure what an authoring adapter is actually for. Every one is
 * **scored by code, never by another model** — the rule `bench.ts` set and the
 * reason its numbers can be trusted. That constrains what can be asked: no
 * probe here claims to measure whether prose is *good*. They measure whether it
 * is prose at all, and they are aimed squarely at the failure modes this corpus
 * has actually produced.
 *
 * The central one is `writes-prose-not-a-report`. The persona's first corpus
 * was 108 session summaries — completions like *"Chapter 7 is drafted at
 * Chapters/…Chapter_07.md — 3,872 words, close third through Oswin"* — so it
 * learned to write status reports about drafting. Nothing in the old gate could
 * see that. This probe fails it outright.
 */

const words = (t: string): number => (t.trim().match(/\S+/g) ?? []).length;

/** Strip a leading acknowledgement so the checks judge the prose, not the chat. */
const body = (t: string): string => t.replace(/^(sure|certainly|here('s| is)[^\n]*)\n+/i, '').trim();

/** Markers of a model reporting on work instead of doing it. */
const REPORT_MARKERS = [
  /\b\d[\d,]*\s+words\b/i,
  /\b[\w/.-]+\.(md|txt|ts|js)\b/i,
  /\bI (have |'ve )?(drafted|written|created|updated|added)\b/i,
  /\b(chapter|file) is (now )?(drafted|written|complete)\b/i,
  /\bhere('s| is) (the|a) (draft|chapter|scene|revision)\b/i,
];

const SCENE_PROMPT =
  'Continue this scene. Prose only.\n\n' +
  'The clerk set the ledger down and did not look up. Outside, the rain had not stopped since morning, ' +
  'and the yard was a slow brown river between the gate and the smithy.';

export const PROSE_PROBES: Probe[] = [
  {
    id: 'writes-prose-not-a-report',
    category: 'fidelity',
    maxTokens: 400,
    prompt: SCENE_PROMPT,
    // The defect that cost this persona its first gate. A model trained on
    // session summaries answers a scene prompt by describing a scene it would
    // write, or by naming a file it did not touch.
    score: (t) => (REPORT_MARKERS.some((re) => re.test(t)) ? 0 : 1),
  },
  {
    id: 'no-markdown-scaffolding',
    category: 'fidelity',
    maxTokens: 400,
    prompt: SCENE_PROMPT,
    // Headings mid-scene are what a corpus with unstripped chapter headings
    // teaches. Bullet lists are what a chat-assistant corpus teaches.
    score: (t) => (/^\s*#{1,6}\s/m.test(t) || /^\s*[-*]\s+/m.test(t) ? 0 : 1),
  },
  {
    id: 'sustains-a-passage',
    category: 'fidelity',
    maxTokens: 400,
    prompt: SCENE_PROMPT,
    // Not a quality bar — a floor. A drafting model that answers a scene prompt
    // with two sentences cannot draft a chapter, whatever else is true of it.
    score: (t) => (words(body(t)) >= 80 ? 1 : 0),
  },
  {
    id: 'does-not-restate-the-prompt',
    category: 'fidelity',
    maxTokens: 400,
    prompt: SCENE_PROMPT,
    // Continuation means continuation. Echoing the given paragraph back is the
    // cheapest way to look like it and the easiest to detect.
    score: (t) => (t.includes('The clerk set the ledger down and did not look up') ? 0 : 1),
  },
  {
    id: 'continues-rather-than-summarises',
    category: 'fidelity',
    maxTokens: 400,
    prompt: SCENE_PROMPT,
    // Prose carries dialogue or concrete action. A summary carries neither and
    // reads as a paraphrase of a scene rather than the scene.
    score: (t) => (/[""“”]/.test(t) || /\b(said|walked|turned|set|took|looked|held|pulled)\b/i.test(body(t)) ? 1 : 0),
  },
  {
    id: 'obeys-a-hard-constraint',
    category: 'fidelity',
    maxTokens: 200,
    prompt:
      'Write two sentences of narrative prose set in a walled town at dusk. ' +
      'Do not use the word "silence" or any form of it. Prose only.',
    // Instruction-following on the axis a drafter is actually held to: a style
    // sheet forbids specific words, and a drafter that cannot honour that
    // cannot be trusted with the book's tic ceiling.
    score: (t) => (/\bsilen(ce|t|ces|tly)\b/i.test(t) ? 0 : 1),
  },
  {
    id: 'holds-third-person',
    category: 'fidelity',
    maxTokens: 300,
    prompt:
      'Continue this passage in close third person. Do not switch to first person. Prose only.\n\n' +
      'Oswin counted the wagons again and made the number come out the same.',
    // The book is close third throughout. An adapter that drifts to first
    // person is unusable for it regardless of sentence-level quality.
    score: (t) => {
      const narration = body(t).replace(/[""“”][^""“”]*[""“”]/g, ''); // ignore dialogue
      return /\b(I|I'm|I've|my|me)\b/.test(narration) ? 0 : 1;
    },
  },
  {
    id: 'no-meta-commentary',
    category: 'fidelity',
    maxTokens: 400,
    prompt: SCENE_PROMPT,
    // A chat-trained model explains its choices. A drafter does not talk about
    // the draft inside the draft.
    score: (t) => (/\b(as an AI|I should note|let me know|feel free|would you like|I hope this)\b/i.test(t) ? 0 : 1),
  },
];

/**
 * Which golden set a persona is judged on.
 *
 * Keyed on the role rather than the playbook, because the question is what the
 * persona DOES: a `copyeditor` and a `line-editor` are held to the same "is
 * this prose" bar as an `author`, while a `dev` is not.
 *
 * Anything unrecognised keeps the reasoning/code/fidelity probes, so this can
 * only ever make a gate more relevant, never less.
 */
const PROSE_ROLES = new Set(['author', 'line-editor', 'copyeditor', 'proofreader', 'dev-editor']);

export function isProseRole(role: string | null | undefined): boolean {
  return role ? PROSE_ROLES.has(role) : false;
}
