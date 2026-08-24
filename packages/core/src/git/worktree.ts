import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notImplemented } from '@interlock/shared';
import { runRequired } from './repo-handle.js';
import type { GitRunner, ShadowRepo, UserRepo } from './repo-handle.js';
import { parseStatus } from './status.js';

/**
 * Working-tree observation and snapshotting.
 *
 * The subtle part is capturing a dirty worktree without touching the user's
 * index or stash: point `GIT_INDEX_FILE` at a temporary index outside the
 * repository, populate that, then `write-tree`. Objects land in the user's
 * object database, which is append-only and reclaimed by `git gc`; the index,
 * refs and stash are never written.
 */

/**
 * Ceiling on the pathspec bytes handed to one `git add`.
 *
 * Arguments and environment share a fixed budget per process, and a watcher
 * that reports thousands of paths would exceed it. The runner closes stdin, so
 * a long list is split across invocations against the same temporary index
 * rather than piped.
 */
const MAX_PATHSPEC_BYTES = 96 * 1024;

/**
 * What a capture is allowed to look at.
 *
 * Scoped is the common case and the cheap one, but it is only correct with the
 * tree it is extending: seeded from `HEAD` it would drop every uncommitted
 * change outside the reported paths, producing a tree that is wrong rather than
 * merely stale. Requiring the base tree in the same object makes that
 * impossible to express by accident.
 */
export type SnapshotScope =
  | { readonly kind: 'whole-tree' }
  | {
      readonly kind: 'scoped';
      /**
       * Every path that changed since `baseTreeOid` was taken, including both
       * halves of a rename: a pathspec narrows git's rename detection as well,
       * so a source that is not reported is never restaged and the tree keeps a
       * file that is no longer there. A watcher sees both, because both moved.
       */
      readonly paths: readonly string[];
      /** Tree of the previous snapshot of this worktree. */
      readonly baseTreeOid: string;
    };

export interface SnapshotOptions {
  readonly runner: GitRunner;
  /** Defaults to a whole-tree capture, which is always correct and never cheap. */
  readonly scope?: SnapshotScope;
}

export interface WorktreeSnapshot {
  /** Tree recording the worktree as it stood, uncommitted work included. */
  readonly treeOid: string;
  /**
   * Whether the tree is the one `HEAD` records, meaning nothing is uncommitted.
   * Always false where `HEAD` is unborn: with nothing committed there is no
   * state for the worktree to match.
   */
  readonly clean: boolean;
  /**
   * How the capture was actually taken. A scoped request reports `whole-tree`
   * when its base tree was no longer reachable, which tells a caller holding a
   * chain of snapshots that this one restarts it.
   */
  readonly takenAs: SnapshotScope['kind'];
  readonly capturedAt: string;
}

/**
 * Capture the uncommitted state of a user worktree as a tree object.
 *
 * Read-only with respect to everything a user can lose. The only write is to
 * the object database, which is additive.
 *
 * @param worktreePath the worktree to capture, which for a linked worktree is
 *        not `repo.rootPath`.
 * @param repo the repository that worktree belongs to; its git directory is
 *        one of the places the temporary index must not land.
 */
export async function captureDirtyState(
  worktreePath: string,
  repo: UserRepo,
  options: SnapshotOptions,
): Promise<WorktreeSnapshot> {
  // The worktree is where the files are; the git directory is the main
  // repository's, so redirecting the index is checked against both.
  const worktree: UserRepo = { kind: 'user', rootPath: worktreePath, gitDir: repo.gitDir };
  const { runner } = options;
  const scope = options.scope ?? { kind: 'whole-tree' };

  const headTree = await resolveTree(worktree, runner, 'HEAD^{tree}');
  const capturedAt = new Date().toISOString();
  const describe = (treeOid: string, takenAs: SnapshotScope['kind']): WorktreeSnapshot => ({
    treeOid,
    clean: headTree !== null && treeOid === headTree,
    takenAs,
    capturedAt,
  });

  if (scope.kind === 'scoped') {
    // Objects are unreferenced until something points at them, so a user
    // running `git gc --prune=now` between snapshots can collect the tree this
    // capture means to extend. Losing the base is a reason to take a full
    // snapshot, not a reason to fail.
    const base = await resolveTree(worktree, runner, `${scope.baseTreeOid}^{tree}`);
    if (base !== null) {
      const changed = await changedPaths(worktree, runner, scope.paths);
      // Nothing the watcher reported turned out to be a change git records, so
      // the tree it already has still describes the worktree.
      if (changed.length === 0) return describe(base, 'scoped');
      return describe(await buildTree(worktree, runner, base, changed), 'scoped');
    }
  }

  return describe(await buildTree(worktree, runner, headTree, null), 'whole-tree');
}

