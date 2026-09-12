import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Where a process may be spawned from.
 *
 * The git runner is the only place Interlock invokes anything, and that is what
 * makes its read-only promise checkable: one call site, one allowlist, one
 * place to break it. This walks shipped source and names anywhere else that
 * so much as mentions the module.
 */

/** The one file allowed to spawn, relative to the repository root. */
export const ALLOWED_CALL_SITE = join('packages', 'core', 'src', 'git', 'repo-handle.ts');

/**
 * The module name rather than an import statement, so a dynamic `import()` or a
 * `createRequire` reaches the same answer as `import … from`. Both spellings,
 * since Node accepts either.
 */
const MENTION = /\bchild_process\b/u;

export interface SourceFile {
  /** Relative to the repository root, with the platform's separator. */
  readonly path: string;
  readonly content: string;
}

export interface CallSite {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Whether a path is shipped source: under a package's `src/`, and not a test.
 *
 * Tests and the benchmark build fixture repositories with `execFileSync` and
 * are right to — committing through the runner would test the runner with the
 * runner. What `tsc` builds is what a user runs, and that is the boundary.
 */
export function isShippedSource(path: string): boolean {
  const parts = path.split(sep);
  return (
    parts[0] === 'packages' &&
    parts[2] === 'src' &&
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.d.ts')
  );
}

/** Every mention of the module outside the one file allowed to have it. */
export function findCallSites(files: readonly SourceFile[]): CallSite[] {
  const found: CallSite[] = [];
  for (const file of files) {
    if (!isShippedSource(file.path) || file.path === ALLOWED_CALL_SITE) continue;
    file.content.split('\n').forEach((text, index) => {
      if (MENTION.test(text)) found.push({ path: file.path, line: index + 1, text: text.trim() });
    });
  }
  return found;
}

/** Every `.ts` file under a package's `src`, read, with paths relative to the root. */
export function readShippedSource(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const packages = join(root, 'packages');
  for (const name of readdirSync(packages)) {
    const src = join(packages, name, 'src');
    let isDirectory: boolean;
    try {
      isDirectory = statSync(src).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    walk(src, (path) => {
      const rel = relative(root, path);
      if (isShippedSource(rel)) files.push({ path: rel, content: readFileSync(path, 'utf8') });
    });
  }
  return files;
}

function walk(directory: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}
