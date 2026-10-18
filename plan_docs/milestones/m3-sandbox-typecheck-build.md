# M3 — Sandbox, typecheck and build

**Goal:** Catch "merges cleanly but breaks". The headline capability.

**Exit criteria:** branch A renames an exported function, branch B adds a call
to the old name; both build green alone; Interlock flags the pair with a
typecheck Finding and correct dual-branch attribution in under 3 minutes, with
zero false positives on the non-conflicting fixture pairs.

**Depends on:** M2.

The compiler is the detector. A stale call site after a rename is already
reported by `tsc` as `TS2304: Cannot find name 'processRefund'`, with a file and
a line — so there is no hand-built matcher to write for this class of problem.

What that leaves is the part the compiler does not do, and it is the real work of
this milestone: knowing which errors are _new because of the merge_, and knowing
_which branch caused which half_ of each one.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [x] **Docker sandbox runner**
      **Files:** `packages/core/src/sandbox/` (the runner and its `index.ts`), `packages/core/src/index.ts`, `packages/core/test/sandbox-runner.test.ts`, `packages/shared/src/config.ts` (default image), `packages/shared/src/errors.ts` (codes), ADR-0007, `docs/threat-model.md` (T2, T9), `docs/architecture.md`
      **What:** the one primitive every execution analyzer uses: run an argument array against a merged tree inside Docker, under fixed isolation and limits, and return what happened. No analyzer is built here.

  The build and test analyzers run merged, agent-written code nobody has
  reviewed. Hard rule 2 says it never runs on the host, so the runner is the
  only way it runs at all. How a check writes — the tree, a tmpfs, a per-slot
  cache — is ADR-0007, written before the code.

  **Done when:**
  - _Isolation,_ each shown by a command run in the container: connecting
    to an outside address fails; the uid is not 0; `CapEff` in
    `/proc/self/status` is 0 and `NoNewPrivs` is 1; a write to the tree gets
    `EROFS` and a write to the tmpfs succeeds; no host environment variable
    reaches the container, and there is no Docker socket in it.
  - _Limits,_ each killing the container and saying which fired: a fork bomb
    is held at the PID limit and reported as it; a memory hog is killed and
    reported as out of memory, read from `docker inspect` before the container
    is removed, since exit 137 alone cannot tell an OOM kill from a kill
    signal; a busy loop is killed at the wall-clock limit as
    `SANDBOX_TIMEOUT`; aborting the run's `AbortSignal` kills the container.
  - _Normal results:_ a non-zero exit is a result — exit code, stdout and
    stderr capped with a flag when either was cut, both redacted — never an
    error. What the exit means is the analyzer's call.
  - _Infrastructure:_ Docker not installed, its daemon down, the image absent
    and a mount Docker cannot reach each raise `SANDBOX_UNAVAILABLE` with a
    remedy. None falls back to the host and none pulls: every run passes
    `--pull=never`.
  - _Orphans:_ every container carries a label naming its owner; one left by a
    crashed daemon is found by that label and removed by `SandboxRunner.reapOrphans`.
  - _Pinning:_ the default image in `config.ts` is pinned by digest, as T9
    already claims.

  **Edge cases and the tests they need:**
  - A command string — a `.interlock.json` toolchain override — reaches Docker
    only as `['sh', '-c', command]`, run inside the container. A test runs one
    full of shell metacharacters and shows nothing on the host changed.
  - A mount path with a comma or a quote: `--mount` is CSV, so fields are
    quoted rather than joined. A test mounts such a path.
  - A writable mount of anything the host later reads or runs is refused:
    writable mounts only under the caller's cache root, which must not overlap
    the tree or any read-only source. A socket or device is never a source.
  - Dependency mounts sit read-only at their tree-relative positions under the
    tree's mount point, so a relative pnpm workspace link resolves into the
    merged tree, not the user's. The layout calculation is not built here.
  - The daemon running as root: refused with a remedy rather than run as a
    fixed uid, since a fixed uid cannot read the 0700 data dir without
    loosening it (ADR-0007).
  - Output over the cap, an aborted run, an orphan reaped, a command that
    exits non-zero: each its own test.
  - Containers made by tests carry the label and are removed in `afterEach`,
    even when the test failed. The test image is pinned by digest too.

  **Failure modes:** a container left running after its run — the runner
  removes it on every path, including create and start failures; a limit
  reported as an ordinary exit — classification reads `docker inspect` before
  removal; an unreachable Docker reported as a clean run — it is an infra
  error, never a result.

  **Constraints:**
  - Hard rule 2, including tests: no test runs a command outside Docker "to
    compare".
  - Hard rule 8: where flags differ from ADR-0004, raise it rather than choose.
  - No shell on the host: `execFile` and `spawn` with argument arrays only.
  - Hard rule 7: no new dependency in `core`; the Docker CLI is driven
    directly. The runner is the second process call site, listed beside the
    git runner in `test/support/call-sites.ts`.
  - No silent skips: the sandbox suite reports why it skipped, and fails on
    Linux CI when Docker is missing.
  - Not built here: wiring `SandboxRunner.reapOrphans` into daemon start, the
    per-slot cache's eviction wipe, and the dependency mount layout. Each is
    the first task that needs it: the build analyzer for the first two, the
    typecheck runner's sandboxed counterpart for the third.

