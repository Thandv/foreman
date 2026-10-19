#!/usr/bin/env bash
#
# The check to run before committing — and the reason it is a script.
#
# Twice in one session I ran `npm test | grep -E "pass|fail" && git commit` and
# pushed red. A pipeline's exit status is its LAST command's, so `grep` matching
# the summary line, or `head` closing the pipe, reports success no matter what
# the suite did. Both times the tests were genuinely failing and the commit went
# through on a passing grep.
#
# No check's status passes through a pipe. Each check's own exit status is what decides.
# That holds for scripts/checks/*.ts too: each runs as `node <file>`, its status read
# directly. The suite's own status wins when the suite failed; otherwise the first
# failing check's. A failing suite still ends on "verify: FAIL (tests exited N)".
# No check can hold verify forever: each is stopped (with any processes it started)
# after VERIFY_CHECK_TIMEOUT_SECS, default 300, and fails as "timed out".
set -euo pipefail

cd "$(dirname "$0")/.."

check_timeout="${VERIFY_CHECK_TIMEOUT_SECS:-300}"
case "$check_timeout" in
  '' | *[!0-9]* | 0 | 0*) echo "verify: FAIL (VERIFY_CHECK_TIMEOUT_SECS must be a positive whole number of seconds)"; exit 2 ;;
esac

echo "typecheck…"
# The native compiler (tsgo, @typescript/native-preview): the same diagnostics as
# tsc in a fraction of the time. By its path, not through npx: with no local
# binary `npx tsgo` asks the registry for whatever package is named "tsgo", and
# `npx --no` still makes that request before it refuses. A missing compiler
# fails the step with the shell's own status; nothing falls back to tsc
# (`npm run typecheck:tsc` is the reference, run by hand).
tsc_status=0
./node_modules/.bin/tsgo --noEmit --pretty false || tsc_status=$?
if [ "$tsc_status" -ne 0 ]; then
  echo "verify: FAIL (typecheck exited $tsc_status)"
  exit "$tsc_status"
fi

echo "tests…"
# The full output goes to a file and the suite's own exit status is captured
# directly — no pipe to mask it. A tail alone kept only summary lines, so a
# failing gate (and the post-merge check and re-check that run this) lost the
# assertion that failed.
out="$(mktemp "${TMPDIR:-/tmp}/foreman-verify.XXXXXX")" || { echo "verify: FAIL (could not create a temp file)"; exit 1; }
trap 'rm -f "$out"' EXIT
status=0
npm test >"$out" 2>&1 || status=$?
# The result is decided. Nothing printed below may change it, so errexit is off
# from here: a grep that matches nothing must not turn a pass into a failure, nor
# a failing suite's status into grep's.
set +e
# The counts and a verdict, NOT the tail. The runner prints every TODO test's
# assertion in full at the very end of a passing run, so a 12-line tail of a
# green suite was a stack trace and an ERR_ASSERTION with no word that it had
# passed — and was read as a failure by the person who ran it.
# Colour codes are stripped first: with FORCE_COLOR set (it is, inside a
# Foreman test run) every count line starts with an escape sequence, and the
# run printed "verify: PASS" with no counts at all.
# One function for both outcomes: a failing run prints the same count lines.
print_counts() {
  plain() { sed -E $'s/\x1b\\[[0-9;]*m//g' "$out"; }
  plain | grep -E '^(ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ' | tail -8
  todo="$(plain | grep -E '^(ℹ|#) todo [0-9]+' | tail -1 | grep -oE '[0-9]+$')"
  if [ -n "$todo" ] && [ "$todo" -gt 0 ]; then
    echo "($todo known-gap test(s) are marked TODO: the runner reports them, they are not failures)"
  fi
}
print_counts
# Checks: scripts/checks/*.ts, sorted, each run as `node <file>` with its status
# read directly. They run even when the suite failed, and print before the
# failure block below so the assertions stay in the last lines. Each failing
# check is named; the first one's status is kept.
# The list is a glob, not `ls` output, so a name with a space stays one file; C
# collation keeps the order the same on every machine; no match is no checks.
list_checks() {
  local LC_ALL=C
  shopt -s nullglob
  checks=(scripts/checks/*.ts)
  shopt -u nullglob
}
checks=()
list_checks
# One check, bounded: node runs the file in its own process group, and on the
# deadline the whole group is killed (a child left behind would keep verify's
# output open). Ctrl-C and SIGTERM reach the group too, and then stop verify
# itself. The runner prints the FAIL line itself, so a timeout is never mistaken
# for a check's own exit code.
run_check() {
  node -e '
    const { spawn } = require("node:child_process");
    const { constants } = require("node:os");
    const [file, secs] = process.argv.slice(1);
    const child = spawn(process.execPath, [file], { stdio: "inherit", detached: true });
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; group("SIGKILL"); }, Number(secs) * 1000);
    let stopped = null;
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stopped = sig; group(sig); });
    child.on("error", (e) => { clearTimeout(timer); console.log(`verify: FAIL (check ${file} could not start: ${e.message})`); process.exit(1); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      group("SIGKILL");
      if (stopped) { process.removeAllListeners(stopped); process.kill(process.pid, stopped); return; }
      if (timedOut) { console.log(`verify: FAIL (check ${file} timed out after ${secs}s)`); process.exit(124); }
      const c = code ?? 128 + (constants.signals[signal] ?? 0);
      if (c !== 0) console.log(`verify: FAIL (check ${file} exited ${c})`);
      process.exit(c);
    });
  ' "$1" "$check_timeout"
}
check_status=0
for f in ${checks[@]+"${checks[@]}"}; do
  run_check "$f"
  c=$?
  if [ "$c" -ne 0 ] && [ "$check_status" -eq 0 ]; then
    check_status=$c
  fi
done
if [ "$status" -eq 0 ]; then
  [ "$check_status" -eq 0 ] && echo "verify: PASS"
  exit "$check_status"
else
  echo "--- last 80 lines ---"
  tail -80 "$out"
  # Every failing test LAST, so a reader of only the end of this output (the
  # gate's critique keeps the last 40 lines) still gets the assertions: TAP
  # `not ok` blocks (to the next test line), and the spec reporter's "failing
  # tests" section. Capped inside awk, not with `| head`: under pipefail a
  # closed pipe would replace the suite's status with SIGPIPE's.
  echo "--- failing tests ---"
  awk '
    function out(line) { if (n++ < 2000) print line }
    /^[[:space:]]*not ok / { tap = 1; out($0); next }
    tap && /^[[:space:]]*(ok|not ok) / { tap = 0 }
    tap && /^[[:space:]]*# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) / { tap = 0 }
    tap { out($0) }
    /failing tests:/ { spec = 1 }
    spec { out($0) }
  ' "$out"
  # One last line a reader cannot miss, after the assertions.
  echo "verify: FAIL (tests exited $status)"
fi
# The suite's own status, exactly: the printing above must never decide it.
exit "$status"
