/**
 * Did the worker end its turn with its own test run still going in the
 * background? 48 runs closed on "`npm run verify` is still running in the
 * background"; the CLI exits, the run goes to review, and 26 of those were
 * rejected because nothing confirmed the acceptance items. Such a run is
 * resumed once (scheduler.ts) instead of being sent to review.
 *
 * Read sentence by sentence. A sentence counts when it ties a test run to the
 * background:
 *  - a verb, then the run, then the place ("kicked off npm test in the background");
 *  - the run, then within a few words a verb and the place ("npm run verify is
 *    still running in the background", "the full suite is running in background");
 *  - the run just before "is/are in the background" ("npm run verify is in the
 *    background and will report");
 *  - the run just before a still-going word, or between one and the place
 *    ("the verify run is still in the background", "tests not yet finished —
 *    still running in the background");
 *  - the adjective form with a still-going word ("waiting for the background
 *    verify run", "npm run verify (background) is still going");
 *  - a background shell id like bash_3.
 * The subject matters: "the upload is still running in the background" in a
 * test's description is the feature, not a pending run. "ran" is past: it
 * counts only beside a still-going word. A sentence that denies it ("nothing
 * running in the background") or closes it ("finished") does not count, and a
 * later pass/fail count closes it only when it is about that run — its
 * sentence says it finished, or names the suite / verify — never a targeted
 * run of one file ("node --test test/foo.test.ts: 5 passed").
 */

/** A test run: what a backgrounded thing has to be for this to matter. */
const RUN = String.raw`(?:npm test|tests?|suites?|verify|verification|checks?|vitest|jest|pytest|mocha|tsc|typecheck)(?: run)?`;
/** Where a run was put: "in the background", "into background", "in a background shell", "as a background task". */
const PLACE =
  String.raw`(?:in(?:to)? (?:the |a )?background(?: (?:shell|task|job|process))?|as (?:a )?background (?:task|job|process|shell|command))`;
/** A verb that puts a run there or says it is there. Not "run" (how CI runs checks), "is" or "put" (descriptions). */
const VERB =
  String.raw`(?:started|starting|start|kicked off|kicking off|kick off|launched|launching|left|leaving|running|still going|going|in progress|backgrounded)`;
/** Still going: the run is not over. */
const STILL_WORDS =
  String.raw`(?:still|in progress|not (?:yet )?(?:finished|complete|completed|done)|hasn't (?:finished|completed)|has not (?:finished|completed)|pending|awaiting|waiting|will (?:report|notify|finish|complete)|once it (?:finishes|completes)|when it (?:finishes|completes))`;
const STILL = new RegExp(String.raw`\b${STILL_WORDS}\b`);
/** A few words, within one clause (a colon ends one too: "Added tests: the worker keeps running…"). */
const FEW = String.raw`(?:[^\w.!?;:]+\w+){0,3}?[^\w.!?;:]+`;
/** From a still-going word to the place, with nothing but "still/running/going/and/is/are" between. */
const STILL_TO_PLACE = String.raw`${STILL_WORDS}\b(?:[^\w.!?;:]+(?:still|running|going|and|is|are)\b)*[^\w.!?;:]+${PLACE}`;
const TIED = [
  new RegExp(String.raw`\b${VERB}\b[^.!?;]{0,60}?\b${RUN}\b[^.!?;]{0,40}?\b${PLACE}`),
  new RegExp(String.raw`\b${RUN}${FEW}${VERB}\b[^.!?;]{0,40}?\b${PLACE}`),
  new RegExp(String.raw`\b${RUN} (?:is|are) (?:still )?${PLACE}`),
  new RegExp(String.raw`\b${RUN}${FEW}${STILL_TO_PLACE}`),
  new RegExp(String.raw`\b${STILL_WORDS}\b[^.!?;]{0,40}?\b${RUN}\b[^.!?;]{0,40}?\bbackground\b`),
  // The adjective form, with a still-going word in the clause: "the background
  // npm run verify job has not finished", "waiting for the background verify run".
  new RegExp(String.raw`\bbackground (?:npm run )?${RUN}\b[^.!?;]*\b${STILL_WORDS}\b`),
  new RegExp(String.raw`\b${STILL_WORDS}\b[^.!?;]{0,40}?\bbackground (?:npm run )?${RUN}\b`),
  // "npm run verify (background) is still going".
  new RegExp(String.raw`\b${RUN} ?\(background\)[^.!?;]*\b${STILL_WORDS}\b`),
];
/** A follow-on clause still about the run: "it has not finished yet", not "Still to do: update the README". */
const STILL_ABOUT_RUN = new RegExp(String.raw`(?:\bit\b|\b${RUN}\b)[^.!?;]*\b${STILL_WORDS}\b`);
/** Past tense: the run was put there, and is over unless a still-going word says otherwise. */
const RAN = new RegExp(String.raw`\bran\b[^.!?;]{0,60}?\b${RUN}\b[^.!?;]{0,40}?\b${PLACE}`);
/** A background shell's id, or the tool's own flag. */
const SHELL_ID = /\bbash_\d+\b|\brun_in_background\b|\bbackgrounded\b/;
const TESTY =
  /\b(?:tests?|suites?|verify|verification|vitest|jest|pytest|mocha|tsc|typecheck|npm t|checks?|testslot)\b/;
