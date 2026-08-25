import { ulid } from '@interlock/shared';
import type {
  BranchRef,
  ChangeKind,
  ChangeSet,
  ChangeSetId,
  FileChange,
  Hunk,
  SnapshotId,
} from '@interlock/shared';
import { runRequired } from './repo-handle.js';
import type { GitRunner, UserRepo } from './repo-handle.js';

/**
 * ChangeSet extraction: the normalised diff of a branch against its merge-base,
 * including uncommitted work.
 *
 * Two consumers with different needs — the scheduler wants touched paths
 * cheaply, the AST layer wants hunks precise enough to map to symbols — so
 * {@link touchedPaths} answers the first with one command and
 * {@link extractChangeSet} pays for the second only when asked.
 */

/**
 * Options every diff here is run with.
 *
 * `--find-renames` is not a preference. Rename detection is configurable per
 * repository, and a watched repository setting `diff.renames = copies` changes
 * the *shape* of the output — copy pairs appear where an addition would be —
 * while `false` removes rename pairing altogether. Naming the flag pins both,
 * the same way the runner pins `core.fsmonitor`.
 *
 * `--no-ext-diff` and `--no-textconv` are inert for the summary forms, which
 * git computes internally, and load-bearing for the patch, which otherwise runs
 * whatever program the repository's own config names. They live here so the
 * decision is in one place rather than at each call site.
 */
const DIFF_BASE = ['diff', '--find-renames', '--no-ext-diff', '--no-textconv'] as const;

export interface DiffOptions {
  readonly runner: GitRunner;
  /**
   * The branch's uncommitted work, as recorded by a snapshot.
   *
   * Both halves or neither: the tree is what the diff runs against and the id
   * is what the result records having been computed from, and a `ChangeSet`
   * naming one without the other cannot be traced back to what produced it.
   * Omitted, the diff compares the branch head — the committed state alone.
   */
  readonly snapshot?: {
    readonly id: SnapshotId;
    readonly treeOid: string;
  };
}

/**
 * The normalised diff between a merge-base and a branch's current state.
 *
 * Symbols stay empty: mapping a hunk to the declarations it touches is the AST
 * layer's job, and a guess here would be evidence nobody checked.
 */
export async function extractChangeSet(
  repo: UserRepo,
  branch: BranchRef,
  mergeBaseSha: string,
  options: DiffOptions,
): Promise<ChangeSet> {
  const target = options.snapshot?.treeOid ?? branch.headSha;
  const { runner } = options;

  const named = await readNameStatus(repo, runner, mergeBaseSha, target);
  // Ordered identically to `named`: both come from one diff with one set of
  // options, so hunks are matched by position rather than by parsing a path out
  // of a patch header, which git quotes and escapes for awkward names.
  const [binary, hunks] = await Promise.all([
    readBinaryPaths(repo, runner, mergeBaseSha, target),
    readHunks(repo, runner, mergeBaseSha, target),
  ]);

  const files: FileChange[] = named.map((entry, index) => ({
    path: entry.path,
    previousPath: entry.previousPath,
    kind: entry.kind,
    hunks: hunks[index] ?? [],
    symbols: [],
    binary: binary.has(entry.path),
  }));

  return {
    id: ulid<ChangeSetId>(),
    branchRefId: branch.id,
    snapshotId: options.snapshot?.id ?? null,
    mergeBaseSha,
    headSha: branch.headSha,
    files,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Paths a branch touches, from one command.
 *
 * Both sides of a rename count: the source is gone and the destination is new,
 * and a pair that overlaps on either is a pair worth looking at.
 */
export async function touchedPaths(
  repo: UserRepo,
  branch: BranchRef,
  mergeBaseSha: string,
  options: DiffOptions,
): Promise<string[]> {
  const target = options.snapshot?.treeOid ?? branch.headSha;
  const named = await readNameStatus(repo, options.runner, mergeBaseSha, target);

  const paths = new Set<string>();
  for (const entry of named) {
    paths.add(entry.path);
    if (entry.previousPath !== null) paths.add(entry.previousPath);
  }
  return [...paths];
}

interface NamedChange {
  readonly kind: ChangeKind;
  readonly path: string;
  readonly previousPath: string | null;
}

async function readNameStatus(
  repo: UserRepo,
  runner: GitRunner,
  base: string,
  target: string,
): Promise<NamedChange[]> {
  const result = await runRequired(runner, repo, [
    ...DIFF_BASE,
    '--name-status',
    '-z',
    base,
    target,
  ]);
  return parseNameStatus(result.stdout);
}

/**
 * Parse `diff --name-status -z`.
 *
 * The status letter is its own field, followed by one path — or by two for a
 * rename or copy, **source first**. That order is the reverse of `status
 * --porcelain -z`, which puts the destination first, and the two are easy to
 * conflate when reading one parser beside the other.
 */
export function parseNameStatus(stdout: string): NamedChange[] {
  const fields = stdout.split('\0');
  const changes: NamedChange[] = [];

  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (status === undefined || status === '') continue;

    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      const source = fields[++i];
      const destination = fields[++i];
      if (source === undefined || destination === undefined) break;
      changes.push({
        // A copy leaves its source in place, so the destination is simply new.
        // `previousPath` means "this path no longer exists", which a copy's
        // source still does.
        kind: letter === 'R' ? 'renamed' : 'added',
        path: destination,
        previousPath: letter === 'R' ? source : null,
      });
      continue;
    }

    const path = fields[++i];
    if (path === undefined) break;
    changes.push({ kind: kindOf(letter), path, previousPath: null });
  }

  return changes;
}