- [x] **Toolchain detection**
      **Files:** `packages/core/src/sandbox/toolchain.ts`, `sandbox/index.ts`, `src/index.ts`, `sandbox/toolchain.test.ts`, `packages/core/test/toolchain.test.ts`, `docs/architecture.md`
      **What:** from a tree in the shadow, work out the package manager (and the version `packageManager` pins), the install command a slow path would use, the TypeScript projects to typecheck and the build script — answered per capability, with the repository's `.interlock.json` `toolchain` override replacing detection for each command it sets.

  Read from the object database by tree id through `GitRunner` — `ls-tree -r -l`
  once, then `cat-file blob` — never from disk. It needs no pool slot, so it
  answers for the merge, either side and the merge base alike; and a symlink is a
  blob holding a path, so a `package.json` linked at a key file is refused by its
  mode (`120000`) and never followed, where `fs.readFile` would have read the key.
  A submodule entry is refused the same way.

  The package manager comes from Corepack's `packageManager` first, then the
  lockfile. `pnpm-lock.yaml` is pnpm, `package-lock.json` and
  `npm-shrinkwrap.json` npm, `yarn.lock` Yarn: Berry when `packageManager` names
  major 2 or later, when `.yarnrc.yml` exists, or when `yarn.lock` opens with
  `__metadata:`, asked with `git grep` so a megabyte lockfile is never read into
  memory. Berry is supported only with `nodeLinker: node-modules`; unset, it is
  Plug'n'Play. Install is `pnpm install --frozen-lockfile`, `npm ci`,
  `yarn install --frozen-lockfile` or `yarn install --immutable`; build is
  `<manager> run build` when the root has a `build` script, and `none` when it has
  not.

  Typecheck needs `typescript` among the root's or a workspace package's
  dependencies, and projects: a root `tsconfig.json`, unless it is a solution
  (`"files": []` plus `references`), whose referenced projects are taken instead,
  nested solutions expanded; with no root tsconfig, each workspace package's own.
  Workspace packages come from each manager's own source — `pnpm-workspace.yaml`'s
  `packages:` for pnpm, the `workspaces` field for npm and Yarn — so a package the
  manager would not install is never named. The YAML is read by a small reader
  that takes a block list of plain or quoted scalars, or a one-line flow list,
  and refuses anything richer rather than reading part of it.

  Edge cases and failure modes, each reported as `TOOLCHAIN_UNSUPPORTED` with a
  reason naming what was found: no `package.json` (naming `deno.json` when that
  is what stands in for one); Deno; Bun by lockfile or by `packageManager`;
  `.pnp.cjs`; two managers' lockfiles that `packageManager` does not settle; a
  `packageManager` that disagrees with the only lockfile; neither a lockfile nor
  `packageManager` — never a guess at npm; a malformed or unknown
  `packageManager`; a manifest over the size cap, malformed, not an object, a
  symlink or a submodule; JSONC the reader cannot parse; a reference that leaves
  the tree, names nothing in it, has no path, or nests past eight; a workspace
  tsconfig that is a symlink, which the language service would follow on disk;
  and JavaScript with no tsconfig, or no `typescript` dependency, for typecheck
  alone. A reason never carries a value, key or nested path a file chose.

  **Done when:** each of pnpm, npm, Yarn classic and Yarn Berry with
  `node_modules` linking is detected with its manager, version, typecheck
  projects, build and install command; each unsupported case above answers its
  reason, and JavaScript without a tsconfig still detects its build; a
  solution-style root yields its referenced projects and a monorepo without one
  yields its workspace packages' tsconfigs; detection on a fixture built from this
  repository's own manifests names its five referenced packages; an override of
  one command changes that command alone and each answer says whether it was
  detected or overridden; an oversized `package.json` is refused with no
  `cat-file` run; `__proto__` keys cannot supply a field; JSONC comments and
  trailing commas in `tsconfig.json` parse; a symlinked `package.json` or
  `tsconfig.json` is refused and its target never appears in the answer; and a
  second detection of a tree whose manifests did not change runs one `ls-tree`
  and nothing else.
  **Constraints:** detection never executes anything — no `pnpm --version`, no
  `node -e`, no config file evaluated, here or anywhere. Override commands are
  opaque: validation in `shared` proves they are strings, and here they are
  carried whole, never split or interpreted, to reach execution only through the
  sandbox runner. No new dependency in `core` (hard rule 7), so no YAML parser.
  Workspace globs are matched by scanning, never translated to a regular
  expression, because a pattern is repository content. The cache keys on the
  blob ids of what was read and of every manifest whose mere presence changes
  the answer; keying on the tree id would miss every check, since almost every
  tree is new.

