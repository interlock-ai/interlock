import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInterlockError, ulid } from '@interlock/shared';
import type { InterlockError, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeRepo, listBranchRefs, mergeBase, openUserRepo } from '../src/git/discovery.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { DiscoveryOptions } from '../src/git/discovery.js';
import type { UserRepo } from '../src/git/repo-handle.js';

async function rejection(promise: Promise<unknown>): Promise<InterlockError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isInterlockError(error)) {
    throw new Error(`expected an InterlockError, got: ${String(error)}`);
  }
  return error;
}

/**
 * Discovery against a repository in the states that actually occur: several
 * linked worktrees, one detached, one whose directory has been deleted, plus a
 * separate repository with an unborn HEAD.
 */
describe('repo discovery', () => {
  let base: string;
  let root: string;
  let repo: UserRepo;
  const repoId = ulid<RepoId>();
  const options: DiscoveryOptions = { runner: createGitRunner(), dataDir: '/data' };

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  beforeEach(() => {
    // git reports fully-resolved paths, and on macOS /var is a symlink to
    // /private/var — so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-disc-')));
    root = join(base, 'main-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');

    git(root, 'branch', 'feature');
    git(root, 'branch', 'release/1.0');
    git(root, 'worktree', 'add', '-q', join(base, 'wt-feature'), 'feature');
    git(root, 'worktree', 'add', '-q', '--detach', join(base, 'wt-detached'), 'HEAD');
    git(root, 'worktree', 'add', '-q', '-b', 'gone', join(base, 'wt-gone'));
    rmSync(join(base, 'wt-gone'), { recursive: true, force: true });

    repo = { kind: 'user', rootPath: root, gitDir: join(root, '.git') };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('openUserRepo', () => {
    it('resolves a nested path to the repository root', async () => {
      const opened = await openUserRepo(join(base, 'wt-feature'), options);
      expect(opened.kind).toBe('user');
      expect(opened.rootPath).toBe(join(base, 'wt-feature'));
      expect(opened.gitDir).toContain('worktrees');
    });

    it('rejects a path that is not a repository', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'interlock-plain-'));
      try {
        const error = await rejection(openUserRepo(plain, options));
        expect(error.code).toBe('REPO_NOT_GIT');
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it('rejects a bare repository, which has no work in flight', async () => {
      const bare = join(base, 'bare.git');
      execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
      const error = await rejection(openUserRepo(bare, options));
      expect(error.code).toBe('REPO_BARE');
    });
  });

  describe('describeRepo', () => {
    it('reads the checked-out branch as the default when there is no remote', async () => {
      const described = await describeRepo(repo, options);
      expect(described.defaultBranch).toBe('main');
      expect(described.rootPath).toBe(root);
      expect(described.shadowPath).toBe(`/data/shadows/${described.id}`);
    });

    it('prefers what the remote declares', async () => {
      git(root, 'remote', 'add', 'origin', root);
      git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/feature');
      const described = await describeRepo(repo, options);
      expect(described.defaultBranch).toBe('feature');
    });

    it('falls back to main for a repository with an unborn HEAD', async () => {
      const unborn = join(base, 'unborn');
      execFileSync('git', ['init', '-q', '-b', 'main', unborn], { stdio: 'pipe' });
      const described = await describeRepo(
        { kind: 'user', rootPath: unborn, gitDir: join(unborn, '.git') },
        options,
      );
      expect(described.defaultBranch).toBe('main');
    });
  });

  describe('listBranchRefs', () => {
    it('includes branches checked out in linked worktrees', async () => {
      const refs = await listBranchRefs(repo, repoId, options);
      const byName = new Map(refs.map((ref) => [ref.name, ref]));

      expect(byName.get('feature')?.worktreePath).toBe(join(base, 'wt-feature'));
      // Checked out in the primary worktree rather than a linked one.
      expect(byName.get('main')?.worktreePath).toBe(root);
      expect(refs.every((ref) => ref.repoId === repoId)).toBe(true);
      expect(refs.every((ref) => ref.ref.startsWith('refs/heads/'))).toBe(true);
    });

    it('skips a worktree whose directory has been deleted', async () => {
      const refs = await listBranchRefs(repo, repoId, options);
      const gone = refs.find((ref) => ref.name === 'gone');
      // The branch still exists; only its unusable worktree is dropped.
      expect(gone).toBeDefined();
      expect(gone?.worktreePath).toBeNull();
    });

    it('reports dirty state per worktree', async () => {
      writeFileSync(join(base, 'wt-feature', 'staged.txt'), 'staged\n');
      git(join(base, 'wt-feature'), 'add', 'staged.txt');
      writeFileSync(join(base, 'wt-feature', 'a.txt'), 'changed\n');
      writeFileSync(join(base, 'wt-feature', 'untracked.txt'), 'new\n');

      const refs = await listBranchRefs(repo, repoId, options);
      const feature = refs.find((ref) => ref.name === 'feature');

      expect(feature?.dirty.isDirty).toBe(true);
      expect(feature?.dirty.stagedFiles).toContain('staged.txt');
      expect(feature?.dirty.unstagedFiles).toContain('a.txt');
      expect(feature?.dirty.untrackedFiles).toContain('untracked.txt');
      // Content identity belongs to the snapshot step, not to discovery.
      expect(feature?.dirty.snapshotId).toBeNull();
    });

    it('reports a clean branch as clean', async () => {
      const refs = await listBranchRefs(repo, repoId, options);
      expect(refs.find((ref) => ref.name === 'main')?.dirty.isDirty).toBe(false);
    });

    it('honours ignoreBranches globs', async () => {
      const refs = await listBranchRefs(repo, repoId, {
        ...options,
        ignoreBranches: ['release/*'],
      });
      expect(refs.map((ref) => ref.name)).not.toContain('release/1.0');
      expect(refs.map((ref) => ref.name)).toContain('feature');
    });

    it('returns nothing for a repository with an unborn HEAD', async () => {
      const unborn = join(base, 'unborn2');
      execFileSync('git', ['init', '-q', '-b', 'main', unborn], { stdio: 'pipe' });
      const refs = await listBranchRefs(
        { kind: 'user', rootPath: unborn, gitDir: join(unborn, '.git') },
        repoId,
        options,
      );
      expect(refs).toEqual([]);
    });

    it('handles a branch name containing a space in its path', async () => {
      const spaced = join(base, 'wt with space');
      git(root, 'worktree', 'add', '-q', '-b', 'spaced', spaced);
      const refs = await listBranchRefs(repo, repoId, options);
      expect(refs.find((ref) => ref.name === 'spaced')?.worktreePath).toBe(spaced);
    });
  });

  describe('mergeBase', () => {
    it('finds the common ancestor of two branches', async () => {
      const expected = git(root, 'rev-parse', 'HEAD').trim();
      expect(await mergeBase(repo, 'main', 'feature', options)).toBe(expected);
    });

    it('returns null for branches with no shared history', async () => {
      git(root, 'checkout', '-q', '--orphan', 'unrelated');
      writeFileSync(join(root, 'b.txt'), 'b\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'orphan');
      git(root, 'checkout', '-q', 'main');

      expect(await mergeBase(repo, 'main', 'unrelated', options)).toBeNull();
    });

    it('returns null for a ref that does not exist', async () => {
      expect(await mergeBase(repo, 'main', 'refs/heads/absent', options)).toBeNull();
    });
  });
});
