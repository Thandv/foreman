import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { applyApproval } from '../src/gate.ts';
import { NOTHING_TO_CHANGE_CLOSED } from '../src/verify/gateOutcome.ts';

const BOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'board');

/** Every file under board/, as paths relative to board/. */
function walk(rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(BOARD_DIR, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out.sort();
}

/*
 * The board is browser-native ES modules served straight off disk: no bundler,
 * no transpile, no test runner that would ever import them. Nothing else in
 * this repo would notice a stray brace until it 500s in someone's browser, so
 * the parse is the test.
 *
 * `node --check <file.js>` is NOT the check to run here: for a .js file whose
 * contents it detects as module syntax, Node's checker falls through the CJS
 * wrap and exits 0 without parsing anything — verified against a file with a
 * deliberate syntax error. Piping the source in under --input-type=module is
 * the form that actually reports SyntaxError.
 */
test('every board script parses', () => {
  const scripts = walk().filter((f) => f.endsWith('.js'));
  assert.ok(scripts.length >= 10, `expected the board to have modules, found ${scripts.length}`);
  for (const rel of scripts) {
    const source = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8');
    try {
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: 'pipe' });
    } catch (err) {
      const detail = String((err as { stderr?: Buffer }).stderr ?? err);
      assert.fail(`board/${rel} does not parse:\n${detail}`);
    }
  }
});

/*
 * There is no resolver in front of these modules — the browser fetches each
 * specifier verbatim off the daemon. A typo'd '../lib/dom.js' is a 404 and a
 * blank page, and only a running browser would ever have caught it.
 */
test('every relative import in the board resolves to a file that exists', () => {
  const scripts = walk().filter((f) => f.endsWith('.js'));
  let checked = 0;
  for (const rel of scripts) {
    const source = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]!);
    for (const spec of specifiers) {
      checked++;
      assert.ok(spec.endsWith('.js'), `board/${rel} imports "${spec}" without an extension — the browser will 404 it`);
      const resolved = path.resolve(path.dirname(path.join(BOARD_DIR, rel)), spec);
      assert.ok(fs.existsSync(resolved), `board/${rel} imports "${spec}", which does not exist`);
    }
  }
  assert.ok(checked > 10, `expected the modules to import each other, saw ${checked} specifiers`);
});

/*
 * The router mounts views by contract, not by duck typing: a view missing
 * `meta` or `mount` throws inside route() and takes the whole shell with it.
 */
test('every view module declares the meta + mount contract', () => {
  const views = walk()
    .filter((f) => f.startsWith('views/') && f.endsWith('.js') && !f.startsWith('views/_'));
  assert.ok(views.length >= 9, `expected every view, found ${views.length}`);
  const ids = new Set<string>();
  for (const rel of views) {
    const source = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8');
    assert.match(source, /export const meta = \{/, `board/${rel} does not export meta`);
    assert.match(source, /export (?:function|const) mount\b/, `board/${rel} does not export mount`);
    const id = /id: '([^']+)'/.exec(source)?.[1];
    const icon = /icon: '([^']+)'/.exec(source)?.[1];
    assert.ok(id, `board/${rel} has no meta.id`);
    assert.ok(icon, `board/${rel} has no meta.icon`);
    assert.ok(!ids.has(id), `two views claim the id "${id}"`);
    ids.add(id);
    // The id is the hash route, so it must survive being put in a URL as-is.
    assert.match(id, /^[a-z][a-z0-9-]*$/, `view id "${id}" is not URL-safe`);
    // A meta.icon with no glyph behind it renders an empty 16px box.
    assert.match(
      fs.readFileSync(path.join(BOARD_DIR, 'lib/icons.js'), 'utf8'),
      new RegExp(`^\\s{2}${icon}:`, 'm'),
      `board/${rel} names icon "${icon}", which lib/icons.js does not define`,
    );
  }
  // main.js has to actually mount each of them.
  const main = fs.readFileSync(path.join(BOARD_DIR, 'main.js'), 'utf8');
  for (const rel of views) assert.ok(main.includes(`./${rel}`), `main.js never imports board/${rel}`);
});

/*
 * mount() returns a TEARDOWN, or nothing. Returning anything else is a live
 * hazard rather than a style nit: route() calls `teardown?.()` before mounting
 * the next view, so a view that returns an object throws inside route() — and
 * because that throw happens before the outlet is redrawn, the shell wedges on
 * the view you were trying to leave and every later navigation throws too.
 * (Observed exactly once, from a view that returned `{ refresh }`.)
 */
