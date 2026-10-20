# Security policy

## Reporting a vulnerability

Report vulnerabilities **privately**, through GitHub's **"Report a vulnerability"** button on this
repository's **Security** tab. Please do not open a public issue, pull request or discussion for a
security problem.

Include what you found, the version or commit, how to reproduce it, and what an attacker gains.

## Scope

In scope — weaknesses in the parts of Foreman that are meant to contain work or keep it from landing
unapproved:

- **The daemon**: its HTTP API and board server (`src/server.ts`), task admission
  (`src/security/admit.ts`) and the queue.
- **Worker isolation**: the per-run worktree or scratch-directory jail, the environment a worker or
  test command is given, and the `api` runner's file and shell tools.
- **The sandbox** (`FOREMAN_SANDBOX`, `src/security/sandbox.ts` and its profiles): a sandboxed
  command doing something the README says it cannot.
- **The core guard** (`PROTECTED_PATHS`, `src/security/coreGuard.ts`): a change to a protected path getting through without the
  checks it should meet.
- **Merge and landing**: anything reaching your repository without an approval, or something other
  than what was approved landing.

## Current limits (not vulnerabilities)

These are documented in the README and are known; a report that only restates them is out of scope,
but a way to make them worse than described is in scope.

- **The `claude-code` and `codex-cli` workers themselves are not sandboxed yet.** A worker session
  runs as you, with your files and the daemon's API in reach. Only test commands, playbook checks,
  `shell` tickets, the `api` runner's shell and tool calls, the post-merge check and a worker's own
  suite run (`src/verify/testSlot.ts`) run under the sandbox. `FOREMAN_SANDBOX=all` currently behaves as `tests`.
- The HTTP API has **no authentication**. It binds to loopback only unless
  `FOREMAN_ALLOW_REMOTE=1` is set; it is a local tool.
- The sandbox is macOS-only (`sandbox-exec`), does not limit CPU, memory or disk, and leaves the
  jail (including a worktree's whole `.git`) readable. Loopback services not on the closed-port
  list are reachable. See "What it does NOT cover" and "Known limits of the test sandbox" in the
  README.
- Foreman's own git calls in a jail and dependency provisioning (`npm ci`) are not sandboxed.

## Response

Foreman is a personal project maintained by one person. Reports are handled on a best-effort basis:
there is no guaranteed response time and no bug bounty. Where possible you will get an
acknowledgement once the report has been read, and credit in the fix if you want it.
