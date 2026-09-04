import { captureDirtyState, extractChangeSet, mergeBase } from '@interlock/core';
import type { GitRunner, UserRepo } from '@interlock/core';
import { silentLogger, ulid } from '@interlock/shared';
import type { BranchRef, ChangeSetId, Logger, Repo, SnapshotId } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';

/**
 * Turns a branch's worktree into content identity, and publishes only when that
 * identity changed.
 *
 * A filesystem signal says a file was written; it cannot say the bytes differ
 * from what was there before, and editors and agents both rewrite files
 * identically all day. Hashing the worktree to a tree answers that exactly.
 *
 * The saving is not the capture — that runs either way — but everything behind
 * it: the diff, the scheduling, and every pair that would be marked stale for a
 * change that did not happen.
 */

export interface SnapshotPipelineOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  readonly logger?: Logger;
  /**
   * How long a worktree may go unhashed while nothing reports it changing.
   *
   * Filesystem events are lossy, so a signal arriving is proof that something
   * happened and no signal arriving is not proof that nothing did. This is the
   * safety net for the second case, and its cost is one hash per worktree per
   * interval — measured at roughly half a second for ten thousand files, which
   * is what makes it a ceiling rather than a cadence.
   */
  readonly recaptureAfterMs?: number;
  /** Injectable so the ceiling can be crossed without waiting for it. */
  readonly now?: () => number;
}

export interface SnapshotPipeline {
  /**
   * Capture a branch's worktree and publish it when the content moved.
   *
   * Does nothing for a branch that is not checked out anywhere: there is no
   * worktree to hash, and its committed state is already carried by
   * `branch.updated`.
   */
  capture(handle: UserRepo, repo: Repo, branch: BranchRef): Promise<void>;
  /**
   * Record that something on disk changed under this worktree.
   *
   * Hashing a worktree costs a walk over every file in it, so a pass that runs
   * on a timer must not do it for worktrees nothing reported. A marked one is
   * hashed on the next pass; an unmarked one waits for the ceiling.
   */
  markChanged(worktreePath: string): void;
  /** Drop a worktree's remembered identity, so the next capture is published. */
  forget(worktreePath: string): void;
}

/**
 * How long a worktree may go unhashed with nothing reporting a change.
 *
 * Long enough that the periodic cost is a rounding error, short enough that a
 * filesystem event the platform dropped is noticed while the work is still in
 * progress rather than after it lands.
 */
const DEFAULT_RECAPTURE_AFTER_MS = 60_000;

export function createSnapshotPipeline(options: SnapshotPipelineOptions): SnapshotPipeline {
  const log = (options.logger ?? silentLogger).child('snapshot');
  const { store, bus, runner } = options;

  /**
   * Last published identity per worktree.
   *
   * Keyed on the worktree rather than the branch: the tree is a property of
   * what is on disk, and a branch that moves to another checkout is looking at
   * different files even where its head has not moved.
   */
  const lastSeen = new Map<
    string,
    { treeOid: string; snapshotId: SnapshotId; at: number; changed: boolean }
  >();
  const recaptureAfterMs = options.recaptureAfterMs ?? DEFAULT_RECAPTURE_AFTER_MS;
  const now = options.now ?? Date.now;

  return {
    async capture(handle: UserRepo, repo: Repo, branch: BranchRef): Promise<void> {
      if (branch.worktreePath === null) return;

      if (branch.dirty === null) {
        // Unknown, not unchanged. Published every time rather than compared:
        // there is no identity to compare, and silence here would be read as
        // "nothing changed" about a worktree nobody could read.
        lastSeen.delete(branch.worktreePath);
        await publish(branch, null, null, 0);
        return;
      }

      const previous = lastSeen.get(branch.worktreePath);
      // Nothing said this worktree moved. Hashing it anyway is the whole idle
      // cost of the daemon, and it buys only the changes the filesystem failed
      // to report — which the ceiling still catches. A worktree with no entry
      // has never been hashed, so it is hashed whatever anyone reported.
      if (previous !== undefined && !previous.changed && now() - previous.at < recaptureAfterMs) {
        await rememberOn(branch, previous.snapshotId);
        return;
      }

      const snapshot = await captureDirtyState(branch.worktreePath, handle, { runner });
      if (previous?.treeOid === snapshot.treeOid) {
        // Same content, so the clock restarts: without this the ceiling stays
        // expired and every later pass hashes the worktree again.
        lastSeen.set(branch.worktreePath, { ...previous, at: now(), changed: false });
        // The row still has to name the snapshot this content belongs to; the
        // sweep re-lists every branch with a null id and would otherwise leave
        // `contentIdentity` reading two different dirty states as one.
        await rememberOn(branch, previous.snapshotId);
        return;
      }

      const snapshotId = ulid<SnapshotId>();
      const base = await mergeBase(handle, branch.headSha, repo.defaultBranch, { runner });
      if (base === null) {
        // Two histories with no common ancestor have no diff to speak of, and
        // an empty one would read as "this branch changed nothing".
        log.debug('no merge base; publishing the tree without a diff', {
          branch: branch.name,
        });
        lastSeen.set(branch.worktreePath, {
          treeOid: snapshot.treeOid,
          snapshotId,
          at: now(),
          changed: false,
        });
        await rememberOn(branch, snapshotId);
        await publish(branch, snapshot.treeOid, null, 0);
        return;
      }

      const changeSet = await extractChangeSet(handle, branch, base, {
        runner,
        snapshot: { id: snapshotId, treeOid: snapshot.treeOid },
      });
      await store.upsertChangeSet(changeSet);
      lastSeen.set(branch.worktreePath, {
        treeOid: snapshot.treeOid,
        snapshotId,
        at: now(),
        changed: false,
      });
      await rememberOn(branch, snapshotId);
      await publish(branch, snapshot.treeOid, changeSet.id, changeSet.files.length);
    },

    markChanged(worktreePath: string): void {
      const previous = lastSeen.get(worktreePath);
      // Recorded on the entry rather than beside it: a worktree with no entry
      // is hashed regardless, so a mark for one would be state that only ever
      // needed cleaning up.
      if (previous !== undefined) lastSeen.set(worktreePath, { ...previous, changed: true });
    },

    forget(worktreePath: string): void {
      lastSeen.delete(worktreePath);
    },
  };

  /** Record which snapshot the branch's uncommitted work belongs to. */
  async function rememberOn(branch: BranchRef, snapshotId: SnapshotId): Promise<void> {
    if (branch.dirty === null || branch.dirty.snapshotId === snapshotId) return;
    await store.upsertBranchRef({
      ...branch,
      dirty: { ...branch.dirty, snapshotId },
    });
  }

  async function publish(
    branch: BranchRef,
    treeOid: string | null,
    changeSetId: ChangeSetId | null,
    fileCount: number,
  ): Promise<void> {
    await bus.publish({
      type: 'branch.snapshot',
      repoId: branch.repoId,
      at: new Date().toISOString(),
      branchRefId: branch.id,
      treeOid,
      changeSetId,
      fileCount,
    });
  }
}