test('a view returns a teardown function, or nothing at all', () => {
  const views = walk()
    .filter((f) => f.startsWith('views/') && f.endsWith('.js') && !f.startsWith('views/_'));
  for (const rel of views) {
    const source = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const mount = fnSource(source, 'mount');
    // Only top-level returns of mount() are the contract; a nested arrow's
    // return is its own business, so match at mount()'s own indentation.
    for (const [, returned] of mount.matchAll(/^  return\b\s*([\s\S]*?);?$/gm)) {
      const value = (returned ?? "").trim();
      assert.ok(
        value === '' || value === 'undefined' || value.startsWith('()') || value.startsWith('function'),
        `board/${rel}: mount() returns ${JSON.stringify(value)} — the router calls this as teardown?.()`,
      );
    }
  }
});

/*
 * Phase 2 replaced the stub placeholder with nine real views. A view that
 * reads nothing from the daemon is either a regression to a placeholder or a
 * page that cannot be showing live state, so every one of them has to name at
 * least one route it talks to.
 */
test('every view reads at least one daemon endpoint', () => {
  const views = walk().filter((f) => f.startsWith('views/') && f.endsWith('.js') && !f.startsWith('views/_'));
  for (const rel of views) {
    const source = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8');
    assert.match(source, /['"`]\/api\//, `board/${rel} never calls the daemon — is it still a placeholder?`);
  }
});

/*
 * Every endpoint the board names has to be one the daemon actually routes. The
 * board is served as static files with no build step and no client tests, so a
 * mistyped path is a 404 the operator discovers by clicking, and only in the
 * one view that owns it.
 */
test('every /api path the board calls is a route the daemon serves', () => {
  const server = fs.readFileSync(path.join(path.dirname(BOARD_DIR), 'src', 'server.ts'), 'utf8');
  const seen = new Set<string>();
  for (const rel of walk().filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8');
    for (const m of source.matchAll(/['"`]\/api\/([a-z-]+)/g)) seen.add(m[1]!);
  }
  assert.ok(seen.size >= 12, `expected the board to cover the API surface, saw ${[...seen].join(', ')}`);
  for (const segment of seen) {
    assert.ok(
      server.includes(`seg[1] === '${segment}'`),
      `the board calls /api/${segment}, which src/server.ts does not route`,
    );
  }
});

/*
 * The palette reaches a view's own action through an exported request*()
 * intent rather than by touching its DOM. Those are cross-module calls with no
 * resolver in front of them: a renamed export is `undefined is not a function`
 * at click time, in a dialog, with no stack anyone sees.
 */
test('every palette view-action resolves to an exported function on its view', () => {
  const main = fs.readFileSync(path.join(BOARD_DIR, 'main.js'), 'utf8');
  const calls = [...main.matchAll(/runViewAction\('([a-z-]+)',\s*\(\)\s*=>\s*\w+\.(\w+)\(\)\)/g)];
  assert.ok(calls.length >= 4, `expected the phase-2 palette actions, found ${calls.length}`);
  for (const [, viewId, fn] of calls) {
    const file = path.join(BOARD_DIR, 'views', `${viewId}.js`);
    assert.ok(fs.existsSync(file), `main.js runs a palette action on views/${viewId}.js, which does not exist`);
    assert.match(
      fs.readFileSync(file, 'utf8'),
      new RegExp(`export function ${fn}\\b`),
      `views/${viewId}.js does not export ${fn}(), which main.js calls from the palette`,
    );
  }
});

/*
 * Every other palette intent above is free to fire the instant its view
 * mounts — new task, forge, audit, all of it — because none of them spend
 * money on their own. "Propose improvement…" is the one exception: it
 * reaches POST /api/improve, a real model call. The palette must still land
 * the operator on the button, focused and ready, but it must NOT press it —
 * the mount() -> requestImprove() -> wantImprove path is not allowed to
 * script a click on the propose button, on pain of billing a model call for
 * a palette entry that only opened a page.
 */
test('the doctor palette intent focuses the propose button but never clicks it', () => {
  const source = fs.readFileSync(path.join(BOARD_DIR, 'views', 'doctor.js'), 'utf8');
  assert.match(source, /export function requestImprove\(/, 'doctor.js must still export requestImprove()');

  const block = /if\s*\(wantImprove\)\s*\{[\s\S]*?\n\s*\}/.exec(source)?.[0];
  assert.ok(block, 'doctor.js must have an `if (wantImprove)` block consuming the one-shot intent');
  assert.ok(
    !/proposeBtn\.click\(\)/.test(block),
    'the wantImprove block auto-clicks proposeBtn, which bills a model call before the operator does anything',
  );
  assert.match(
    block,
    /proposeBtn\.focus\(\)/,
    'the wantImprove block should focus the propose button since it may no longer click it',
  );
  assert.match(
    block,
    /toast\.(info|ok)\(/,
    'the wantImprove block should tell the operator to press the button themselves',
  );
});

/*
 * "Every actionable control explains itself" is the board's headline rule and
 * the reason lib/tooltip.js exists at all. Controls built through
 * lib/view.js's button() cannot skip it — the helper always tips. A hand-rolled
 * el('button') can, so each one has to name its tip within a few lines of
 * being created.
 */
test('every hand-built button is given a tooltip', () => {
  for (const rel of walk().filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (!/\bel\(\s*'button'/.test(line)) continue;
      const window = lines.slice(i, i + 12).join('\n');
      assert.match(
        window,
        /\btip\(/,
        `board/${rel}:${i + 1} builds a button without a tip — every actionable control has to say what it does`,
      );
    }
  }
});

/*
 * The no-innerHTML rule is the board's only XSS defence: task titles, prompts,
 * artifact paths and model critiques all come from outside and are all
 * rendered by these modules. A regression here is silent, so it is asserted.
 *
 * This also bans the tools that would let a future assignment slip past a
 * grep for '.innerHTML' or turn attacker-controlled text into script: raw
 * eval, the Function constructor, document.write, Range#createContextualFragment
 * (parses a string to nodes exactly like innerHTML does), and the
 * 'inner' + 'HTML' string-splitting trick some XSS payloads and lazy
 * refactors use specifically to dodge a source grep for the literal name.
 */
test('no board script assigns innerHTML/outerHTML or reaches for an HTML-string escape hatch', () => {
  for (const rel of walk().filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8');
    // Comments are allowed to name the rule they are describing.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\.(inner|outer)HTML\s*=/.test(code), `board/${rel} assigns innerHTML/outerHTML`);
    // Not just an assignment — the string 'innerHTML' has no legitimate
    // reason to appear anywhere in board source at all (outside a comment,
    // already stripped above).
    assert.ok(!/innerHTML/.test(code), `board/${rel} references innerHTML`);
    assert.ok(!/insertAdjacentHTML/.test(code), `board/${rel} calls insertAdjacentHTML`);
    assert.ok(!/\beval\s*\(/.test(code), `board/${rel} calls eval(`);
    assert.ok(!/new\s+Function\s*\(/.test(code), `board/${rel} constructs a Function from a string`);
    assert.ok(!/document\.write/.test(code), `board/${rel} calls document.write`);
    assert.ok(!/createContextualFragment/.test(code), `board/${rel} calls createContextualFragment`);
    // The dynamic-string trick: building the literal "innerHTML" (or
    // "outerHTML") out of concatenated pieces specifically to dodge the
    // plain-text checks above, e.g. el['inner' + 'HTML'] = payload.
    assert.ok(
      !/['"]inner['"]\s*\+\s*['"]HTML['"]/.test(code) && !/['"]outer['"]\s*\+\s*['"]HTML['"]/.test(code),
      `board/${rel} builds "innerHTML"/"outerHTML" as a concatenated string`,
    );
  }
});

/** Every stylesheet and module index.html names has to exist on disk. */
test('index.html only references files that exist', () => {
  const html = fs.readFileSync(path.join(BOARD_DIR, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(refs.length >= 4, 'index.html should link the stylesheets and the entry module');
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(BOARD_DIR, ref)), `index.html references missing board/${ref}`);
  }
});

/**
 * serveBoard resolves any path under board/, so the split into lib/ and
 * views/ only works if subdirectories are served with the right MIME type —
 * a module delivered as application/octet-stream is refused by the browser.
 */
test('the daemon serves board subpaths with the right content type', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const expected: Record<string, string> = {
    '/': 'text/html',
    '/index.html': 'text/html',
    '/theme.css': 'text/css',
    '/components.css': 'text/css',
    '/app.css': 'text/css',
    '/main.js': 'text/javascript',
    '/lib/tooltip.js': 'text/javascript',
    '/lib/store.js': 'text/javascript',
    '/views/board.js': 'text/javascript',
    '/views/receipts.js': 'text/javascript',
  };
  for (const [urlPath, mime] of Object.entries(expected)) {
    const res = await fetch(base + urlPath);
    assert.equal(res.status, 200, `${urlPath} returned ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', new RegExp(mime), `${urlPath} content-type`);
    assert.ok((await res.text()).length > 0, `${urlPath} was empty`);
  }

  // Containment still holds for the nested paths.
  const escape = await fetch(`${base}/lib/../../package.json`);
  assert.ok([403, 404].includes(escape.status), `traversal returned ${escape.status}`);

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await sched.stop();
  store.close();
});

/*
 * ------------------------------------------------------------------ the gate
 *
 * Reported symptom: "I tried approving tasks waiting for approval, but after
 * approval, there was no way to go back to board view."
 *
 * Reproduced against a live daemon with a DOM shim: approving from the drawer
 * leaves the drawer open over the board (correct — it now shows the new
 * status), and the operator's next move is the sidebar's "Board" item. That
 * item called navigate('board') while the hash was already '#/board', which
 * assigns location.hash a value it already holds — no hashchange, no route(),
 * nothing at all. The one control labelled "Board" could not get back to the
 * board. The tests below pin the three pieces of the fix.
 */

/**
 * Source of a top-level `function name(...)`, brace-balanced. The board has no
 * build step and no module loader that could hand these back for inspection,
 * so reading them off disk is the only way to test them without a browser.
 */
function fnSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected a top-level function ${name}()`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`function ${name}() is unbalanced`);
}

/**
 * Compile one extracted function against injected globals. `new Function` is
 * banned inside board/ (asserted above) and used here for the opposite
 * reason: it is the only way to exercise browser-shaped code in a test runner
 * that has no browser, and it executes the file's real text rather than a
 * paraphrase of it that could drift.
 */
function compile<T>(source: string, name: string, env: Record<string, unknown>): T {
  const keys = Object.keys(env);
  const make = new Function(...keys, `${fnSource(source, name)}\nreturn ${name};`);
  return make(...keys.map((k) => env[k])) as T;
}

/*
 * The bug itself. A navigation to the hash we are already on must re-route,
 * because that is what makes every view recoverable from its own nav item:
 * the board hidden behind an open drawer, or a view whose mount() threw and
 * left an empty outlet, both come back with one click on the sidebar.
 */
test('navigating to the hash already in the bar re-routes instead of doing nothing', () => {
  const main = fs.readFileSync(path.join(BOARD_DIR, 'main.js'), 'utf8');

  const assigned: string[] = [];
  let routed = 0;
  const location = {
    _hash: '#/board',
    get hash(): string { return this._hash; },
    set hash(v: string) { this._hash = v; assigned.push(v); },
  };
  const navigate = compile<(id: string, ...p: string[]) => void>(main, 'navigate', {
    location,
    route: () => { routed++; },
  });

  // Same hash: the browser fires no hashchange, so the router has to be called.
  navigate('board');
  assert.equal(routed, 1, 'navigate() to the current view must call route() itself');
  assert.deepEqual(assigned, [], 'it must not re-assign an identical hash');

  // Different hash: assignment only — the hashchange listener does the routing,
  // and routing here as well would double-mount the view.
  navigate('receipts');
  assert.equal(routed, 1, 'navigate() to another view must leave routing to hashchange');
  assert.deepEqual(assigned, ['#/receipts'], 'it must set the new hash');

  // Params count: #/board and #/board/t_ab are different destinations.
  location._hash = '#/board';
  navigate('board', 't_ab12');
  assert.deepEqual(assigned, ['#/receipts', '#/board/t_ab12']);
  assert.equal(routed, 1);
  location._hash = '#/board/t_ab12';
  navigate('board', 't_ab12');
  assert.equal(routed, 2, 'reopening the same task must still remount');
});

/*
 * The guard has to stay in navigate() and nowhere else: a nav item or palette
 * command that sets location.hash by hand would walk straight back into the
 * dead click this test exists to prevent.
 */
test('every view change goes through navigate(), which is the only same-hash guard', () => {
  const main = fs.readFileSync(path.join(BOARD_DIR, 'main.js'), 'utf8');
  const navigateSource = fnSource(main, 'navigate');
  assert.match(navigateSource, /location\.hash === next/, 'navigate() must compare before assigning');
  assert.match(navigateSource, /\broute\(\)/, 'navigate() must re-route on a same-hash navigation');

  // Sidebar items and palette 'go:' commands are the two entry points a
  // wedged operator uses; both must be navigate(), not a raw hash assignment.
  assert.match(main, /item\.addEventListener\('click', \(\) => navigate\(view\.meta\.id\)\)/);
  assert.match(main, /id: `go:\$\{v\.meta\.id\}`[\s\S]{0,240}run: \(\) => navigate\(v\.meta\.id\)/);

  // runViewAction() used to carry its own currentId === id re-route. Two
  // copies of one rule is how they drift apart, so it delegates now.
  assert.doesNotMatch(fnSource(main, 'runViewAction'), /currentId/,
    'runViewAction() must not re-implement the same-hash guard navigate() owns');

  // Outside main.js's router, nothing may drive the hash at all.
  for (const rel of walk().filter((f) => f.endsWith('.js') && f !== 'main.js')) {
    const code = fs.readFileSync(path.join(BOARD_DIR, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/location\.hash\s*=[^=]/.test(code),
      `board/${rel} assigns location.hash directly, bypassing navigate()'s same-hash guard`,
    );
  }
});

/*
 * The drawer opens two ways — a card click, which leaves the hash alone, and
 * #/board/<id> from the palette or a deep link. Closing has to reconcile them,
 * or the URL keeps naming a task nobody is looking at and the sidebar's Board
 * item points somewhere other than where the operator already is.
 */
test('closing the drawer rewrites #/board/<id> back to #/board, via replaceState', () => {
  const source = fs.readFileSync(path.join(BOARD_DIR, 'views', 'board.js'), 'utf8');

  const calls: Array<[unknown, unknown, unknown]> = [];
  const assigned: string[] = [];
  const location = {
    _hash: '',
    pathname: '/',
    search: '',
    get hash(): string { return this._hash; },
    set hash(v: string) { this._hash = v; assigned.push(v); },
  };
  const sync = compile<() => void>(source, 'syncHashToBoard', {
    location,
    history: { replaceState: (...a: [unknown, unknown, unknown]) => { calls.push(a); } },
  });

  location._hash = '#/board/t_ab12';
  sync();
  assert.equal(calls.length, 1, 'a task hash must be rewritten on close');
  assert.equal(calls[0]![2], '/#/board');
  // pushState would make every glanced-at drawer a Back-button stop; assigning
  // location.hash would fire a hashchange and remount the board underneath the
  // close we are in the middle of.
  assert.deepEqual(assigned, [], 'closing the drawer must not fire a hashchange');

  // Already plain, or on another view: nothing to do, and no history churn.
  for (const hash of ['#/board', '#/receipts', '#/doctor/x', '']) {
    location._hash = hash;
    sync();
  }
  assert.equal(calls.length, 1, `syncHashToBoard rewrote a hash it should have left alone`);

  // And it is actually wired into the close path, not just present.
  assert.match(fnSource(source, 'closeDrawer'), /syncHashToBoard\(\)/,
    'closeDrawer() must reconcile the hash');
  assert.match(source, /history\.replaceState\(/, 'the rewrite must use replaceState');
  assert.doesNotMatch(source, /history\.pushState\(/, 'the rewrite must not push a history entry');
});

/*
 * chairSummary carries both a chair's ruling and the council's status lines (a
 * lost seat, an unreachable chair, a lone advisor). The board must label only a
 * ruling as one — and agree with the server-side rule the owner-gate prompt and
 * the CLI use, or the two surfaces would tell the operator different things.
 */
test('only a chair that ruled is labelled a ruling — on the board and server-side alike', async () => {
  type V = { chairSummary: string | null; source?: string; disagreement: boolean; verdict: string; chairModel?: string | null };
  const board = (await import(new URL('../board/lib/store.js', import.meta.url).href)) as {
    chairRuled: (v: V | null) => boolean;
    splitNote: (v: V | null) => string;
    summaryHeading: (v: V) => string;
  };
  const { chairRuled: serverRuled } = await import('../src/verify/council.ts');
  const council = (verdict: string, disagreement: boolean, chairSummary: string | null): V =>
    ({ source: 'council', verdict, disagreement, chairSummary, chairModel: null });
  const cases: Array<[V | null, boolean]> = [
    [council('pass', true, 'the first reviewer misread the diff'), true],
    [council('fail', true, 'the guard was removed'), true],
    [council('split', false, 'a seat answered nothing usable (qwen3.5:2b: unparseable reply: ok) — a lone PASS is not a council decision'), false],
    [council('fail', false, 'single advisor reachable; verdict is not a consensus'), false],
    [council('split', true, 'chair unavailable: connect ECONNREFUSED'), false],
    [council('split', true, 'chair reply unparseable: Sure! Here is my review'), false],
    [council('split', true, 'no independent chair at this rung: local-reason already argued one side'), false],
    [{ source: 'crew', verdict: 'pass', disagreement: false, chairSummary: 'two failures in a row; the fix holds' }, true],
    [{ source: 'crew', verdict: 'fail', disagreement: true, chairSummary: null }, false],
    [{ verdict: 'pass', disagreement: true, chairSummary: 'legacy row with no source column' }, true],
    [council('pass', false, null), false],
    [null, false],
  ];
  for (const [v, ruled] of cases) {
    assert.equal(board.chairRuled(v), ruled, `board: ${JSON.stringify(v)}`);
    assert.equal(serverRuled(v as never), ruled, `server: ${JSON.stringify(v)}`);
  }
  // What the operator reads.
  assert.equal(board.summaryHeading({ ...council('pass', true, 'misread'), chairModel: 'qwen3.5:9b' }), 'chair ruling (qwen3.5:9b)');
  assert.equal(board.summaryHeading(council('pass', true, 'misread')), 'chair ruling');
  assert.equal(board.summaryHeading(council('split', false, 'a seat answered nothing usable (…)')), 'council note');
  assert.equal(board.splitNote(council('pass', true, 'misread')), ' — reviewers split, chair decided');
  assert.equal(board.splitNote(council('split', true, 'chair unavailable: x')), ' — reviewers split, no ruling');
  assert.equal(board.splitNote(council('split', false, 'a seat answered nothing usable (…)')), '');

  const view = fs.readFileSync(path.join(BOARD_DIR, 'views', 'board.js'), 'utf8');
  assert.match(view, /summaryHeading\(v\)/, 'the verdict detail heading goes through summaryHeading()');
  assert.match(view, /splitNote\(v\)/, 'the verdict header goes through splitNote()');
  assert.doesNotMatch(view, /reviewers split, chair decided/, 'no hand-written "chair decided" left in the view');
});

/*
 * POST /api/tasks/:id/approve answers 200 for an approval whose merge was
 * *aborted*: mergeApproved() refuses to force anything, so a conflicting
 * branch comes back { merged: false, reason: 'merge conflict, aborted — …' }
 * beside a task that really is approved. The board used to render that as a
 * flat "Approved", which is how a branch that never landed goes unnoticed.
 *
 * The response shape is taken from the real merge path, not hand-written, so
 * this fails if merge.ts ever renames a field out from under the board.
 */
test('an approval whose merge was aborted reports the abort, not "Approved"', async () => {
  // lib/store.js touches no DOM at module scope, so its selectors import and
  // run straight in the test runner. The specifier is built rather than
  // written literally because tsc will not resolve a plain .js module under
  // board/ (it is browser source, deliberately outside the program).
  type Outcome = { ok: boolean; message: string };
  const { approvalOutcome, rejectionOutcome } = (await import(
    new URL('../board/lib/store.js', import.meta.url).href
  )) as {
    approvalOutcome: (result: unknown, label?: string) => Outcome;
    rejectionOutcome: (result: unknown, label?: string) => Outcome;
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-'));
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'foreman/x');
  fs.writeFileSync(path.join(dir, 'README.md'), 'branch side\n');
  git('add', '-A');
  git('commit', '-qm', 'work');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'main side\n');
  git('add', '-A');
  git('commit', '-qm', 'main moves');

  const store = new Store(':memory:');
  try {
    const task = store.addTask({
      title: 'Conflicting task', prompt: 'do it', kind: 'code',
      runner: 'shell', repo: dir, mergeOnApprove: true,
    });
    const run = store.startRun(task.id);
    store.setRunMeta(run.id, { branch: 'foreman/x', worktreePath: null });
    store.setStatus(task.id, 'awaiting-approval');

    const { merge, registration } = await applyApproval(store, task.id, {});
    assert.equal(merge.merged, false, 'a conflicting merge must not land');
    assert.match(merge.reason, /aborted/);

    // What the drawer and the palette actually put on screen.
    const bad = approvalOutcome({ ...store.getTask(task.id), merge, registration }, 'Approved');
    assert.equal(bad.ok, false, 'an aborted merge must read as a failure, not a success');
    assert.match(bad.message, /foreman\/x/, 'the operator needs the branch name to resolve it');
    assert.match(bad.message, /aborted/, 'the abort reason must reach the operator');
    assert.ok(!/\n/.test(bad.message), 'git stderr must be collapsed to one line for a toast');
    assert.ok(bad.message.length <= 260, `the toast message is unreadably long (${bad.message.length})`);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The other shapes the same 200 can carry.
  assert.deepEqual(
    approvalOutcome({ merge: { merged: true, reason: 'merged 1 commit(s)', branch: 'foreman/y' } }),
    { ok: true, message: 'Approved — merged foreman/y' },
  );
  // A deliberate skip is not a failure and must not shout like one.
  assert.equal(
    approvalOutcome({ merge: { merged: false, reason: 'merge-on-approve disabled for this task', branch: 'b' } }).ok,
    true,
  );
  assert.equal(approvalOutcome({ merge: { merged: false, reason: 'nothing to merge', branch: null } }).ok, true);
  // An approval that closes a run which changed nothing (gate.ts): the reason is the outcome, not a branch that went missing.
  assert.deepEqual(
    approvalOutcome({ merge: { merged: false, reason: NOTHING_TO_CHANGE_CLOSED, branch: 'foreman/z' } }),
    { ok: true, message: 'Approved — closed: nothing to change' },
  );
  // Only as the whole reason's start: a real failure that merely quotes the words still shouts.
  assert.equal(
    approvalOutcome({ merge: { merged: false, reason: 'merge conflict, aborted — resolve foreman/z by hand (was closed: nothing to change)', branch: 'foreman/z' } }).ok,
    false,
  );
  assert.equal(approvalOutcome({ merge: { merged: false, reason: 'not closed: nothing to change', branch: 'foreman/z' } }).ok, false);
  // A tool task lands by registration; a refused registration is a failure too.
  assert.equal(
    approvalOutcome({ registration: { registered: false, reason: 'registration refused: bad manifest' } }).ok,
    false,
  );
  assert.equal(approvalOutcome({ registration: { registered: false, reason: 'not a tool task' } }).ok, true);
  // No merge key at all (an older daemon, or a task with no repo) still works.
  assert.deepEqual(approvalOutcome({ id: 't_1', status: 'done' }, 'Approved "x"'), { ok: true, message: 'Approved "x"' });
  assert.deepEqual(approvalOutcome(null), { ok: true, message: 'Approved' });
  assert.equal(rejectionOutcome({ status: 'rejected' }, 'Rejected').ok, true);
});

/*
 * The /api/state snapshot only ships a truncated stub of task.prompt (server
 * .ts:snapshot — a 50-ticket crew epic with 8KB prompts would otherwise ship
 * that in full on every SSE-driven poll). The drawer's Prompt tab has to read
 * the real text from the /api/tasks/:id detail fetch instead, or every poll
 * while the drawer is open would silently truncate it back to the stub.
 */
test('the drawer prompt panel is filled from the /api/tasks/:id detail fetch, not the snapshot', () => {
  const source = fs.readFileSync(path.join(BOARD_DIR, 'views', 'board.js'), 'utf8');

  // renderDrawerHeader runs off the polled snapshot; it may fall back to the
  // stub while nothing better has arrived, but it must never be the thing
  // that assigns the detail-shaped `detail.task.prompt`.
  const header = fnSource(source, 'renderDrawerHeader');
  assert.match(
    header,
    /dPrompt'\)\.textContent = drawerPromptFull/,
    'renderDrawerHeader must prefer the cached full prompt over the snapshot stub',
  );
  assert.doesNotMatch(
    header,
    /dPrompt'\)\.textContent = task\.prompt\b/,
    'renderDrawerHeader must not assign the truncated snapshot stub directly as the shown text',
  );

  // openDrawer's detail fetch is what actually supplies the full text.
  const open = fnSource(source, 'openDrawer');
  assert.match(
    open,
    /drawerPromptFull = detail\.task\.prompt/,
    'openDrawer must cache the full prompt off the /api/tasks/:id detail response',
  );
  assert.match(
    open,
    /dPrompt'\)\.textContent = drawerPromptFull/,
    'openDrawer must paint the full prompt once the detail fetch resolves',
  );
});

/*
 * Both call sites have to use it. A handler that reaches into r.merge itself
 * is a second opinion about what "approved" means, and only one of the two
 * would get fixed next time.
 */
test('both approve call sites report through the shared gate-outcome selector', () => {
  const main = fs.readFileSync(path.join(BOARD_DIR, 'main.js'), 'utf8');
  const board = fs.readFileSync(path.join(BOARD_DIR, 'views', 'board.js'), 'utf8');
  for (const [name, source] of [['main.js', main], ['views/board.js', board]] as const) {
    assert.match(source, /approvalOutcome\(/, `board/${name} must report approvals through approvalOutcome()`);
    assert.ok(
      !/merge\?\.merged|r\.merge\.branch/.test(source),
      `board/${name} still reads the merge result by hand instead of through approvalOutcome()`,
    );
  }
});

test('the Re-review toast waits for the daemon to finish, then reports the newest verdict', async () => {
  type Outcome = { ok: boolean; message: string };
  type Detail = { reverifying?: boolean; verdicts: Array<{ verdict: string }> };
  const { awaitReview } = (await import(new URL('../board/lib/store.js', import.meta.url).href)) as {
    awaitReview: (id: string, started: unknown, opts: Record<string, unknown>) => Promise<Outcome>;
  };
  const replay = (answers: Detail[]) => {
    let i = 0;
    return { fetchTask: async () => answers[Math.min(i++, answers.length - 1)], wait: async () => {}, attempts: 5 };
  };
  // Rung 0's row lands first; the climb is still going, so it is not the answer.
  assert.deepEqual(
    await awaitReview('t1', { started: true, verdictsBefore: 1 }, replay([
      { reverifying: true, verdicts: [{ verdict: 'split' }, { verdict: 'split' }] },
      { reverifying: false, verdicts: [{ verdict: 'pass' }, { verdict: 'split' }, { verdict: 'split' }] },
    ])),
    { ok: true, message: 'Re-reviewed: pass' },
  );
  const none = await awaitReview('t1', { verdictsBefore: 1 }, replay([{ reverifying: false, verdicts: [{ verdict: 'split' }] }]));
  assert.equal(none.ok, false);
  assert.match(none.message, /finished without a new verdict/);
  // An older daemon never sends the flag: a new row is still reported, and the wait is bounded.
  assert.equal((await awaitReview('t1', { verdictsBefore: 0 }, replay([{ verdicts: [{ verdict: 'fail' }] }]))).message, 'Re-reviewed: fail');
  assert.match((await awaitReview('t1', { verdictsBefore: 0 }, replay([{ verdicts: [] }]))).message, /still running/);

  // A failed poll (a daemon restart, a blip) is not the re-review failing; five in a row is losing touch.
  let calls = 0;
  const flaky = {
    fetchTask: async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return { reverifying: false, verdicts: [{ verdict: 'pass' }, { verdict: 'split' }] };
    },
    wait: async () => {}, attempts: 5,
  };
  assert.deepEqual(await awaitReview('t1', { verdictsBefore: 1 }, flaky), { ok: true, message: 'Re-reviewed: pass' });
  // Four failures in a row is still a blip; the fifth answer is heard.
  let n = 0;
  const shaky = {
    fetchTask: async () => {
      n++;
      if (n <= 4) throw new Error('fetch failed');
      return { reverifying: false, verdicts: [{ verdict: 'fail' }, { verdict: 'split' }] };
    },
    wait: async () => {}, attempts: 10,
  };
  assert.deepEqual(await awaitReview('t1', { verdictsBefore: 1 }, shaky), { ok: true, message: 'Re-reviewed: fail' });
  // Failures between answers do not add up: only five IN A ROW is losing touch.
  let m = 0;
  const intermittent = {
    fetchTask: async () => {
      m++;
      if (m % 2) throw new Error('fetch failed');
      return m < 12 ? { reverifying: true, verdicts: [] } : { reverifying: false, verdicts: [{ verdict: 'pass' }, { verdict: 'split' }] };
    },
    wait: async () => {}, attempts: 20,
  };
  assert.deepEqual(await awaitReview('t1', { verdictsBefore: 1 }, intermittent), { ok: true, message: 'Re-reviewed: pass' });
  const down = { fetchTask: async () => { throw new Error('ECONNREFUSED'); }, wait: async () => {}, attempts: 20 };
  const lost = await awaitReview('t1', { verdictsBefore: 1 }, down);
  assert.equal(lost.ok, false);
  assert.match(lost.message, /Lost touch with the daemon/);

  // And the button uses it, rather than reading a verdict off the 202.
  const view = fs.readFileSync(new URL('../board/views/board.js', import.meta.url), 'utf8');
  assert.match(view, /awaitReview\(task\.id, await post\(`\/api\/tasks\/\$\{task\.id\}\/reverify`\)\)/);
  assert.doesNotMatch(view, /r\.verdict\?\.verdict/);
});
