import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, UserRepo } from '../src/git/repo-handle.js';
import { captureDirtyState } from '../src/git/worktree.js';
import { rejection } from './support/rejection.js';

/**
 * Snapshotting a worktree someone is working in.
 *
 * Every test asserts the user's repository afterwards, not only the tree: the
 * failure this code exists to prevent is a write to state that was never
 * committed and cannot be recovered, and a tree can be correct while the index
 * behind it has been destroyed.
 */
describe('captureDirtyState', () => {
  let dir: string;
  let repo: UserRepo;
  const runner = createGitRunner();

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  /**
   * Everything a capture must leave alone, read through git.
   *
   * Reading it moves `.git/index`: `git status` rewrites the file to refresh
   * its stat cache, keeping the contents byte-identical while the mtime
   * changes. The index is therefore measured separately, and after this — with
   * the two interleaved, the observation would be what fails the assertion.
   */
  const observable = (): Record<string, string> => ({
    status: git('status', '--porcelain'),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    stash: git('stash', 'list'),
    config: readFileSync(join(dir, '.git', 'config'), 'utf8'),
  });

  const indexBytes = (): string => readFileSync(join(dir, '.git', 'index')).toString('base64');
  const indexMtime = (): number => statSync(join(dir, '.git', 'index')).mtimeMs;

  /**
   * Snapshot the user's repository, run a capture, and assert nothing moved.
   *
   * Both the contents and the mtime of the index: contents are what the task
   * cannot afford to lose, and the mtime is what the user's own git reads to
   * decide whether its cache is still valid.
   */
  const leavingUserStateIntact = async <T>(capture: () => Promise<T>): Promise<T> => {
    const before = observable();
    const bytes = indexBytes();
    const mtime = indexMtime();

    const result = await capture();

    expect(indexBytes()).toBe(bytes);
    expect(indexMtime()).toBe(mtime);
    expect(observable()).toEqual(before);
    return result;
  };

  /**
   * Paths in a tree, read NUL-separated.
   *
   * Without `-z` git quotes and escapes any name holding a newline or a quote,
   * so the assertion would compare a rendering of the path rather than the path.
   */
  const treePaths = (oid: string): string[] =>
    git('ls-tree', '-r', '--name-only', '-z', oid).split('\0').filter(Boolean);

  beforeEach(() => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-wt-')));
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('a whole-tree capture', () => {
    it('records staged, unstaged and untracked work but not ignored files', async () => {
      writeFileSync(join(dir, 'staged.txt'), 'staged\n');
      git('add', 'staged.txt');
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
      writeFileSync(join(dir, 'ignored.txt'), 'secret\n');
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(treePaths(snapshot.treeOid)).toEqual([
        '.gitignore',
        'staged.txt',
        'tracked.txt',
        'untracked.txt',
      ]);
      expect(git('show', `${snapshot.treeOid}:tracked.txt`)).toBe('modified\n');
      expect(snapshot.clean).toBe(false);
    });

    it('records a deleted file as absent', async () => {
      rmSync(join(dir, 'tracked.txt'));
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(treePaths(snapshot.treeOid)).toEqual(['.gitignore']);
    });

    it('keeps a tracked file that also matches gitignore', async () => {
      // git honours the index over the ignore rules for a file already tracked,
      // so a snapshot rebuilt from the worktree alone would silently drop it.
      writeFileSync(join(dir, 'ignored.txt'), 'now tracked\n');
      git('add', '-f', 'ignored.txt');
      git('commit', '-qm', 'track an ignored path');
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(treePaths(snapshot.treeOid)).toContain('ignored.txt');
    });

    it('reports a clean worktree as the tree HEAD already records', async () => {
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(snapshot.clean).toBe(true);
      expect(snapshot.treeOid).toBe(git('rev-parse', 'HEAD^{tree}').trim());
    });

    it('captures a repository with nothing committed', async () => {
      const unborn = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-unborn-')));
      execFileSync('git', ['init', '-q', '-b', 'main', unborn], { stdio: 'pipe' });
      writeFileSync(join(unborn, 'first.txt'), 'first\n');

      try {
        const snapshot = await captureDirtyState(
          unborn,
          { kind: 'user', rootPath: unborn, gitDir: join(unborn, '.git') },
          { runner },
        );

        expect(
          execFileSync('git', ['-C', unborn, 'ls-tree', '-r', '--name-only', snapshot.treeOid], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('first.txt');
        // Nothing is committed, so there is no state for the worktree to match.
        expect(snapshot.clean).toBe(false);
      } finally {
        rmSync(unborn, { recursive: true, force: true });
      }
    });
  });

  describe('a scoped capture', () => {
    it('keeps uncommitted work outside the reported paths', async () => {
      // Seeded from HEAD this is the corrupt case: `earlier.txt` would snapshot
      // as its committed contents while the worktree holds something else.
      writeFileSync(join(dir, 'earlier.txt'), 'first round\n');
      const base = await captureDirtyState(dir, repo, { runner });

      writeFileSync(join(dir, 'earlier.txt'), 'edited between snapshots\n');
      writeFileSync(join(dir, 'reported.txt'), 'this round\n');
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: ['reported.txt'], baseTreeOid: base.treeOid },
        }),
      );

      expect(snapshot.takenAs).toBe('scoped');
      expect(git('show', `${snapshot.treeOid}:reported.txt`)).toBe('this round\n');
      // Carried from the base tree, not re-read from HEAD.
      expect(git('show', `${snapshot.treeOid}:earlier.txt`)).toBe('first round\n');
    });

    it('reuses the base tree when nothing reported turned out to be a change', async () => {
      const base = await captureDirtyState(dir, repo, { runner });

      const snapshot = await captureDirtyState(dir, repo, {
        runner,
        scope: { kind: 'scoped', paths: ['tracked.txt'], baseTreeOid: base.treeOid },
      });

      expect(snapshot.treeOid).toBe(base.treeOid);
      expect(snapshot.takenAs).toBe('scoped');
    });

    it.each([
      ['a path that is ignored', 'ignored.txt'],
      ['a path that no longer exists and never was tracked', 'vanished.txt'],
    ])('survives %s being reported', async (_name, path) => {
      // `git add` refuses the first and fails outright on the second, and both
      // are ordinary watcher output.
      writeFileSync(join(dir, 'ignored.txt'), 'secret\n');
      const base = await captureDirtyState(dir, repo, { runner });
      writeFileSync(join(dir, 'real.txt'), 'real\n');
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [path, 'real.txt'], baseTreeOid: base.treeOid },
        }),
      );

      expect(treePaths(snapshot.treeOid)).toContain('real.txt');
      expect(treePaths(snapshot.treeOid)).not.toContain('ignored.txt');
    });

    it.each([
      ['a space', 'has space.txt'],
      ['a newline', 'has\nnewline.txt'],
      ['a quote', 'has"quote.txt'],
    ])('handles a path containing %s', async (_name, name) => {
      // The status output is NUL-separated for exactly this: splitting it on
      // newlines would cut the second name in half and stage two paths that do
      // not exist.
      const base = await captureDirtyState(dir, repo, { runner });
      writeFileSync(join(dir, name), 'awkward\n');

      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [name], baseTreeOid: base.treeOid },
        }),
      );

      expect(treePaths(snapshot.treeOid)).toContain(name);
    });

    it('records a rename when both of its paths are reported', async () => {
      // A pathspec narrows rename detection too: scoped to the destination
      // alone git reports `A renamed.txt` with no source, so the source has to
      // arrive on its own account. A watcher sees both, because both moved.
      const base = await captureDirtyState(dir, repo, { runner });
      git('mv', 'tracked.txt', 'renamed.txt');
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: {
            kind: 'scoped',
            paths: ['renamed.txt', 'tracked.txt'],
            baseTreeOid: base.treeOid,
          },
        }),
      );

      const paths = treePaths(snapshot.treeOid);
      expect(paths).toContain('renamed.txt');
      // Restaged too, or the tree keeps a file that is no longer there.
      expect(paths).not.toContain('tracked.txt');
    });

    it.each([
      [
        'a file the user reverted',
        (): void => {
          writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
        },
      ],
      [
        'a staged new file that was unstaged and deleted',
        (): void => {
          git('rm', '--cached', '-q', 'added.txt');
          rmSync(join(dir, 'added.txt'));
        },
      ],
    ])('sees %s, which the user index reports as no change', async (_name, undo) => {
      // Asked against the user's index these answer "clean", because they are —
      // relative to HEAD. Relative to the tree being extended they are changes,
      // and a capture that misses them hands back content the worktree does not
      // have.
      writeFileSync(join(dir, 'tracked.txt'), 'EDITED\n');
      writeFileSync(join(dir, 'added.txt'), 'x\n');
      git('add', 'added.txt');
      const base = await captureDirtyState(dir, repo, { runner });

      undo();
      const paths = ['tracked.txt', 'added.txt'];
      const scoped = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths, baseTreeOid: base.treeOid },
        }),
      );
      const whole = await captureDirtyState(dir, repo, { runner });

      // The property that matters: scoped and whole-tree describe one worktree.
      expect(scoped.treeOid).toBe(whole.treeOid);
      expect(scoped.clean).toBe(whole.clean);
      expect(scoped.treeOid).not.toBe(base.treeOid);
    });

    it.each([
      ['an absolute path', '/etc/hosts'],
      ['a path climbing out of the worktree', '../escape.txt'],
    ])('refuses %s rather than failing the capture with a git error', async (_name, path) => {
      const base = await captureDirtyState(dir, repo, { runner });

      const error = await rejection(
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [path], baseTreeOid: base.treeOid },
        }),
      );

      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(error.message).toContain('relative to the worktree');
      expect(error.details.path).toBe(path);
      expect(error.infra).toBe(false);
    });

    it('falls back to a whole-tree capture when the base tree has been collected', async () => {
      // A user running `git gc --prune=now` can collect a tree Interlock holds,
      // because nothing references it. That is a reason to re-read, not to fail.
      writeFileSync(join(dir, 'present.txt'), 'present\n');
      const collected = '0000000000000000000000000000000000000001';
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: ['present.txt'], baseTreeOid: collected },
        }),
      );

      expect(snapshot.takenAs).toBe('whole-tree');
      expect(treePaths(snapshot.treeOid)).toContain('present.txt');
    });

    it('splits a path list too long for one command line', async () => {
      // Arguments and environment share a fixed budget, and the runner closes
      // stdin, so a long list has to be split across invocations.
      const many = Array.from(
        { length: 4_000 },
        (_, i) => `file-${String(i).padStart(5, '0')}.txt`,
      );
      for (const path of many) writeFileSync(join(dir, path), `${path}\n`);
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: {
            kind: 'scoped',
            paths: many,
            baseTreeOid: git('rev-parse', 'HEAD^{tree}').trim(),
          },
        }),
      );

      expect(treePaths(snapshot.treeOid)).toHaveLength(many.length + 2);
    });
  });

  describe('when the capture fails partway', () => {
    /** A runner that fails one verb, leaving everything before it done. */
    const failingAt = (verb: string): GitRunner => ({
      run: async (target, args, options): Promise<GitResult> => {
        if (args[0] === verb) throw new Error(`injected failure in git ${verb}`);
        return runner.run(target, args, options);
      },
    });

    it('leaves the user repository untouched when write-tree never runs', async () => {
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
      await leavingUserStateIntact(async () => {
        await expect(
          captureDirtyState(dir, repo, { runner: failingAt('write-tree') }),
        ).rejects.toThrow('injected failure');
      });
    });

    it('removes the temporary index on the error path', async () => {
      const indexDirs = (): string[] =>
        readdirSync(tmpdir()).filter((entry) => entry.startsWith('interlock-index-'));
      const before = new Set(indexDirs());

      await expect(
        captureDirtyState(dir, repo, { runner: failingAt('write-tree') }),
      ).rejects.toThrow('injected failure');

      expect(indexDirs().filter((entry) => !before.has(entry))).toEqual([]);
    });
  });
});