/**
 * Map a status letter onto the kinds the model has.
 *
 * Anything unrecognised counts as modified rather than being dropped. A letter
 * this does not know about still names a path that differs between the two
 * sides, and losing it would understate what a branch touches — the one error
 * this cannot afford, because a pair that never appears is never compared.
 */
function kindOf(letter: string): ChangeKind {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    default:
      return 'modified';
  }
}

/**
 * Paths git cannot diff as text.
 *
 * `--numstat` reports them as `-` for both counts, which is a machine-readable
 * answer. The patch says "Binary files … differ", which is prose and has to be
 * matched as such.
 */
async function readBinaryPaths(
  repo: UserRepo,
  runner: GitRunner,
  base: string,
  target: string,
): Promise<Set<string>> {
  const result = await runRequired(runner, repo, [...DIFF_BASE, '--numstat', '-z', base, target]);
  return parseBinaryPaths(result.stdout);
}

/**
 * Parse `diff --numstat -z` for the paths reported as binary.
 *
 * Each field is `added`, `deleted` and the path, tab-separated — except for a
 * rename, where the path is empty and the two paths follow as their own fields.
 */
export function parseBinaryPaths(stdout: string): Set<string> {
  const fields = stdout.split('\0');
  const binary = new Set<string>();

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field === '') continue;

    const [added, deleted, path] = field.split('\t');
    const isBinary = added === '-' && deleted === '-';

    if (path === '') {
      // A rename: the source and destination follow, and the destination is
      // the path this change is recorded under.
      i++;
      const destination = fields[++i];
      if (destination === undefined) break;
      if (isBinary) binary.add(destination);
      continue;
    }
    if (path !== undefined && isBinary) binary.add(path);
  }

  return binary;
}

/**
 * Hunk ranges per file, in the order the files were reported.
 *
 * `--unified=0` because only the ranges are wanted: context lines widen every
 * hunk and merge neighbouring ones, which would understate how many distinct
 * regions a file changed in.
 */
async function readHunks(
  repo: UserRepo,
  runner: GitRunner,
  base: string,
  target: string,
): Promise<Hunk[][]> {
  const result = await runRequired(runner, repo, [...DIFF_BASE, '--unified=0', base, target]);
  return parseHunks(result.stdout);
}

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@`, where a count of 1 is omitted. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Split a patch into one hunk list per file.
 *
 * Sections are counted, not named. git emits one `diff --git` line per changed
 * file in the same order as `--name-status`, including for a binary file and
 * for a change that is only a mode — both of which produce a section with no
 * hunks in it. Reading the path back out of that line would mean undoing git's
 * quoting for names holding a space, a quote or a newline.
 */
export function parseHunks(patch: string): Hunk[][] {
  const perFile: Hunk[][] = [];
  let current: Hunk[] | null = null;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = [];
      perFile.push(current);
      continue;
    }
    if (current === null || !line.startsWith('@@ ')) continue;

    const match = HUNK_HEADER.exec(line);
    if (match === null) continue;
    current.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }

  return perFile;
}
