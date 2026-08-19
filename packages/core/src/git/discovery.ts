import { InterlockError, ulid } from '@interlock/shared';
import type { BranchRef, DirtyState, Repo, RepoId, BranchRefId } from '@interlock/shared';
import type { AnyRepo, GitResult, GitRunner, UserRepo } from './repo-handle.js';

/**
 * Repo, branch and worktree discovery.
 *
 * Read-only plumbing against the user's repository: `rev-parse`,
 * `for-each-ref`, `worktree list`, `status --porcelain`.
 */

export interface DiscoveryOptions {
  readonly runner: GitRunner;
  /** Branch name globs to ignore, from the repo's config override. */
  readonly ignoreBranches?: readonly string[];
  /** Root of Interlock's data dir; shadow clones live under it. */
  readonly dataDir?: string;
}

/** Run a command whose non-zero exit means the repository is unusable. */
async function required(
  runner: GitRunner,
  repo: AnyRepo,
  args: readonly string[],
): Promise<GitResult> {
  const result = await runner.run(repo, args);
  if (result.exitCode !== 0) {
    throw new InterlockError('GIT_COMMAND_FAILED', `git ${args[0] ?? ''} failed`, {
      details: { rootPath: repo.rootPath, exitCode: result.exitCode },
      remedy: result.stderr.trim().slice(0, 200),
      infra: true,
    });
  }
  return result;
}

/**
 * A handle good enough to probe a path with.
 *
 * The runner reads only `rootPath`, and the real `gitDir` is what this probe is
 * being used to discover.
 */
function probeHandle(path: string): UserRepo {
  return { kind: 'user', rootPath: path, gitDir: '' };
}

/**
 * Resolve a path to the repository root that contains it.
 *
 * Rejects a bare repository: it has no working tree, so there is no in-flight
 * work to watch and nothing for the watcher to observe.
 *
 * Every path returned here and by {@link listBranchRefs} is canonical — git
 * resolves symlinks, so on macOS a `/var/...` argument comes back as
 * `/private/var/...`. Anything comparing paths against these, the watcher
 * above all, must resolve its own side or the two will never match.
 */
export async function openUserRepo(path: string, options: DiscoveryOptions): Promise<UserRepo> {
  const probe = probeHandle(path);

  const bare = await options.runner.run(probe, ['rev-parse', '--is-bare-repository']);
  if (bare.exitCode !== 0) {
    throw new InterlockError('REPO_NOT_GIT', `Not a git repository: ${path}`, {
      details: { path },
      remedy: 'Point Interlock at a directory inside a git repository.',
    });
  }
  if (bare.stdout.trim() === 'true') {
    throw new InterlockError('REPO_BARE', `Repository has no working tree: ${path}`, {
      details: { path },
      remedy:
        'Interlock watches repositories people work in; a bare repository has nothing in flight.',
    });
  }

  const root = await required(options.runner, probe, ['rev-parse', '--show-toplevel']);
  const rootPath = root.stdout.trim();
  const gitDir = await required(options.runner, probeHandle(rootPath), [
    'rev-parse',
    '--absolute-git-dir',
  ]);

  return { kind: 'user', rootPath, gitDir: gitDir.stdout.trim() };
}

/**
 * The branch in-flight work is expected to land on.
 *
 * Prefers what the remote declares, because that is what the team actually
 * merges into; falls back to the checked-out branch, then to `main` for a
 * repository with an unborn HEAD and no remote.
 */
async function resolveDefaultBranch(repo: UserRepo, runner: GitRunner): Promise<string> {
  const remote = await runner.run(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.exitCode === 0) {
    const name = remote.stdout.trim();
    const stripped = name.startsWith('origin/') ? name.slice('origin/'.length) : name;
    if (stripped !== '') return stripped;
  }

  const head = await runner.run(repo, ['symbolic-ref', '--short', 'HEAD']);
  if (head.exitCode === 0 && head.stdout.trim() !== '') return head.stdout.trim();

  return 'main';
}

/**
 * Read repo-level facts for a newly discovered repository: default branch,
 * shadow location, config override.
 *
 * Mints a fresh id, so this describes a first sighting. Recognising a repository
 * already seen is a lookup by `rootPath` in the store, not a second call here.
 */
export async function describeRepo(repo: UserRepo, options: DiscoveryOptions): Promise<Repo> {
  const defaultBranch = await resolveDefaultBranch(repo, options.runner);
  const now = new Date().toISOString();
  const id = ulid<RepoId>();

  return {
    id,
    rootPath: repo.rootPath,
    defaultBranch,
    shadowPath: shadowPathFor(id, options.dataDir),
    config: {},
    discoveredAt: now,
    lastSeenAt: now,
  };
}

function shadowPathFor(id: RepoId, dataDir: string | undefined): string {
  const base = dataDir ?? '';
  return `${base}/shadows/${id}`.replace(/\/+/gu, '/');
}

interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly ref: string | null;
  readonly prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain -z`.
 *
 * NUL-separated because a worktree path may contain a newline; blocks are
 * terminated by an empty field.
 */
function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let head: string | null = null;
  let ref: string | null = null;
  let prunable = false;

  const flush = (): void => {
    if (path !== null) entries.push({ path, head, ref, prunable });
    path = null;
    head = null;
    ref = null;
    prunable = false;
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
    } else if (key === 'HEAD') head = value;
    else if (key === 'branch') ref = value;
    else if (key === 'prunable') prunable = true;
  }
  flush();

  return entries;
}

/**
 * Parse `git status --porcelain -z` into staged, unstaged and untracked paths.
 *
 * A rename or copy emits the destination and then the source as two fields, so
 * the source is consumed rather than read as the next entry.
 */
function parseStatus(stdout: string): {
  staged: string[];
  unstaged: string[];
  untracked: string[];
} {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;

    const index = field[0]!;
    const worktree = field[1]!;
    const path = field.slice(3);

    if (index === '?' && worktree === '?') {
      untracked.push(path);
      continue;
    }
    if (index === 'R' || index === 'C') i++;
    if (index !== ' ' && index !== '?') staged.push(path);
    if (worktree !== ' ' && worktree !== '?') unstaged.push(path);
  }

  return { staged, unstaged, untracked };
}

async function readDirtyState(worktreePath: string, runner: GitRunner): Promise<DirtyState> {
  const status = await runner.run(probeHandle(worktreePath), ['status', '--porcelain', '-z']);
  const { staged, unstaged, untracked } = parseStatus(status.stdout);

  return {
    isDirty: staged.length + unstaged.length + untracked.length > 0,
    // Content identity is assigned when the working tree is snapshotted.
    snapshotId: null,
    stagedFiles: staged,
    unstagedFiles: unstaged,
    untrackedFiles: untracked,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Match a branch name against a glob supporting `*` only.
 *
 * Deliberately not a full glob implementation: `core` takes no dependencies,
 * and branch ignore rules in practice are `release/*` and `wip-*`.
 */
function matchesGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(name);
}

/**
 * List every in-flight line of work: local branches and linked worktrees, each
 * with its head, dirty state and, where known, owning agent session.
 *
 * A worktree with a detached HEAD is skipped: it has no ref to name, and every
 * downstream consumer keys off one. A worktree whose directory has been deleted
 * is skipped too — git still lists it until `worktree prune` runs.
 *
 * Ids are minted per observation. The stable key for a branch is
 * `(repoId, ref)`, and reconciling observations against stored rows belongs to
 * the store rather than here.
 */
export async function listBranchRefs(
  repo: UserRepo,
  repoId: RepoId,
  options: DiscoveryOptions,
): Promise<BranchRef[]> {
  const ignore = options.ignoreBranches ?? [];

  const refs = await required(options.runner, repo, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)',
    'refs/heads',
  ]);

  const worktrees = await required(options.runner, repo, ['worktree', 'list', '--porcelain', '-z']);
  const byRef = new Map<string, WorktreeEntry>();
  for (const entry of parseWorktreeList(worktrees.stdout)) {
    if (entry.prunable || entry.ref === null) continue;
    byRef.set(entry.ref, entry);
  }

  const now = new Date().toISOString();
  const result: BranchRef[] = [];

  // `for-each-ref` prints nothing for an unborn HEAD, which is the correct
  // answer: no branch object exists yet, so nothing is in flight.
  for (const line of refs.stdout.split('\n')) {
    if (line === '') continue;
    const [ref, headSha] = line.split('\t');
    if (ref === undefined || headSha === undefined) continue;

    const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    if (ignore.some((pattern) => matchesGlob(name, pattern))) continue;

    const worktree = byRef.get(ref) ?? null;
    const dirty =
      worktree === null ? cleanState(now) : await readDirtyState(worktree.path, options.runner);

    result.push({
      id: ulid<BranchRefId>(),
      repoId,
      ref,
      name,
      headSha,
      worktreePath: worktree?.path ?? null,
      dirty,
      sessionId: null,
      firstSeenAt: now,
      updatedAt: now,
    });
  }

  return result;
}

/** A branch with no worktree cannot have uncommitted work. */
function cleanState(now: string): DirtyState {
  return {
    isDirty: false,
    snapshotId: null,
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    capturedAt: now,
  };
}

/**
 * Merge-base of two refs; the third point of a three-way speculative merge.
 *
 * `null` when the two share no history. That is an ordinary answer for two
 * branches grafted from different roots, not a failure, and a pair without a
 * merge-base is simply not comparable.
 */
export async function mergeBase(
  repo: UserRepo,
  a: string,
  b: string,
  options: DiscoveryOptions,
): Promise<string | null> {
  const result = await options.runner.run(repo, ['merge-base', a, b]);
  if (result.exitCode !== 0) return null;

  const sha = result.stdout.trim();
  return sha === '' ? null : sha;
}
