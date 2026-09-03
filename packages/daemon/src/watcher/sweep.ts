import { describeRepo, listBranchRefs, openUserRepo } from '@interlock/core';
import type { GitRunner, UserRepo } from '@interlock/core';
import { isInterlockError, matchesGlob, silentLogger } from '@interlock/shared';
import type { BranchRef, InterlockEvent, Logger, Repo } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';

/**
 * Reconciles what git reports against what the store holds.
 *
 * This is where a path becomes a branch. The watcher deliberately resolves no
 * identity — a worktree can be checked out onto another branch between a write
 * and the lookup — so every event carrying a `branchRefId` is published from
 * here, after asking git, rather than from the signal that prompted it.
 *
 * It runs periodically as well as on signals: filesystem events are lossy on
 * macOS, and a branch created by a command that touched nothing inside a
 * watched worktree produces no signal at all.
 *
 * A store write and its event are two steps with no transaction around them, so
 * a failure between them can cost an announcement. That is a hole in the log
 * rather than in the state: the store is reconciled against git on the next
 * pass and never rebuilt from the log, so what is lost is traceability for one
 * change, not the change itself.
 */

export interface SweepOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  /** Root of Interlock's data dir; shadow paths are derived from it. */
  readonly dataDir: string;
  readonly logger?: Logger;
}

export interface SweepOutcome {
  readonly reconciled: readonly string[];
  /** Repositories that failed this pass. Each is retried on the next one. */
  readonly failed: readonly string[];
}

export interface Sweep {
  /**
   * Reconcile one repository, publishing what changed about it.
   *
   * Throws for a repository that cannot be read at all; {@link Sweep.all} is
   * what contains that.
   */
  reconcile(rootPath: string): Promise<void>;
  /** Reconcile every repository, containing a failure to the one it came from. */
  all(rootPaths: readonly string[]): Promise<SweepOutcome>;
}

export function createSweep(options: SweepOptions): Sweep {
  const log = (options.logger ?? silentLogger).child('sweep');
  const { store, bus, runner, dataDir } = options;

  const publish = async (event: InterlockEvent): Promise<void> => {
    await bus.publish(event);
  };

  /**
   * The repository as it should now be stored.
   *
   * `describeRepo` re-reads `.interlock.json` on every call, which is what makes
   * a mid-session change to `ignoreBranches` take effect without a restart. A
   * malformed file is refused there, and refusing it must not cost the last good
   * config: serving a stale one is silent and permanent, while a warning here is
   * loud and recoverable the moment the file is fixed.
   */
  const describeOrKeep = async (handle: UserRepo, stored: Repo | null): Promise<Repo> => {
    try {
      return await describeRepo(handle, { runner, dataDir });
    } catch (error) {
      if (!isInterlockError(error) || error.code !== 'CONFIG_INVALID' || stored === null) {
        throw error;
      }
      log.warn('the repository override file is invalid; keeping the last good config', {
        rootPath: handle.rootPath,
        reason: error.message,
      });
      return { ...stored, lastSeenAt: new Date().toISOString() };
    }
  };

  const reconcileBranches = async (handle: UserRepo, repo: Repo): Promise<void> => {
    const observed = await listBranchRefs(handle, repo.id, {
      runner,
      ...(repo.config.ignoreBranches === undefined
        ? {}
        : { ignoreBranches: repo.config.ignoreBranches }),
    });

    // Keyed on `ref` rather than id: discovery mints a fresh ULID per
    // observation, so the id says nothing about whether this branch is new.
    const remaining = new Map((await store.listBranchRefs(repo.id)).map((ref) => [ref.ref, ref]));

    for (const branch of observed) {
      const before = remaining.get(branch.ref);
      remaining.delete(branch.ref);
      const after = await store.upsertBranchRef(branch);

      if (before === undefined) {
        await publish({
          type: 'branch.appeared',
          repoId: repo.id,
          at: after.updatedAt,
          branchRefId: after.id,
          name: after.name,
          headSha: after.headSha,
          worktreePath: after.worktreePath,
        });
      } else if (moved(before, after)) {
        await publish({
          type: 'branch.updated',
          repoId: repo.id,
          at: after.updatedAt,
          branchRefId: after.id,
          headSha: after.headSha,
          dirty: dirtyFlag(after),
        });
      }
    }

    const ignored = (name: string): boolean =>
      (repo.config.ignoreBranches ?? []).some((pattern) => matchesGlob(name, pattern));

    for (const gone of remaining.values()) {
      // Published before the row goes. Either order can fail between the two
      // steps, but only this one repeats itself: a delete that fails leaves the
      // branch to be reported again next sweep, where an event that fails after
      // the delete is a hole nothing will ever fill — the branch is absent from
      // git and from the store, so no later pass can notice it left.
      await publish({
        type: 'branch.disappeared',
        repoId: repo.id,
        at: new Date().toISOString(),
        branchRefId: gone.id,
        // A branch the repository asked to ignore still exists. Reported as
        // deleted, a replay would read an exclusion as a destruction.
        reason: ignored(gone.name) ? 'ignored' : 'deleted',
      });
      // Its merge pairs and change sets go with it, by cascade.
      await store.deleteBranchRef(gone.id);
    }
  };

  return {
    async reconcile(rootPath: string): Promise<void> {
      const handle = await openUserRepo(rootPath, { runner });
      const stored = await store.getRepoByPath(rootPath);
      const described = await describeOrKeep(handle, stored);
      const repo = await store.upsertRepo(described);

      if (stored === null) {
        await publish({
          type: 'repo.discovered',
          repoId: repo.id,
          at: repo.discoveredAt,
          rootPath: repo.rootPath,
          defaultBranch: repo.defaultBranch,
        });
      }

      await reconcileBranches(handle, repo);
    },

    async all(rootPaths: readonly string[]): Promise<SweepOutcome> {
      const reconciled: string[] = [];
      const failed: string[] = [];

      for (const rootPath of rootPaths) {
        try {
          await this.reconcile(rootPath);
          reconciled.push(rootPath);
        } catch (error) {
          // One repository's broken override file, deleted directory or wedged
          // git must not stop the repositories beside it — the same rule that
          // keeps one unreachable worktree from failing a branch listing.
          failed.push(rootPath);
          log.warn('reconciliation failed for one repository', {
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { reconciled, failed };
    },
  };
}

/**
 * Whether anything a `branch.updated` can carry has changed.
 *
 * Compared on exactly what the event conveys. A change to which files are dirty
 * without a change to whether any are is the filesystem watcher's business, and
 * publishing it here would be an event no consumer could act on.
 */
function moved(before: BranchRef, after: BranchRef): boolean {
  return before.headSha !== after.headSha || dirtyFlag(before) !== dirtyFlag(after);
}

/** `null` when the worktree could not be read, which is not clean. */
function dirtyFlag(ref: BranchRef): boolean | null {
  return ref.dirty === null ? null : ref.dirty.isDirty;
}