/**
 * Resolve a revision to a tree, or `null` when it does not resolve.
 *
 * `rev-parse --verify` answers with an exit code rather than a message, which
 * is what makes this usable as a test: git's wording for a missing object has
 * changed between versions and matching on it would be a version dependency.
 */
async function resolveTree(
  worktree: UserRepo,
  runner: GitRunner,
  revision: string,
): Promise<string | null> {
  const result = await runner.run(worktree, ['rev-parse', '--verify', '--quiet', revision]);
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.trim();
  return oid === '' ? null : oid;
}

/**
 * Narrow the watcher's reported paths to the ones git would record.
 *
 * `git add` refuses an explicitly named path that is ignored, and fails outright
 * on one that matches nothing — a file created and deleted inside a debounce
 * window. Both are ordinary watcher output, and both would fail the capture.
 * `status` reports neither, so asking it first is what makes the scoped path
 * usable rather than merely fast.
 */
async function changedPaths(
  worktree: UserRepo,
  runner: GitRunner,
  paths: readonly string[],
): Promise<string[]> {
  const reported = new Set<string>();

  for (const chunk of chunkPaths(paths)) {
    const status = await runRequired(runner, worktree, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--',
      ...chunk,
    ]);
    for (const entry of parseStatus(status.stdout)) {
      reported.add(entry.path);
      if (entry.origPath !== null) reported.add(entry.origPath);
    }
  }

  return [...reported];
}

/**
 * Populate a temporary index and write it out as a tree.
 *
 * The seed is not optional: staging a handful of paths into an empty index
 * produces a tree holding only those paths, which is a corrupt snapshot rather
 * than a slow one. Seeding from `HEAD` also keeps a file that is tracked
 * despite matching `.gitignore`, which a rebuild from the worktree alone would
 * drop.
 */
async function buildTree(
  worktree: UserRepo,
  runner: GitRunner,
  seedTree: string | null,
  paths: readonly string[] | null,
): Promise<string> {
  // Outside the repository, and in a directory that exists: the runner resolves
  // the path through `realpath` and refuses one it cannot verify.
  const directory = await mkdtemp(join(tmpdir(), 'interlock-index-'));
  const indexFile = join(directory, 'index');

  try {
    await runRequired(
      runner,
      worktree,
      seedTree === null ? ['read-tree', '--empty'] : ['read-tree', seedTree],
      { indexFile },
    );

    if (paths === null) {
      await runRequired(runner, worktree, ['add', '-A'], { indexFile });
    } else {
      for (const chunk of chunkPaths(paths)) {
        await runRequired(runner, worktree, ['add', '-A', '--', ...chunk], { indexFile });
      }
    }

    const tree = await runRequired(runner, worktree, ['write-tree'], { indexFile });
    return tree.stdout.trim();
  } finally {
    // The error path too: a temporary index left behind is a file in the user's
    // temp directory that nothing will ever clean up.
    await rm(directory, { recursive: true, force: true });
  }
}

/** Split paths into groups that fit in one command line. */
function* chunkPaths(paths: readonly string[]): Generator<string[]> {
  let chunk: string[] = [];
  let bytes = 0;

  for (const path of paths) {
    const size = Buffer.byteLength(path, 'utf8') + 1;
    if (chunk.length > 0 && bytes + size > MAX_PATHSPEC_BYTES) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }

  if (chunk.length > 0) yield chunk;
}

/**
 * Materialise a snapshot as a commit **in the shadow repo only**, so the
 * speculative merge has two real commits to work with.
 */
export function commitSnapshotInShadow(
  _shadow: ShadowRepo,
  _snapshotTreeSha: string,
  _options: SnapshotOptions,
): Promise<string> {
  return notImplemented('commitSnapshotInShadow');
}
