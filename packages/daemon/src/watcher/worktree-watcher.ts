import { existsSync, readFileSync, realpathSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { InterlockError, pathIgnored, silentLogger } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { createDebouncer } from './debounce.js';
import type { Debouncer } from './debounce.js';

/**
 * The filesystem half of the watcher: a source of debounced change signals and
 * nothing else.
 *
 * Deliberately knows no git, no store and no bus. A signal names a path, and a
 * path does not identify a branch — a worktree can be checked out onto another
 * branch between the write and the lookup, so resolving identity here would
 * record it at the one moment it cannot be known. The reconciliation sweep
 * resolves it once, after the debounce, against current state.
 *
 * That split is also what keeps this testable against a temp directory.
 */

export type SignalKind = 'worktree' | 'ref';

export interface ChangeSignal {
  readonly kind: SignalKind;
  /** Canonical path of the worktree the signal belongs to. */
  readonly worktreePath: string;
  /**
   * What changed: worktree-relative for `worktree`, git-dir-relative for `ref`.
   *
   * Empty when the source could not name it — a degraded watcher polling, or an
   * event the OS delivered without a filename. The consumer must treat that as
   * "something changed, ask git", never as "nothing changed".
   */
  readonly paths: readonly string[];
}

export interface WatchTarget {
  readonly worktreePath: string;
  /** Git directory for this worktree; `HEAD` lives here. */
  readonly gitDir: string;
  /**
   * Shared git directory, when this is a linked worktree.
   *
   * A linked worktree has its own `HEAD` but no `refs/` — those live in the
   * main checkout's git dir, so a branch moving is invisible without this.
   */
  readonly commonDir?: string;
  /** Path globs the repository asked to be left alone. */
  readonly ignore?: readonly string[];
}

/** The kernel boundary, injectable so the degraded path can be exercised. */
export type WatchFactory = (path: string, options: { recursive: boolean }) => FSWatcher;

export interface WorktreeWatcherOptions {
  readonly onSignal: (signal: ChangeSignal) => void;
  readonly watchFactory?: WatchFactory;
  readonly logger?: Logger;
  readonly debounceMs?: number;
  readonly maxDebounceMs?: number;
  /** Interval used only after the OS refuses a watch. */
  readonly pollIntervalMs?: number;
}

export interface WorktreeWatcher {
  watch(target: WatchTarget): void;
  unwatch(worktreePath: string): void;
  close(): void;
  readonly watching: readonly string[];
  /** True when the OS refused a watch and this target fell back to polling. */
  isDegraded(worktreePath: string): boolean;
}

/**
 * Long enough to swallow an editor's save burst, short enough that the sweep
 * still feels immediate. The scheduler debounces again, on its own budget.
 *
 * The floor is the platform's, not a preference: macOS delivers a burst of
 * 20–50 writes over ~55ms with gaps of up to 50ms between events, so anything
 * near that splits one save into several signals.
 */
const DEFAULT_DEBOUNCE_MS = 250;

/** A continuous writer must not postpone a signal indefinitely. */
const DEFAULT_MAX_DEBOUNCE_MS = 2_000;

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Top-level git-dir entries worth a signal.
 *
 * `refs/` is watched separately and recursively; everything else in a git
 * directory is index churn, object writes and lock files, which say nothing
 * about a branch and arrive constantly.
 */
const REF_FILES: ReadonlySet<string> = new Set(['HEAD', 'packed-refs']);

interface WatchedTarget {
  readonly target: WatchTarget;
  /** Canonical, so a signal always names the path git would report. */
  readonly worktreePath: string;
  readonly watchers: FSWatcher[];
  poller: ReturnType<typeof setInterval> | null;
}

export function createWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const log = (options.logger ?? silentLogger).child('watcher');
  const watchFactory: WatchFactory =
    options.watchFactory ??
    ((path, watchOptions) => watch(path, { recursive: watchOptions.recursive, persistent: true }));
  const targets = new Map<string, WatchedTarget>();
  const keys = new Map<string, { kind: SignalKind; worktreePath: string }>();

  const debouncer: Debouncer = createDebouncer({
    waitMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxWaitMs: options.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS,
    onFlush: (key, values) => {
      const identity = keys.get(key);
      if (identity === undefined) return;
      options.onSignal({
        kind: identity.kind,
        worktreePath: identity.worktreePath,
        // The empty string is how an unnamed event is carried through the
        // batch; it is not a path anyone can act on.
        paths: values,
      });
    },
  });

  const push = (kind: SignalKind, worktreePath: string, value: string): void => {
    const key = `${kind}\0${worktreePath}`;
    keys.set(key, { kind, worktreePath });
    debouncer.push(key, value);
  };

  return {
    watch(target: WatchTarget): void {
      const worktreePath = canonical(target.worktreePath);
      if (targets.has(worktreePath)) return;

      const ignore = [...(target.ignore ?? []), ...gitignorePatterns(worktreePath, log)];
      const entry: WatchedTarget = { target, worktreePath, watchers: [], poller: null };
      targets.set(worktreePath, entry);

      const degrade = (reason: unknown): void => {
        // An OS watch limit is a property of the machine, not of the repository,
        // so this reports and keeps working rather than failing the target.
        log.warn('watch refused, falling back to polling', {
          worktreePath,
          reason: reason instanceof Error ? reason.message : String(reason),
        });
        stopWatchers(entry);
        // Emitted directly rather than through the debouncer. A poll tick is not
        // activity to coalesce, it is "time to look" — and feeding it into a
        // quiet-period timer means an interval shorter than the debounce keeps
        // restarting it, so the signal only ever escapes at the ceiling.
        entry.poller = setInterval(() => {
          options.onSignal({ kind: 'worktree', worktreePath, paths: [] });
        }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        // Nothing depends on the daemon staying alive for a poll tick.
        entry.poller.unref();
      };

      try {
        entry.watchers.push(
          watchTree(
            watchFactory,
            worktreePath,
            (filename) => {
              const rel = normalise(filename);
              if (rel === null) {
                push('worktree', worktreePath, '');
                return;
              }
              // `.git` is watched deliberately and separately; from here it is
              // index and object churn arriving on every command.
              if (rel === '.git' || rel.startsWith('.git/')) return;
              if (pathIgnored(rel, ignore)) return;
              push('worktree', worktreePath, rel);
            },
            degrade,
            log,
          ),
        );

        for (const dir of refDirsOf(target)) {
          entry.watchers.push(
            watchTree(
              watchFactory,
              dir.path,
              (filename) => {
                const rel = normalise(filename);
                if (rel === null) {
                  push('ref', worktreePath, '');
                  return;
                }
                if (dir.topLevelOnly && !REF_FILES.has(rel)) return;
                push('ref', worktreePath, dir.prefix + rel);
              },
              degrade,
              log,
              dir.topLevelOnly ? { recursive: false } : { recursive: true },
            ),
          );
        }
      } catch (error) {
        degrade(error);
      }
    },

    unwatch(worktreePath: string): void {
      const key = canonicalIfPossible(worktreePath);
      const entry = targets.get(key);
      if (entry === undefined) return;
      stopWatchers(entry);
      targets.delete(key);
      // Anything still batched names a worktree nobody is listening to now.
      debouncer.cancel(`worktree\0${key}`);
      debouncer.cancel(`ref\0${key}`);
    },

    close(): void {
      for (const entry of targets.values()) stopWatchers(entry);
      targets.clear();
      debouncer.cancel();
      keys.clear();
    },

    get watching(): readonly string[] {
      return [...targets.keys()];
    },

    isDegraded(worktreePath: string): boolean {
      return targets.get(canonicalIfPossible(worktreePath))?.poller != null;
    },
  };
}

/**
 * Patterns from the worktree's root `.gitignore`.
 *
 * Watching `node_modules` is the difference between the CPU budget and burning
 * a core, and the repository has already said not to look there.
 *
 * Two deliberate limits. Nested `.gitignore` files are not read — the offenders
 * that matter are declared at the root, and walking for them costs a directory
 * scan per watch. And a file using `!` is dropped whole rather than partly
 * applied: a negation rescues a path this matcher would exclude, and excluding
 * a file that changed loses a change, while watching one git ignores only costs
 * a wasted signal the sweep discards. The asymmetry decides it.
 */
function gitignorePatterns(worktreePath: string, log: Logger): string[] {
  let contents: string;
  try {
    contents = readFileSync(join(worktreePath, '.gitignore'), 'utf8');
  } catch {
    return [];
  }

  const lines = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.some((line) => line.startsWith('!'))) {
    log.debug('.gitignore uses negation; watching everything it names', { worktreePath });
    return [];
  }
  return lines;
}

