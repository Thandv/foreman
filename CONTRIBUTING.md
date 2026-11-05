# Contributing to Foreman

Foreman is parallel agent mission control: you queue tasks, it runs them concurrently in isolated
workers (a git worktree or scratch directory per run), verifies each result with tests and a
multi-model council, and parks everything at a human gate. By default nothing merges until a person
approves it (an opt-in owner gate can approve for you). The [README](README.md) is the quick start. For
the design read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), for running it [docs/OPERATING.md](docs/OPERATING.md),
and for every setting [docs/configuration.md](docs/configuration.md); read the parts you intend to change.

## Setup

Foreman is dependency-free at runtime and uses Node built-ins only (`node:sqlite`, `node:http`,
native TypeScript execution). You need **Node 24 or later** (`engines` in `package.json`; `.node-version`
pins 24 for nvm, fnm and similar) and git.
A Node under your home (nvm) or in a temp dir works in the test sandbox: its install root is
opened read-only for sandboxed commands, and `foreman doctor` says so if it cannot be.

```bash
npm ci            # dev-only dependencies: the TypeScript compilers and @types/node
npm run verify    # typecheck, then the whole suite, then scripts/checks/*.ts
```

`npm run verify` is the gate. It must end with `verify: PASS` before you open a pull request.
`npm test` runs the suite alone; `npm run typecheck:tsc` runs the reference compiler when the
native one (`tsgo`) and `tsc` might disagree.

The typecheck step (`tsgo --noEmit`, in `scripts/verify.sh`) reads `tsconfig.json`, which has `strict` and
`noUncheckedIndexedAccess` plus five more flags. Each makes verify fail on:

- `noUnusedLocals`: an unused local, or an unused import.
- `noUnusedParameters`: an unused function parameter (prefix it with `_` if the signature needs it).
- `noFallthroughCasesInSwitch`: a non-empty `switch` case that falls through into the next one.
- `noImplicitReturns`: a function that returns a value on some paths and falls off the end on others.
- `noImplicitOverride`: a subclass member that overrides a base member without the `override` keyword.

The OS sandbox (`FOREMAN_SANDBOX`, default `tests`) exists only on macOS, where it uses `sandbox-exec`
(`sandboxAvailable()` in `src/security/sandbox.ts`). On any other platform, including Linux, `foreman serve`
refuses to start and a sandboxed command is refused rather than run unsandboxed, so set `FOREMAN_SANDBOX=off`
there. The test suites set it to `off` themselves, so `npm run verify` does not need a sandbox. See
"The sandbox" in [docs/security.md](docs/security.md#the-sandbox-foreman_sandbox).

A version manager that puts a shim or symlink directory on `PATH` instead of a node install (volta, fnm)
is not opened automatically: name that directory in `FOREMAN_SANDBOX_RO` before starting `foreman serve`
(the directory itself, not your home); see [the sandbox](docs/security.md#the-sandbox-foreman_sandbox).

## Proposing a change

- **Open an issue first** for anything non-trivial — a new feature, a behaviour change, anything
  touching the gate, the merge path, the sandbox or the core guard. Agreeing on the shape before
  the code saves both of us a rewrite. Typo and small doc fixes can go straight to a pull request.
- **Keep pull requests small and focused**: one change, roughly 300 lines of diff or fewer. A larger
  change is easier to review as a sequence of small ones.
- **Add tests that fail without your change** and pass with it. A bug fix comes with the test that
  reproduces the bug.
- **Run `npm run verify` and make sure it is green** before you push.
- **No drive-by changes**: no unrelated refactors, renames or reformatting in the same pull request.
- Match the existing style: built-ins only at runtime (no new runtime dependencies), comments that
  say why rather than what.

Every pull request is reviewed by the maintainer, and only the maintainer merges.

## Quality bar

- Behaviour is pinned by tests; a change to behaviour changes a test on purpose, and says so.
- Safety properties do not regress: admission blocks, the worker jail, `PROTECTED_PATHS` (the core
  guard), merge-only-on-approval and the sandbox stay exactly as strict.
- Errors are surfaced, never swallowed; a failed run leaves a trace in the ledger.
- Documentation that describes behaviour (the README, `docs/`, command help) is updated in the same change.

## Rules for specific changes

- **Tests**: put a new test in a new file named by the behaviour it pins (`test/gate-env.test.ts`,
  not `test/misc.test.ts`). Import `./env.ts` first (it gives the file a private `FOREMAN_HOME`, clears
  inherited `FOREMAN_*` variables and turns the sandbox off). Use no `/tmp` literal: make a directory with
  `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, and register its removal (`t.after`, or an exit hook).
- **New `FOREMAN_*` setting**: add its row to [docs/configuration.md](docs/configuration.md). The
  `scripts/checks/config-truth.ts` check enforces this.
- **New check**: add a `scripts/checks/*.ts` file; never edit `scripts/verify.sh`. Verify runs each one
  as `node <file>` after the suite (see `scripts/checks/README.md`).
- **`PROTECTED_PATHS`** (`src/security/coreGuard.ts`): a change to the list, or to any file on it, needs
  a ticket with `allowCore`, and a maintainer approves and lands it: the owner model never may (`src/gate.ts`).

## Licence of contributions

Foreman is licensed under the [Apache License 2.0](LICENSE). Per section 5 of that licence, any
contribution you intentionally submit for inclusion is licensed under the same terms, without any
additional terms or conditions. There is no contributor licence agreement (CLA) to sign.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
