import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isWithin, runRequired } from './repo-handle.js';
import type { GitRunner, UserRepo } from './repo-handle.js';

/**
 * Every directory that belongs to the repository at `repo`: each of its
 * worktrees, the main one included, and its common git directory.
 *
 * Asked of git rather than derived from a path: a linked worktree names neither
 * the main checkout nor the git directory, a git directory can be kept apart
 * from its checkout, and an object store can be a symlink to somewhere else, so
 * no path joined by hand is reliably any of them. Both answers are read-only.
 *
 * For a git directory kept apart from its checkout, git lists the git directory
 * itself as the main worktree, and nothing it holds names the checkout: seen
 * from a linked worktree, that checkout cannot be found. From the checkout
 * itself, it is the path asked about.
 */
export async function repositoryDirsOf(repo: UserRepo, runner: GitRunner): Promise<string[]> {
  const worktrees = await runRequired(runner, repo, ['worktree', 'list', '--porcelain', '-z']);
  const common = await runRequired(runner, repo, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  // One trailing newline, and only that: the path itself may end in another.
  const commonDir = common.stdout.replace(/\n$/u, '');
  return [...parseWorktreeList(worktrees.stdout).map((entry) => entry.path), commonDir];
}

/**
 * The directory in `dirs` that `path` would resolve inside, or null if none.
 *
 * `path` need not exist yet, so the deepest part of it that does is what
 * resolves, and the rest is joined back on; each of `dirs` resolves the same
 * way, so a symlink on either side is followed before they are compared.
 */
export function dirHolding(path: string, dirs: readonly string[]): string | null {
  const target = resolveDeepest(path);
  return dirs.find((dir) => isWithin(resolveDeepest(dir), target)) ?? null;
}

/**
 * `path` with its deepest existing ancestor resolved and the rest joined back.
 *
 * Any failure to resolve is read as "does not exist yet", unreadable included:
 * a directory this process cannot read is one it cannot create anything inside
 * either, so the refusal it might have missed is made by `mkdir` instead.
 */
function resolveDeepest(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

export interface WorktreeEntry {
  readonly path: string;
  readonly ref: string | null;
  readonly prunable: boolean;
  readonly locked: boolean;
}

/**
 * Parse `git worktree list --porcelain -z`.
 *
 * NUL-separated because a worktree path may contain a newline; blocks are
 * terminated by an empty field.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let ref: string | null = null;
  let prunable = false;
  let locked = false;

  const flush = (): void => {
    if (path !== null) entries.push({ path, ref, prunable, locked });
    path = null;
    ref = null;
    prunable = false;
    locked = false;
  };

  for (const field of stdout.split('\0')) {
    if (field === '') {
      flush();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);

    if (key === 'worktree') {
      flush();
      path = value;
    } else if (key === 'branch') ref = value;
    else if (key === 'prunable') prunable = true;
    else if (key === 'locked') locked = true;
  }
  flush();

  return entries;
}