interface RefDir {
  readonly path: string;
  /** Prefix restoring the git-dir-relative name a signal reports. */
  readonly prefix: string;
  readonly topLevelOnly: boolean;
}

/**
 * Where a branch moving becomes visible.
 *
 * `HEAD` is per-worktree and `refs/` is shared, so a linked worktree needs both
 * its own git dir and the common one — watching only the first misses every
 * commit, and watching only the second misses every checkout.
 */
function refDirsOf(target: WatchTarget): RefDir[] {
  const dirs: RefDir[] = [{ path: target.gitDir, prefix: '', topLevelOnly: true }];
  const shared = target.commonDir ?? target.gitDir;

  if (shared !== target.gitDir) {
    dirs.push({ path: shared, prefix: '', topLevelOnly: true });
  }
  const refs = `${shared}${sep}refs`;
  if (existsSync(refs)) dirs.push({ path: refs, prefix: 'refs/', topLevelOnly: false });

  return dirs.filter((dir) => existsSync(dir.path));
}

function watchTree(
  factory: WatchFactory,
  path: string,
  onName: (filename: string | null) => void,
  onFatal: (reason: unknown) => void,
  log: Logger,
  watchOptions: { recursive: boolean } = { recursive: true },
): FSWatcher {
  const watcher = factory(path, watchOptions);
  watcher.on('change', (_event, filename) => {
    onName(typeof filename === 'string' ? filename : null);
  });
  watcher.on('error', (error: NodeJS.ErrnoException) => {
    // A watched directory being deleted is ordinary — an agent removing a build
    // output, or the worktree itself going away — and must not take the daemon
    // with it.
    if (error.code === 'ENOENT') {
      log.debug('watched path disappeared', { path });
      watcher.close();
      return;
    }
    onFatal(error);
  });
  return watcher;
}

