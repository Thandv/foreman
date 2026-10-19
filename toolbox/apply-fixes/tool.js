// Ported from the author's earlier tools.
//
// Applies verified continuity fixes: exact-string, uniqueness-checked batch
// edits. For each fix: if its "old" string occurs exactly once in the file,
// replace it. If it occurs zero or more-than-once times, SKIP it and report
// why — this tool never guesses which occurrence a fix meant.
//
// The original operated on whatever path a JSON file handed it, run by a
// human from a trusted shell. This port runs unattended inside a task jail,
// so path handling gets the containment check that implies: every path is
// relative to the process's working directory, and is refused outright if it
// is absolute or if it resolves (after following any existing symlinks)
// outside that directory. The containment check is the same realpath
// longest-existing-prefix technique as `safePath` in src/runners/api.ts,
// adapted here to use the tool's cwd as the jail root since a forged tool is
// self-contained and cannot import Foreman's own source.

import fs from 'node:fs';
import path from 'node:path';

class ContainmentError extends Error {}

/** Resolve `rel` against `root`, refusing anything outside it. See file header. */
function safeRelativePath(root, rel) {
  if (path.isAbsolute(rel)) {
    throw new ContainmentError(`absolute paths are refused: ${rel}`);
  }
  const realRoot = fs.realpathSync(root);
  const resolved = path.resolve(realRoot, rel);

  // Refuse outright if the path as named is itself a symlink — dangling or
  // not. lstat (never followed) is the only way to see this: fs.existsSync
  // on a *dangling* symlink follows the link to check its target and
  // reports "does not exist", which used to make the longest-existing-
  // prefix walk below treat the link's own on-disk path as a hole to climb
  // past. The "real" path it then reconstructed was the link's own
  // (un-followed) location — inside the jail, so containment passed — while
  // the actual write later followed the link to wherever it pointed,
  // including outside the jail entirely (proven exploit). A symlink to an
  // existing file has the same shape of problem in miniature: its target
  // could be swapped out from under the tool between this check and the
  // write. Neither case is something this tool ever needs to do, so any
  // symlink at the final path component is refused before anything else.
  const namedLstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (namedLstat && namedLstat.isSymbolicLink()) {
    throw new ContainmentError(`refusing to write through a symlink: ${rel}`);
  }

  const tail = [];
  let existing = resolved;
  // lstat, not existsSync: keeps the same "does the link itself exist"
  // semantics as the check above for every ancestor this walk climbs past,
  // so a dangling symlink one directory up can't reopen the same hole.
  while (fs.lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const real = tail.length ? path.join(realExisting, ...tail) : realExisting;
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ContainmentError(`path escapes the working directory: ${rel}`);
  }
  return real;
}

function truncate(s, n = 70) {
  return s.length > n ? s.slice(0, n) : s;
}

function countOccurrences(text, needle) {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

function replaceOnce(text, oldStr, newStr) {
  const idx = text.indexOf(oldStr);
  if (idx === -1) return text;
  return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
}

function applyFixes(files, cwd) {
  // Resolve and containment-check every path FIRST, before any file is
  // touched — a refusal on file 3 of 5 must not leave files 1 and 2 half-edited.
  const realPaths = files.map((entry) => safeRelativePath(cwd, entry.path));

  // Likewise read every file before writing any: a missing or unreadable
  // file late in the batch must fail the call with nothing written, not
  // after earlier files were already edited. Keyed by real path, so two
  // entries naming the same file see each other's edits in order.
  const texts = new Map();
  for (let i = 0; i < files.length; i++) {
    if (texts.has(realPaths[i])) continue;
    try {
      texts.set(realPaths[i], fs.readFileSync(realPaths[i], 'utf8'));
    } catch (err) {
      throw new Error(`cannot read ${files[i].path}: ${err.code || err.message} (no file was modified)`);
    }
  }
  const changedPaths = new Set();

  let applied = 0;
  let skipped = 0;
  const report = [];

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const real = realPaths[i];
    let text = texts.get(real);
    let changed = false;
    for (const fix of entry.fixes) {
      const { old: oldStr, new: newStr } = fix;
      const n = countOccurrences(text, oldStr);
      if (n === 1) {
        text = replaceOnce(text, oldStr, newStr);
        applied++;
        report.push({ path: entry.path, old: truncate(oldStr), status: 'APPLIED' });
        changed = true;
      } else if (n === 0) {
        if (newStr && countOccurrences(text, newStr) >= 1) {
          skipped++;
          report.push({ path: entry.path, old: truncate(oldStr), status: 'ALREADY' });
        } else {
          skipped++;
          report.push({ path: entry.path, old: truncate(oldStr), status: 'NOTFOUND' });
        }
      } else {
        skipped++;
        report.push({ path: entry.path, old: truncate(oldStr), status: `AMBIGUOUS×${n}` });
      }
    }
    texts.set(real, text);
    if (changed) changedPaths.add(real);
  }
  for (const real of changedPaths) fs.writeFileSync(real, texts.get(real));

  return { applied, skipped, report };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function validateInput(args) {
  if (!args || typeof args !== 'object' || !Array.isArray(args.files)) {
    return 'input must be a JSON object with a "files" array';
  }
  for (const f of args.files) {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !Array.isArray(f.fixes)) {
      return 'each files[] entry needs a string "path" and a "fixes" array';
    }
    for (const fix of f.fixes) {
      if (!fix || typeof fix.old !== 'string' || typeof fix.new !== 'string') {
        return 'each fixes[] entry needs string "old" and "new"';
      }
    }
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    process.stderr.write(`stdin was not valid JSON: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const problem = validateInput(args);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = applyFixes(args.files, process.cwd());
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    if (err instanceof ContainmentError) {
      process.stderr.write(`refused: ${err.message}\n`);
    } else {
      process.stderr.write(`${err.message}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