- [x] **Typecheck runner**
      **Files:** `packages/core/src/analyzers/typecheck.ts`, `packages/core/src/analyzers/typecheck-service.ts`, `packages/core/src/analyzers/typecheck-worker.ts`, `packages/core/src/git/worktree-pool.ts`, `packages/core/package.json`, `packages/shared/src/config.ts`, `packages/daemon/src/scheduler/run-pipeline.ts`, `packages/daemon/src/store/verdict-key.ts`, `scripts/typecheck-bench.ts`, ADR-0008
      **What:** host the TypeScript language service inside the daemon, one live instance per hot pool slot (ADR-0005), each in a worker thread of its own (ADR-0008). A check of a slot returns structured diagnostics; later checks of the same slot reuse the service's incremental state. Do not spawn `tsc` per check: the measured process floor is 436 ms, against 350 ms of real work for an incremental check. And make the daemon run `ANALYZER_PIPELINE` generically. This task adds no typecheck analyzer to that list: raw diagnostics include every pre-existing error, and reporting them before the baseline differ exists would blow the false-positive budget on day one.

  Rewritten before starting, from the issue. **Diagnostics** are code,
  category, the flattened message, the file relative to the slot, start and
  length, and one-based line and column, as `tsc` prints them. Option and
  global diagnostics — a broken tsconfig, a missing `lib` — are a separate
  list from file diagnostics: they say the project cannot be judged, not that
  the code is wrong, and the baseline differ and infra handling treat them
  differently. A diagnostic in a file outside the slot (a default `lib` file)
  describes the environment and goes with them. **The comparison is `tsc`'s
  own order and gates**: syntax errors stop the semantic check, options and
  global errors stop it too, and declaration diagnostics are reported under
  `--noEmit` only when `declaration` or `composite` is on and nothing else
  was found. **A solution-style tsconfig is checked through its references**,
  depth first, each project once, a cycle tolerated; a reference is read as
  its sources, as an editor reads it, since a slot holds no build output. The
  compiler skips a referenced project's sources' semantic check in the
  programs that import them, so each is judged under its own project's
  options, as `tsc -b` judges it; a file two unrelated projects both list is
  reported under each.

  **Incremental state** is the language service's programs and a semantic
  diagnostics builder per project, the propagation `tsc --incremental` uses.
  A file of the tree is versioned by its blob id in the merged tree's listing:
  it names the content, so a slot rewritten whole keeps what did not change. A
  file under `node_modules` is versioned by the dependency checkout's install —
  a hash of the package managers' records under each install root, the
  checkout's own and each lockfile's directory, read before and after every
  check — or, where no record exists, by its inode, size and times, read on
  every check. A tsconfig is read again on every check, as an added file changes what
  `include` matches, and a reading equal to the last is answered with the last
  one's object: the language service compares a reference's reading by
  identity, and a fresh one rebuilds every program on every check. Declaration
  diagnostics are cached per file and forgotten for each file the builder says
  a change affected; left uncached, they type-check every file on every check.

  **Read confinement** is explicit in the host, never through `ts.sys`. The
  compiler sees one tree: the slot as the merged tree's `ls-tree` listing has
  it, never as its directory — a slot keeps what `reset --hard` leaves,
  `.tsbuildinfo` and an earlier tree's build output — with `node_modules` in it
  answered from the same path in the dependency checkout, and a `node_modules`
  the tree commits left out. A link the tree holds is followed through the
  listing. A path in the dependency checkout that leads out of `node_modules`
  into the checkout's own source — a pnpm workspace link — is answered by the
  tree at the same path, so a sibling package is checked as merged, not as the
  user has it, a file only the merge added included. Anything else outside the slot, the dependency
  checkout's `node_modules` and Interlock's own `lib` directory does not exist:
  a `..` or absolute path in `include`, `files`, `paths` or `typeRoots`, a link
  in the slot pointing out of it, a link in `node_modules` pointing out of the
  checkout. Include patterns are expanded by `ts.matchFiles`, over the
  confined listings, so the file set is `tsc`'s.

  **The registry** keeps one service per tree path, at most
  `DEFAULT_LIVE_SERVICES` (the pool size) live, least recently used stopped
  first and a busy one never; one check per service at a time. A service is
  rooted at a path, not at a slot, so a later task can root one at a merge base
  or one side. The pool calls `onEvict` before it removes a slot's files, and
  awaits it; a failing hook is logged and the eviction goes ahead. The daemon
  stopping is `close()`, which stops every worker.

  **Cancellation** crosses threads through one shared `Int32`, polled by the
  compiler's cancellation token, since the check is synchronous and nothing
  posted to the worker is read until it returns. A cancelled check keeps the
  service; the next check is whole. Under `isolatedModules` the importers an
  edit re-checks are checked in the pass over every file, and the token
  reaches that pass too.

  **Deadline and grace.** Each check has a deadline, `typecheck.deadlineMs`,
  from when it is sent. At it, or when its run is superseded, the flag is set
  and the compiler stops where it stands, keeping its program; a worker still
  running `typecheck.graceMs` later is terminated, since the compiler does not
  poll while it builds a program, and a check queued behind it starts a new
  service.

  **Outcomes.** `checked`, `cancelled`, `timeout`, `out-of-memory` and
  `crashed` are told apart; a worker that did not start, a released or closed
  service, and an install that changed under the check are one
  `infra-failure` carrying its reason. None is a Finding, and a check resolves
  to one of them whatever its worker does.

  **Workers** start with an empty environment — the compiler reads `NODE_ENV`
  as it loads — and the heap limit `typecheck.maxHeapMb`, at least 128 MiB,
  refused below it when the config is read and by the registry, since V8
  aborts the whole process rather than a worker too small to start in. The
  heap is checked again after each check, since a process-wide
  `--max-old-space-size` overrides a worker's own limit.

  **The generic pipeline** runs every entry of `ANALYZER_PIPELINE` in order,
  each with a `run.analyzer-completed` caused by the merge. An analyzer that
  does not apply is `clean`, as a clean merge always was for the textual one.
  The first `infra-failure` fails the run as `analyzer:<name>`; a run
  superseded between analyzers stops there. The run's key is a fingerprint of
  every analyzer's name and version and the tools; each analyzer's verdict is
  cached under its own fingerprint, and a hit needs every analyzer's verdict
  from one run. A pipeline of one analyzer keeps the key it had, so verdicts
  already stored stay valid.

  **Done when:**
  - a slot's diagnostics equal `tsc --noEmit -p` on the same tree, on
    fixtures: a cross-branch call that no longer fits, a syntax error that
    stops the semantic check, a declaration error, a solution of two projects,
    a broken tsconfig; and this repository, checked through its solution
    tsconfig, reports nothing, as `pnpm typecheck` does, and an error a merge
    adds to `shared` is found warm;
  - the same slot checked twice reuses the live service and is faster, with
    cold, warm-unchanged and warm-one-file times recorded in `log.md` on this
    repository and on archestra;
  - evicting a slot stops its service; the number of live services is bounded;
    memory per instance on archestra is recorded, and a service whose heap
    passes its bound is not kept;
  - a superseded run's signal cancels a check in progress through the
    compiler's token, and the service survives it;
  - a plugin in a tsconfig reached through `extends` from `node_modules`, which
    would write a marker file when loaded, never writes it, and `plugins` is
    absent from the resolved options;
  - `include`, `files`, `typeRoots` and `paths` pointing outside the slot, and
    a link in the slot pointing out of it, read nothing: each target is a FIFO,
    which any read would hang on, and a recording file system shows no call
    outside the three roots;
  - a pnpm workspace link resolves into the slot: a fixture whose user copy
    and merged copy of a sibling package differ reports the merged one's error,
    and a file only the merge added to the package is found through its link;
  - a file the slot holds and its listing does not — an earlier tree's
    untracked output, which `tsc` reading the directory reports — is never read;
  - a check still running at its deadline is a `timeout` that keeps its
    service when it stops within the grace; with no grace its worker is
    terminated and a check queued behind it starts a new one; a stack overflow
    in the compiler is `crashed`, a heap past the limit `out-of-memory` naming
    it, a worker that cannot start or a released tree `infra-failure` with its
    reason;
  - files under `node_modules` keep their version while the install's records
    hold — a warm check asks nothing of the disk under `node_modules` — and are
    read again when an install changes; with no record they are versioned by
    the disk; a check during which the install changed is `infra-failure`;
  - workers start with an empty environment; a heap limit below 128 MiB is
    refused when the config is read and by the registry;
  - under `isolatedModules`, a check cancelled part way through the importers
    an edit re-checks resumes where it stopped;
  - the longest event-loop stall during a large check is measured both in the
    daemon's thread and in a worker, and the choice recorded in ADR-0008;
  - a stub second analyzer in the pipeline runs, is recorded, is fingerprinted
    — adding it, or bumping its version, is a miss — and the existing run
    pipeline and cache tests pass unchanged.

  **Constraints:** hard rule 2. A plugin is code the host process loads, so
  `plugins` is stripped after the whole `extends` chain is resolved; if plugins
  are ever needed the service moves to a subprocess, never back into the
  daemon. The compiler is Interlock's own pinned `typescript`, never the
  repository's `node_modules` copy, which is files an agent can write. Hard
  rule 7: `typescript` in `core` is ADR-0008. T3: nothing reads outside the
  three roots; the install records are read as data, inside the dependency
  checkout, never through a final link and never waiting on a pipe. Do not add a typecheck analyzer to `ANALYZER_PIPELINE` here;
  when one joins with the baseline differ it needs reconciliation keys for its
  Findings — reconciliation matches textual Findings only — and its toolchain
  fingerprint must name the TypeScript version.