/** The background part is denied: "nothing running in the background", "no background tasks". */
const DENIED =
  /\b(?:nothing|no|none|not|isn't|is not|aren't|are not|wasn't|never|without)\b(?: \w+){0,3} (?:left )?(?:running )?(?:in(?:to)? (?:the )?)?background/;
/** The run is said to be over: "finished", "completed", "exited", "passed". */
const CLOSED =
  /\b(?:finished|completed|complete|done|exited|passed|succeeded|failed|returned|reported)\b/;
/** A result count: "312/312 pass", "120 passed", "0 failing", "# pass 42", "8 tests 8 pass". */
const COUNT =
  /\b\d+\s*\/\s*\d+\s+(?:pass|passed|passing|tests?)\b|\b\d+\s+(?:tests? )?(?:pass|passed|passing|fail|failed|failing)\b|\b(?:pass|fail|tests?)\s*[:=]?\s+\d+\b/;
/** The count is about the backgrounded run: the full suite, verify, or the background run itself. */
const SAME_RUN = /\b(?:verify|verification|full (?:test )?suite|whole suite|entire suite|the suite|background (?:test )?run|npm test)\b/;
/** The count is about something narrower: one file, a targeted run. */
const NARROW = /\btargeted\b|\bnode --test\b|\btest file\b|\bfile\b|\b[\w./-]+\.(?:test|spec)\.\w+\b|\b[\w/-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go)\b/;

export function backgroundTestPending(text: string | null | undefined): boolean {
  if (!text) return false;
  const sentences = text.toLowerCase().replace(/[`*]/g, '').split(/(?<=[.!?;])\s+|\n+/);
  // A count in this sentence or a later one closes it — only if it is about this run and says so.
  const closesAt = sentences.map((s) => COUNT.test(s) && !STILL.test(s) && !NARROW.test(s) && (CLOSED.test(s) || SAME_RUN.test(s)));
  return sentences.some((s, i) => {
    if (!TESTY.test(s) || DENIED.test(s)) return false;
    const tied = TIED.some((re) => re.test(s)) || SHELL_ID.test(s);
    // "ran … in the background" needs a still-going word here or in the next clause.
    const ranStill = !tied && RAN.test(s) && (STILL.test(s) || STILL_ABOUT_RUN.test(sentences[i + 1] ?? ''));
    if (!tied && !ranStill) return false;
    if (closesAt.slice(i).some(Boolean)) return false;
    return ranStill || STILL.test(s) || !CLOSED.test(s);
  });
}

/** The one message a resumed session gets. */
export const BACKGROUND_RESUME_PROMPT =
  'You ended your turn while a test run was still going in the background, so nothing confirmed its result. ' +
  'Wait for the background test run to finish (or re-run it in the FOREGROUND via the test-slot wrapper) and ' +
  'report its result. Then end with your final report again, including the full ACCEPTANCE MAP if the ticket has one.';