function stopWatchers(entry: WatchedTarget): void {
  for (const watcher of entry.watchers) {
    try {
      watcher.close();
    } catch {
      // Already closed by its own error handler.
    }
  }
  entry.watchers.length = 0;
  if (entry.poller !== null) {
    clearInterval(entry.poller);
    entry.poller = null;
  }
}

/**
 * Resolve to the path git would report.
 *
 * On macOS `/var` is a symlink to `/private/var`, so a worktree registered from
 * `tmpdir()` arrives from git canonicalised and a naive comparison never
 * matches.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new InterlockError('REPO_NOT_FOUND', 'The worktree to watch does not exist', {
      cause: error,
      details: { path },
      remedy: 'Pass a worktree that is on disk; a deleted one has nothing to watch.',
    });
  }
}

function canonicalIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Looking a target up by a path that has since been deleted still has to
    // find it, or it can never be unwatched.
    return path;
  }
}

/**
 * Normalise a reported filename to a `/`-separated relative path.
 *
 * Returns `null` when the platform gave no name, which is a real change with an
 * unknown path rather than no change at all.
 */
function normalise(filename: string | null): string | null {
  if (filename === null || filename === '') return null;
  const normalised = filename.split(sep).join('/');
  return normalised === '.' ? null : normalised;
}