- [ ] **Baseline differ**
      **Files:** `packages/core/src/analyzers/`
      **What:** a merged tree may already be broken for reasons that have nothing to do with the merge. Check the merge-base, branch A alone, branch B alone and the merged tree, then report only diagnostics present in the merge and absent from all three.
      **Done when:** a repository whose `main` already has type errors produces zero findings for a merge that introduces none, and a genuinely merge-induced error is still reported.
      **Constraints:** without this every finding is polluted by pre-existing noise, and the false-positive budget is blown on day one. Four compiler runs per pair is also four times the cost, so cache aggressively — A and B alone change only when their own snapshots change.

- [x] **Attribution engine**
      **Files:** `packages/core/src/analyzers/attribution.ts`, `attribution.test.ts`, `analyzers/index.ts`, `analyzers/notes.md`, `packages/core/src/merge/conflict-classifier.ts` (its blob reader, exported to core alone), `packages/core/src/merge/index.ts`, `packages/shared/src/models/finding.ts` (the `confidence` comment), `packages/core/test/attribution.test.ts`, `packages/core/test/support/attribution-fixtures.ts`, `packages/core/test/user-repo-untouched.test.ts`, `packages/core/README.md`, `docs/architecture.md`, `docs/threat-model.md` (only if a printed field's contents change)
      **What:** turn a diagnostic from the merged tree into a typecheck Finding about the two branches — which one changed the declaration the diagnostic names, which one holds the stale reference, a span on each in that branch's own lines, the rule the pair breaks, and the compiler's output as evidence. It takes any diagnostic as input and is independent of the baseline differ. Adding a typecheck analyzer to `ANALYZER_PIPELINE` is not this task.

  Rewritten before starting, from the issue. **The code gives the family; the
  declaring branch's change gives the rule.** Measured on TypeScript 6.0.3, the
  rename and the moved-export fixtures both reach the compiler as an import of a
  name the module no longer exports — TS2305 at the import specifier, in both —
  so a table from code to rule would label the rename a move. Two families are
  recognised. _A name that no longer resolves_: 2304 and 2552 (cannot find a
  name, and its "did you mean" twin), 2339 and 2551 (a property, and its twin),
  2305, 2614 and 2724 (a module's missing export). _An arity that no longer
  fits_: 2554 and 2555. Every other code is attributed to no branch. The rule
  comes from what the declaring branch did: renamed is `rename-vs-callsite`,
  moved is `moved-export-vs-import`, a changed parameter list is
  `signature-vs-caller`.

  **The name comes from the merged tree, never from the message,** whose
  wording changes between TypeScript versions. The merged file is read from the
  shadow by tree id and parsed with Interlock's own TypeScript —
  `ts.createSourceFile`, no program — and the diagnostic's offset must land on
  the line and column it reports, on an identifier for a name, or inside a call
  whose callee is a name or a property access for an arity. Anything else —
  the file not in the tree, over the parse cap, binary, unparseable, or an
  offset that does not hold a name — is attributed to no branch. Parsing is on
  the daemon's thread, so a file over 256 KiB is not parsed and each parse is
  a turn of its own; the longest stall is measured and recorded.

  **The declaration is found in the pair's merge base:** for an imported name,
  in the module a relative specifier resolves to (`.ts`, `.tsx`, `.d.ts`,
  `.mts`, `.cts`, `.js` read as `.ts`, `/index.ts`), as an exported declaration
  or an export specifier, an alias followed to the name it imports; for a name
  that does not resolve, at the top level of the reference's own file; for a
  property, as the one class or interface member of that name in the files
  either ChangeSet touches. A bare specifier, a global, or more than one
  candidate is attributed to no branch.

  **The declaring branch** is the one whose ChangeSet touches the declaration —
  a hunk's old range crosses it, an insertion lands strictly inside it, or the
  file was deleted or renamed — and exactly one must. Its own tree must then
  show a change the family explains: _moved_, the name exported from exactly
  one other file that branch added or modified; _renamed_, a declaration of the
  same kind under another name where the base declaration maps to, the old name
  gone from the file; _removed_, the name gone; _signature changed_, for an
  arity, the minimum, maximum or rest of its parameters differs from the base's,
  overloads included. A removal names its branch under the generic rule.

  **The referencing branch** is the one whose ChangeSet adds the line holding
  the diagnostic, mapped into that branch's own file. Exactly one must, and it
  must not be the declaring branch.

  **A ChangeSet is read in its own coordinates and checked against the
  shadow.** It is diffed against the merge base with the default branch, which
  need not be the pair's: its hunks are compared with the declaration as its own
  base holds it. A side captured again keeps the ChangeSet it had, against a new
  tree, so for every path a decision reads, the blobs at the ChangeSet's base
  and at the merged commit must agree with what it claims; one that does not is
  stale, and stale is treated as missing.

  **Lines are each branch's own.** The diagnostic's line is the merged tree's;
  a file the other branch also changed has different lines on this one. The
  merged file is aligned to the branch's file (`alignLines`, bounded): an
  identical blob maps line for line, an aligned line maps exactly, and an
  unaligned one maps to the gap between its nearest aligned neighbours. A span
  whose mapping is unsure stays in its file and widens to that gap — or, with
  nothing aligned, to the branch's hunks in the file — rather than point at a
  wrong line; the branch it would name is then not decided by it. The declaring
  side's span is the renamed declaration from its start to its name, the
  changed one to the close of its parameters, or the moved one whole in its new
  file, and an empty span where a removed one was. The referencing side's is
  the call for an arity and the reference's line otherwise; for a stale import,
  the import, and each run of lines that use its binding as a span of its own,
  up to `MAX_SPANS_PER_SIDE` in all — never one span from the import to its
  last use, which in a long file is hundreds of lines that are not the
  reference.

  **`originBranch` is the declaring branch, or null.** It is chosen once for
  every rule: `Attribution.originBranch` is "the side that introduced the
  change that broke the other", and both halves are needed for these
  conflicts. Attributed, a Finding has confidence 1 and the rule its change
  names. Anything else is `merge-breaks-typecheck` — named as the eval suite
  names `merge-breaks-test` — with `originBranch` null, confidence 0.5, and a
  rationale saying what could not be told. Reasons are checked in a fixed
  order — code, location, a missing ChangeSet, declaration, a stale ChangeSet,
  reference in the base, declaring branch, mapping, referencing branch — and
  the first that applies is the rationale. Severity is `high` either way: the
  merged tree does not compile.

  **Evidence:** spans on each branch that has a half, declaring side first,
  each with a short redacted excerpt (`excerptOf`); a symbol trail — the
  declaring branch's step (`renamed`, `moved`, `signature-changed` or
  `deleted`, at the declaration in its own tree) then the referencing branch's
  (`referenced`); and the compiler's diagnostic as process output, in `tsc`'s
  own form, with `tsc`'s exit status for a project with errors (2), redacted.
  An unattributed Finding keeps whatever of these is known.

  **Done when:**
  - _rename:_ branch A renames `processRefund` to `refundPayment` and updates
    its own callers; branch B adds `src/support.ts`, uncommitted, calling
    `processRefund`. The Finding is `rename-vs-callsite`, origin A, with a span
    on A over `src/payments.ts` line 1, on B over `src/support.ts` lines 1
    and 4 — the import and the call, the two ends of the label's 1–4 — and a
    trail of A renaming `processRefund` and B referencing it;
  - _signature:_ A adds a required parameter to `formatPrice`; B adds a call
    without it. `signature-vs-caller`, A's span on `src/format.ts` line 1, B's
    on `src/invoice.ts` line 4;
  - _moved export:_ A moves `slugify` from `src/utils.ts` to `src/strings.ts`;
    B adds `src/tag.ts`, importing it from `./utils`. `moved-export-vs-import`,
    A's span on `src/strings.ts` lines 1–3, B's on `src/tag.ts` lines 1 and 4;
  - each runs on the diagnostic the type-check service reports for the merged
    slot, and the three are the cases in `eval/fixtures/semantic.ts`, mirrored
    in `packages/core/test/` and held equal to it by a test that reads it; each
    twin reports no diagnostic, so attribution is never asked;
  - a reference in a file both branches edited gets a span in the referencing
    branch's own lines, where they differ from the merged file's; a
    declaration in a file the declaring branch renamed gets the reference's
    span under the referencing branch's own path;
  - both branches changing the declaration, a reference already in the base, a
    code it does not recognise and a missing ChangeSet each produce a Finding
    with confidence 0.5, `originBranch` null and the rationale for that case —
    and so does a stale ChangeSet, a non-relative import, and a file it cannot
    read;
  - an excerpt holding terminal control characters and a secret is redacted and
    kept to the excerpt bounds;
  - no Finding's title, description or rationale holds a name or path from the
    repository, for any rule or reason;
  - importing `@interlock/core` still does not load `typescript`;
  - the user repository is untouched by an attribution, in
    `user-repo-untouched.test.ts`.

  **Edge cases and the tests they need:**
  - Hunks with `--unified=0`: an insertion's `oldStart` is the line it follows;
    a deletion's `newStart` the line it follows; an added file is `-0,0`. One
    test per boundary — an insertion before, inside and after the declaration.
  - A ChangeSet whose base is not the pair's merge base, and one computed for an
    earlier tree: each its own test.
  - An imported name under an alias, and a namespace import's property.
  - More diagnostics than `MAX_FINDINGS_PER_RUN`: the rest are counted, not
    read. An aborted signal stops the batch with `REQUEST_CANCELLED`.
  - A file nested deeply enough to overflow the parser's stack is unreadable,
    not a crash.
  - A path holding a space.

  **Failure modes:** a branch named on a guess — every reason has a test
  asserting `originBranch` null; a span on a line that exists on no branch — the
  mapping widens rather than guesses, with a test; a rule that is a compiler
  code — rule names are asserted never to be one; repository content in a
  field the CLI prints unwrapped — asserted absent; `typescript` loaded by
  importing `core` — asserted not; a git failure turned into a Finding — the
  runner's infrastructure error propagates, as the textual classifier's does.

  **Constraints:** hard rule 2 — nothing executes repository code: sources are
  read from the shadow by tree id and parsed, never loaded. No new dependency in
  `core`: the compiler is the `typescript` ADR-0008 already added, loaded on
  first use. Models are wire formats: the existing `Finding`, `Attribution`,
  `SpanEvidence`, `SymbolTrailEvidence` and process-output evidence, unchanged.
  Names, paths and excerpts are repository content, and the threat model's
  "What the CLI prints" table says a title holds none: names stay in the symbol
  trail, the spans and the process output, which the CLI does not print, and
  titles, descriptions and rationales are fixed text. **Rule names and span
  attribution follow the labels in `eval/fixtures/semantic.ts`,** which were
  written first and are read-only: the rules are `rename-vs-callsite`,
  `signature-vs-caller` and `moved-export-vs-import` — never a compiler code
  such as `TS2554` — and the spans put the branch that changed a declaration on
  that declaration, and the branch holding the stale reference on the
  reference. An analyzer that names its findings otherwise scores recall 0
  against a set nobody can edit, and looks broken when it is not. Not built
  here: grouping several diagnostics about one declaration into one Finding,
  and reconciliation keys for typecheck Findings — both the typecheck
  analyzer's, which decides what a Finding's identity is.

- [ ] **Typecheck analyzer**
      **Files:** `packages/core/src/analyzers/` (the analyzer, its reconciliation key, `ANALYZER_PIPELINE`), `packages/daemon/src/` (the registry, reconciliation, dismissal)
      **What:** join the three steps above into an analyzer in `ANALYZER_PIPELINE`: type-check the merged slot, keep what the baseline differ says the merge introduced, and attribute that. The daemon constructs the type-check registry, lets a slot's service go through the pool's `onEvict`, and closes it on stop. Gathered here from the tasks above, which each left one of these to it.

  **Done when:**
  - attribution is given the baseline differ's output and nothing else: a
    repository whose default branch already has type errors produces no
    typecheck Finding for a merge that introduces none. Attribution makes a
    Finding of every diagnostic it is given — at 0.5 where it cannot attribute
    one — so the raw report would turn each error on `main` into one;
  - a typecheck Finding has a reconciliation key and content, as a textual one
    has `textualFindingKey` and `textualFindingContent`: the same conflict on
    the next run takes over the open Finding's id and `firstSeenAt` rather than
    opening a duplicate, it resolves when it stops reproducing, and a dismissed
    one stays dismissed while the content it was judged at stands. Each Finding
    gets a fresh id today, and reconciliation and dismissal match textual
    Findings only;
  - whether several diagnostics about one declaration are one Finding is
    decided, since it is part of what the key identifies;
  - the toolchain fingerprint names the TypeScript version, and `typecheck.*`
    config is read, with the CHANGELOG entry the typecheck runner left to this
    change;
  - the compiler's one-time load (~360 ms) happens at daemon start or in the
    type-check worker, not on the daemon's thread in the first attribution.

  **Constraints:** the key is built as the textual one is — the pair
  unordered, the rule, and what the conflict is about — never from a span's
  lines, which move whenever either branch edits above them, or from the
  commits.

- [ ] **Build analyzer**
      **Files:** `packages/core/src/analyzers/build.ts`
      **What:** the same three steps for the project's build command.
      **Done when:** a merge that typechecks but fails to build produces a Finding with the build output as evidence, redacted.

- [ ] **Infra failure handling**
      **Files:** `packages/core/src/analyzers/analyzer.ts`
      **What:** Docker down, image missing, toolchain unknown, timeout, dependencies unavailable because the lockfile changed.
      **Done when:** each produces `infra-failure` and is never shown to a user as a conflict. An analyzer that cannot run must not report clean.

## Deferred — measure before building

Options considered and not taken, with what would justify them. None is a task:
each stays here until a measurement shows the problem it solves.

- **Copy-on-write slot fills.** Start a pool slot as a filesystem clone of the
  user's checkout (`clonefile` on APFS, `cp --reflink` on btrfs and xfs), then
  `reset --hard` to the merged commit, so only the files that differ are
  written. Saves disk, not time: four slots of a 276 MB checkout drop from
  about 1.1 GB to tens of MB, while a cold fill goes from about 1.6 s to about
  0.2 s — and cold fills are rare, since slots are sticky and updated by delta.
  Costs two code paths, the clone and an ext4 fallback, with CI on ext4 never
  testing the clone; and the clone carries the user's untracked files — build
  output, `.env` — which must be removed or excluded, a new way to run a check
  on a dirty slot or leak a secret into the sandbox. Revisit when the pool's
  disk use is a measured complaint on large repositories.
- **Copy-on-write dependencies.** A clone of `node_modules` per check instead
  of a mount. Gains nothing while the sandbox mounts dependencies read-only,
  which costs no disk either; worth it only if a check needs to write them.
  Credential files are excluded from any copy, as from everything else.
- **Forked VM snapshots for the sandbox.** Snapshot a booted sandbox with
  dependencies installed and the compiler warm, and fork it per check: a start
  in milliseconds, isolation stronger than a container — the residual risk
  threat-model T2 names — and no port clashes. Needs Linux with KVM, so not
  macOS, where the daemon runs; a fit for a hosted mode, not the local one.
