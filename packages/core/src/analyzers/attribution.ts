import { posix } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { InterlockError, redact, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  ChangeSet,
  Evidence,
  FileChange,
  Finding,
  FindingId,
  Hunk,
  Logger,
  ProcessOutputEvidence,
  SpanEvidence,
  SpeculativeRunId,
  SymbolTrailStep,
} from '@interlock/shared';
import type ts from 'typescript';
import type { GitRunner } from '../git/repo-handle.js';
import {
  BlobReader,
  excerptOf,
  looksBinary,
  MAX_ALIGN_EDITS,
  MAX_FINDINGS_PER_RUN,
  MAX_SPANS_PER_SIDE,
} from '../merge/conflict-classifier.js';
import type { TreeEntry } from '../merge/conflict-classifier.js';
import { alignLines } from '../merge/line-diff.js';
import { REGULAR_MODES } from '../merge/speculative-merge.js';
import type { SpeculativeMergeRequest } from '../merge/speculative-merge.js';
import type { FileDiagnostic } from './typecheck.js';

/**
 * Attribution: a compiler diagnostic from a merged tree, turned into a
 * statement about the two branches — which one changed the declaration it
 * names, which one holds the stale reference, a span on each in that branch's
 * own lines, and the rule the pair breaks.
 *
 * A wrong accusation costs more of an agent's trust than a vague warning, so
 * every decision here has an exit: when one cannot be made, the Finding names
 * no branch, says why, and carries a lower confidence. The algorithm and the
 * order its questions are asked in are in `notes.md` beside this file.
 */

/**
 * The rules an attributed Finding can carry.
 *
 * Named as the evaluation suite's labels name them, which were written first
 * and are read-only: a rule spelt otherwise scores recall 0 against them. Never
 * a compiler code, whose numbering is TypeScript's and says nothing about the
 * two branches.
 */
export const ATTRIBUTION_RULES = {
  rename: 'rename-vs-callsite',
  signature: 'signature-vs-caller',
  movedExport: 'moved-export-vs-import',
  /**
   * The merge breaks the typecheck and no narrower rule is known: every
   * unattributed Finding, and a declaration one branch removed outright. Named
   * after the suite's `merge-breaks-test`.
   */
  generic: 'merge-breaks-typecheck',
} as const;

export type AttributionRule = (typeof ATTRIBUTION_RULES)[keyof typeof ATTRIBUTION_RULES];

/** Confidence of a Finding whose two halves are each traced to one branch. */
export const ATTRIBUTED_CONFIDENCE = 1;

/**
 * Confidence of a Finding that names no branch.
 *
 * The compiler error is real — the merged tree does not compile — so it is
 * still raised; what is uncertain is whose change it is, and the noise budget
 * weighs it below one that says.
 */
export const UNATTRIBUTED_CONFIDENCE = 0.5;

/**
 * What `tsc --noEmit` exits with when it reports an error.
 *
 * The service's diagnostics are held equal to that run's, so its output is
 * recorded as that run's would be.
 */
export const TSC_ERROR_EXIT = 2;

/** The longest compiler output a Finding keeps, in code points, after redaction. */
export const MAX_TOOL_OUTPUT_CHARS = 2000;

/**
 * At most this many files of a branch's ChangeSet are read looking for where a
 * declaration moved to, or for a member a property names.
 *
 * Each is a `cat-file` and a parse on the daemon's thread, and the repository
 * decides how many files a branch touches. Past the bound the search finds
 * nothing, which costs a narrower rule and never names a wrong branch.
 */
export const MAX_SCANNED_FILES = 64;

/**
 * A file larger than this is not parsed, and attribution through it names no
 * branch.
 *
 * Parsing runs on the daemon's thread, one file a turn, and costs about 130 ms
 * a megabyte once warm: the cap holds the longest stall to a few tens of
 * milliseconds. Hand-written source is rarely near it; what is — bundles,
 * generated tables — is not where a stale reference an agent can fix lives.
 */
export const MAX_PARSED_BYTES = 256 * 1024;

/**
 * Why a Finding names no branch, in the order the questions are asked: the
 * first that applies is the one a Finding reports.
 */
export const UNATTRIBUTED_REASONS = [
  'unrecognised-code',
  'unreadable-location',
  'missing-change-set',
  'declaration-not-found',
  'stale-change-set',
  'reference-in-base',
  'both-changed-declaration',
  'neither-changed-declaration',
  'change-does-not-explain',
  'mapping-unsure',
  'both-hold-reference',
  'neither-holds-reference',
  'same-branch',
] as const;

export type UnattributedReason = (typeof UNATTRIBUTED_REASONS)[number];

/**
 * Each reason as a Finding states it. Fixed text: a rationale can reach a
 * reader unwrapped, so nothing a repository chose is ever put in one.
 */
export const UNATTRIBUTED_RATIONALES: Readonly<Record<UnattributedReason, string>> = {
  'unrecognised-code':
    'The compiler reported a diagnostic of a kind attribution does not read, so which branch caused it was not looked for.',
  'unreadable-location':
    "The diagnostic's location in the merged tree does not hold the reference its code describes, or the file there could not be read.",
  'missing-change-set': 'A branch has no ChangeSet, so what it changed is not known.',
  'declaration-not-found':
    'The declaration the diagnostic names could not be found in the merge base: it comes from a package or a global, is not a function where one was called, or is one of several candidates.',
  'stale-change-set':
    "A branch's ChangeSet does not describe the commit that was merged, so what it changed is not known.",
  'reference-in-base': 'The reference was already in the merge base, so neither branch added it.',
  'both-changed-declaration': 'Both branches changed the declaration the diagnostic names.',
  'neither-changed-declaration': 'Neither branch changed the declaration the diagnostic names.',
  'change-does-not-explain':
    'The branch that changed the declaration still has it as the diagnostic needs it, so its change does not explain the diagnostic.',
  'mapping-unsure':
    "The line holding the reference could not be placed in one branch's file, so which branch added it is not known.",
  'both-hold-reference': 'Both branches added the line holding the reference.',
  'neither-holds-reference': 'Neither branch added the line holding the reference.',
  'same-branch':
    'One branch both changed the declaration and added the reference to it, so the merge did not cause the break.',
};

// --- Codes ------------------------------------------------------------------------

/**
 * What a diagnostic says is wrong. A _name_ no longer resolves — the reference
 * outlived a rename, a move or a removal — or an _arity_ no longer fits — the
 * call outlived a change to the parameters.
 */
export type CodeFamily = 'name' | 'arity';

/**
 * Where a name is looked for. `import`: a module's export, through a named or
 * namespace import. `property`: a member of a class or an interface. `local`: a
 * declaration at the top of the reference's own file.
 */
export type ReferenceShape = 'import' | 'property' | 'local';

export interface RecognisedCode {
  readonly family: CodeFamily;
  /** The syntax the diagnostic's location must hold; null where the callee decides. */
  readonly shape: ReferenceShape | null;
}

/**
 * The codes attribution reads. A code says the family and no more: the rename
 * and the moved-export fixtures both report 2305, an import of a name the
 * module no longer exports, so which rule applies is found from what the
 * declaring branch did, never from the code.
 */
const CODES: ReadonlyMap<number, RecognisedCode> = new Map<number, RecognisedCode>([
  // Cannot find name, and its "did you mean" twin.
  [2304, { family: 'name', shape: 'local' }],
  [2552, { family: 'name', shape: 'local' }],
  // Property does not exist on a type, and its twin.
  [2339, { family: 'name', shape: 'property' }],
  [2551, { family: 'name', shape: 'property' }],
  // Module has no exported member: plain, "did you mean a default import", and
  // "did you mean another member".
  [2305, { family: 'name', shape: 'import' }],
  [2614, { family: 'name', shape: 'import' }],
  [2724, { family: 'name', shape: 'import' }],
  // Expected N arguments, and expected at least N.
  [2554, { family: 'arity', shape: null }],
  [2555, { family: 'arity', shape: null }],
]);

/** The family a diagnostic code belongs to, or null for one attribution does not read. */
export function recognise(code: number): RecognisedCode | null {
  return CODES.get(code) ?? null;
}

// --- Lines ------------------------------------------------------------------------

/**
 * Where a line of one file is in another: exactly, or somewhere between two
 * lines that are. `between` is 1-based and inclusive, and empty — `to` one less
 * than `from` — where nothing lies between the two neighbours.
 */
export type LinePlace =
  | { readonly kind: 'exact'; readonly line: number }
  | { readonly kind: 'between'; readonly from: number; readonly to: number };

/**
 * Where 1-based `line` of `from` sits in `to`, or null when the two differ by
 * too much to align.
 *
 * Exact when the line is aligned. Otherwise the lines of `to` strictly between
 * the images of its nearest aligned neighbours: where the line would be, which
 * is all that can be said without a guess.
 */
export function mapLine(
  from: readonly string[],
  to: readonly string[],
  line: number,
): LinePlace | null {
  const match = alignLines(from, to, MAX_ALIGN_EDITS);
  if (match === null) return null;
  const image = match[line - 1];
  if (image !== undefined && image !== -1) return { kind: 'exact', line: image + 1 };
  return { kind: 'between', ...between(match, line - 1, line - 1, to.length) };
}

/**
 * The lines of `to` that 1-based lines `start`–`end` of `from` became, or null
 * when the two differ by too much to align.
 *
 * Everything strictly between the images of the nearest aligned lines outside
 * the range: a line inside it that was changed or renamed has no image of its
 * own, and the anchors either side still bound where it went.
 */
export function mapRange(
  from: readonly string[],
  to: readonly string[],
  start: number,
  end: number,
): { readonly from: number; readonly to: number } | null {
  const match = alignLines(from, to, MAX_ALIGN_EDITS);
  if (match === null) return null;
  return between(match, start - 1, end - 1, to.length);
}

function between(
  match: Int32Array,
  first: number,
  last: number,
  length: number,
): { readonly from: number; readonly to: number } {
  let before = -1;
  for (let index = first - 1; index >= 0; index--) {
    if (match[index] !== -1) {
      before = match[index]!;
      break;
    }
  }
  let after = length;
  for (let index = last + 1; index < match.length; index++) {
    if (match[index] !== -1) {
      after = match[index]!;
      break;
    }
  }
  // Zero-based images before and after; the lines strictly between, 1-based.
  return { from: before + 2, to: after };
}

/**
 * Whether a `--unified=0` hunk changes any of 1-based lines `start`–`end` of
 * the old file.
 *
 * A hunk that removes nothing (`oldLines` 0) names the line its insertion
 * follows, so it lands inside the range only when it follows a line of the
 * range other than the last.
 */
export function hunkTouchesOld(hunk: Hunk, start: number, end: number): boolean {
  if (hunk.oldLines === 0) return hunk.oldStart >= start && hunk.oldStart < end;
  return hunk.oldStart <= end && start <= hunk.oldStart + hunk.oldLines - 1;
}

/**
 * Whether a `--unified=0` hunk wrote 1-based line `line` of the new file. A
 * deletion writes nothing: with `newLines` 0 the range is empty.
 */
export function hunkAddsNew(hunk: Hunk, line: number): boolean {
  return hunk.newStart <= line && line <= hunk.newStart + hunk.newLines - 1;
}

// --- The decision -----------------------------------------------------------------

export type Side = 'a' | 'b';

/** What a declaring branch did to the declaration, read from its own tree. */
export type DeclarationChange = 'renamed' | 'moved' | 'removed' | 'signature-changed';

/** Whether a branch's ChangeSet adds the reference's line; `unsure` when it could not be placed. */
export type Adds = 'yes' | 'no' | 'unsure';

/** One branch's facts, each established from its own ChangeSet and its own tree. */
export interface SideFacts {
  /** Its ChangeSet touches the declaration: a hunk crosses it, or its file was deleted or renamed. */
  readonly touches: boolean;
  /** What its tree shows of the declaration, when that explains the diagnostic. */
  readonly change: DeclarationChange | null;
  readonly adds: Adds;
  /** Its own file holds the reference's line, placed exactly. */
  readonly holds: boolean;
}

export type Decision =
  | {
      readonly kind: 'attributed';
      readonly origin: Side;
      readonly referencing: Side;
      readonly change: DeclarationChange;
    }
  | { readonly kind: 'unattributed'; readonly reason: UnattributedReason };

/**
 * Which branch broke which half, from both branches' facts, or why that cannot
 * be told.
 *
 * Exactly one branch must have touched the declaration, in a way the
 * diagnostic explains; exactly one must have added the reference; and they
 * must differ. Anything else names no branch: guessing between two candidates,
 * or naming the only one that touched the declaration when its change does not
 * explain the error, is the accusation that costs the most trust when wrong.
 */
export function decide(a: SideFacts, b: SideFacts): Decision {
  const facts = { a, b };
  const sides = ['a', 'b'] as const;
  const unattributed = (reason: UnattributedReason): Decision => ({ kind: 'unattributed', reason });

  if (a.adds === 'no' && b.adds === 'no' && a.holds && b.holds) {
    return unattributed('reference-in-base');
  }
  const touching = sides.filter((side) => facts[side].touches);
  if (touching.length === 2) return unattributed('both-changed-declaration');
  const origin = touching[0];
  if (origin === undefined) return unattributed('neither-changed-declaration');
  const change = facts[origin].change;
  if (change === null) return unattributed('change-does-not-explain');
  if (a.adds === 'unsure' || b.adds === 'unsure') return unattributed('mapping-unsure');
  const adding = sides.filter((side) => facts[side].adds === 'yes');
  if (adding.length === 2) return unattributed('both-hold-reference');
  const referencing = adding[0];
  if (referencing === undefined) return unattributed('neither-holds-reference');
  if (referencing === origin) return unattributed('same-branch');
  return { kind: 'attributed', origin, referencing, change };
}

/**
 * The rule a declaring branch's change breaks. A removal has no rule narrower
 * than the generic one: nothing in the evaluation's labels names it, and
 * calling it a rename would claim a new name that does not exist.
 */
export function ruleFor(change: DeclarationChange): AttributionRule {
  switch (change) {
    case 'renamed':
      return ATTRIBUTION_RULES.rename;
    case 'moved':
      return ATTRIBUTION_RULES.movedExport;
    case 'signature-changed':
      return ATTRIBUTION_RULES.signature;
    case 'removed':
      return ATTRIBUTION_RULES.generic;
  }
}

// --- Declarations -----------------------------------------------------------------

type Compiler = typeof ts;

/** One parameter list's bounds on its arguments; `max` null for a rest parameter. */
export interface Arity {
  readonly min: number;
  readonly max: number | null;
}

/**
 * The arguments a function-like declaration takes, or null for anything that
 * is not one — a variable or a property holding an arrow or a function
 * expression counts.
 *
 * `min` is one past the last parameter that is neither optional, defaulted nor
 * rest, as the compiler counts it: a defaulted parameter followed by a
 * required one is still required. A `this` parameter is not an argument.
 */
export function arityOf(t: Compiler, node: ts.Node): Arity | null {
  const fn = functionOf(t, node);
  if (fn === null) return null;
  const parameters = fn.parameters.filter(
    (parameter) => !(t.isIdentifier(parameter.name) && parameter.name.text === 'this'),
  );
  let min = 0;
  parameters.forEach((parameter, index) => {
    const optional =
      parameter.questionToken !== undefined ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined;
    if (!optional) min = index + 1;
  });
  const rest = parameters.some((parameter) => parameter.dotDotDotToken !== undefined);
  return { min, max: rest ? null : parameters.length };
}

function functionOf(t: Compiler, node: ts.Node): ts.SignatureDeclaration | null {
  if (
    t.isFunctionDeclaration(node) ||
    t.isMethodDeclaration(node) ||
    t.isMethodSignature(node) ||
    t.isArrowFunction(node) ||
    t.isFunctionExpression(node)
  ) {
    return node;
  }
  if (
    (t.isVariableDeclaration(node) || t.isPropertyDeclaration(node)) &&
    node.initializer !== undefined
  ) {
    const value = node.initializer;
    if (t.isArrowFunction(value) || t.isFunctionExpression(value)) return value;
  }
  return null;
}

/** A named declaration, as one tree has it. Lines and columns are 1-based. */
export interface Declared {
  readonly name: string;
  readonly kind: ts.SyntaxKind;
  /** The class or interface holding a member; null at the top of the file. */
  readonly container: string | null;
  readonly exported: boolean;
  readonly start: number;
  readonly nameLine: number;
  readonly nameColumn: number;
  /** The line closing its parameters, for a function; its name's line otherwise. */
  readonly paramsEnd: number;
  readonly end: number;
  /** Every signature, overloads included, as a key two trees compare; null for a non-function. */
  readonly arity: string | null;
}

/** What one file declares, as {@link declarationsOf} reads it. */
export interface Declarations {
  readonly all: readonly Declared[];
  /** `export { local as exported }` without a module: exported name to local name. */
  readonly exportedAs: ReadonlyMap<string, string>;
}

/**
 * The declarations a file makes at its top level and in its classes and
 * interfaces. A named import counts as a top-level binding — a name a file
 * stops importing is a name it stops declaring — and a re-export from another
 * module counts as an export of the file. Nothing nested in a function is read.
 */
export function declarationsOf(t: Compiler, file: ts.SourceFile): Declarations {
  const all: Declared[] = [];
  const exportedAs = new Map<string, string>();
  const line = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1;
  const column = (position: number): number =>
    file.getLineAndCharacterOfPosition(position).character + 1;

  // Overloads are one declaration: their signatures together are its arity,
  // and an implementation behind them is not one a caller can call.
  const add = (
    nodes: readonly ts.Node[],
    name: ts.Identifier,
    container: string | null,
    exported: boolean,
    statement: ts.Node = nodes[0]!,
  ): void => {
    const first = nodes[0]!;
    const bodied = nodes.filter((node) => (node as { body?: unknown }).body !== undefined);
    const signatures =
      nodes.length > 1 && bodied.length === 1 ? nodes.filter((node) => node !== bodied[0]) : nodes;
    const arities = signatures.map((node) => arityOf(t, node));
    all.push({
      name: name.text,
      kind: first.kind,
      container,
      exported,
      start: line(statement.getStart(file)),
      nameLine: line(name.getStart(file)),
      nameColumn: column(name.getStart(file)),
      paramsEnd: closeParenLine(t, file, first) ?? line(name.getStart(file)),
      end: line(nodes[nodes.length - 1]!.getEnd()),
      arity: arities.every((arity) => arity !== null)
        ? JSON.stringify(arities.map((arity) => [arity.min, arity.max]).sort())
        : null,
    });
  };
  const isExported = (node: ts.Node): boolean =>
    t.canHaveModifiers(node) &&
    (t.getModifiers(node) ?? []).some((modifier) => modifier.kind === t.SyntaxKind.ExportKeyword);
  const nameOf = (node: ts.Node): ts.Identifier | null => {
    const name = (node as { name?: ts.Node }).name;
    return name !== undefined && t.isIdentifier(name) ? name : null;
  };
  const grouped = (
    members: readonly ts.Node[],
    container: string | null,
    exported: (node: ts.Node) => boolean,
  ): void => {
    const byName = new Map<string, ts.Node[]>();
    for (const member of members) {
      const name = nameOf(member);
      if (name === null) continue;
      const key = `${String(member.kind)}:${name.text}`;
      byName.set(key, [...(byName.get(key) ?? []), member]);
    }
    for (const group of byName.values()) {
      add(group, nameOf(group[0]!)!, container, exported(group[0]!));
    }
  };

  const functions: ts.FunctionDeclaration[] = [];
  for (const statement of file.statements) {
    if (t.isFunctionDeclaration(statement)) {
      functions.push(statement);
    } else if (t.isClassDeclaration(statement) || t.isInterfaceDeclaration(statement)) {
      const name = nameOf(statement);
      if (name === null) continue;
      const exported = isExported(statement);
      add([statement], name, null, exported);
      const members = (statement.members as ts.NodeArray<ts.Node>).filter(
        (member) =>
          t.isMethodDeclaration(member) ||
          t.isPropertyDeclaration(member) ||
          t.isGetAccessorDeclaration(member) ||
          t.isSetAccessorDeclaration(member) ||
          t.isMethodSignature(member) ||
          t.isPropertySignature(member),
      );
      grouped(members, name.text, () => exported);
    } else if (t.isTypeAliasDeclaration(statement) || t.isEnumDeclaration(statement)) {
      add([statement], statement.name, null, isExported(statement));
    } else if (t.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      for (const declaration of declarations) {
        if (!t.isIdentifier(declaration.name)) continue;
        // One declarator owns the statement's lines; several each own their own.
        const owner = declarations.length === 1 ? statement : declaration;
        add([declaration], declaration.name, null, isExported(statement), owner);
      }
    } else if (t.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !t.isNamedImports(bindings)) continue;
      for (const specifier of bindings.elements) {
        add([specifier], specifier.name, null, false, statement);
      }
    } else if (t.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined || !t.isNamedExports(clause)) continue;
      for (const specifier of clause.elements) {
        if (statement.moduleSpecifier === undefined) {
          exportedAs.set(specifier.name.text, (specifier.propertyName ?? specifier.name).text);
        } else if (t.isIdentifier(specifier.name)) {
          add([specifier], specifier.name, null, true, statement);
        }
      }
    }
  }
  grouped(functions, null, isExported);
  return { all, exportedAs };
}

function closeParenLine(t: Compiler, file: ts.SourceFile, node: ts.Node): number | null {
  const fn = functionOf(t, node);
  if (fn === null) return null;
  const close = fn.getChildren(file).find((child) => child.kind === t.SyntaxKind.CloseParenToken);
  return close === undefined
    ? null
    : file.getLineAndCharacterOfPosition(close.getStart(file)).line + 1;
}

/** What a file exports under `name`: an exported declaration, a local export, or a re-export. */
export function exportsNamed(declarations: Declarations, name: string): Declared[] {
  const direct = declarations.all.filter(
    (declared) => declared.container === null && declared.exported && declared.name === name,
  );
  const local = declarations.exportedAs.get(name);
  const aliased =
    local === undefined
      ? []
      : declarations.all.filter(
          (declared) => declared.container === null && declared.name === local,
        );
  return [...new Set([...direct, ...aliased])];
}

/** The same declaration in another tree's copy: same name, kind and container. */
function sameIn(declarations: Declarations, declared: Declared): Declared[] {
  return declarations.all.filter(
    (other) =>
      other.name === declared.name &&
      other.kind === declared.kind &&
      other.container === declared.container,
  );
}

// --- Reading the shadow -----------------------------------------------------------

interface Source {
  readonly path: string;
  readonly oid: string;
  readonly lines: readonly string[];
  readonly file: ts.SourceFile;
  readonly declarations: Declarations;
}

type Read = Source | 'absent' | 'unreadable';

/** TypeScript's reading of a file by its extension; null for a file it would not read as source. */
export function scriptKindOf(t: Compiler, path: string): ts.ScriptKind | null {
  const name = posix.basename(path);
  if (/\.[cm]?ts$/u.test(name)) return t.ScriptKind.TS;
  if (name.endsWith('.tsx')) return t.ScriptKind.TSX;
  if (/\.[cm]?js$/u.test(name)) return t.ScriptKind.JS;
  if (name.endsWith('.jsx')) return t.ScriptKind.JSX;
  return null;
}

/**
 * Sources read from the shadow by tree and parsed with Interlock's own
 * compiler — `createSourceFile`, never a program — each blob read and parsed
 * once per batch.
 */
class Sources {
  readonly #t: Compiler;
  readonly #reader: BlobReader;
  readonly #entries = new Map<string, TreeEntry | null>();
  readonly #parsed = new Map<string, Source | 'unreadable'>();

  constructor(t: Compiler, reader: BlobReader) {
    this.#t = t;
    this.#reader = reader;
  }

  /** The blobs of `tree` at these paths, read in one listing. */
  async entries(tree: string, paths: readonly string[]): Promise<Map<string, TreeEntry | null>> {
    const key = (path: string): string => `${tree}\0${path}`;
    const missing = paths.filter((path) => !this.#entries.has(key(path)));
    if (missing.length > 0) {
      const listed = await this.#reader.list(tree, missing);
      for (const path of missing) this.#entries.set(key(path), listed.get(path) ?? null);
    }
    return new Map(paths.map((path) => [path, this.#entries.get(key(path)) ?? null]));
  }

  async entry(tree: string, path: string): Promise<TreeEntry | null> {
    return (await this.entries(tree, [path])).get(path) ?? null;
  }

  /**
   * The file at `path` in `tree`, parsed. Unreadable when it is not a regular
   * file, not source by its extension, over the parse cap, binary, nested past
   * what the parser's stack holds, or holding a line break git does not count
   * — a lone `\r`, a line or paragraph separator — since every line here must
   * be both git's and the compiler's.
   */
  async read(tree: string, path: string): Promise<Read> {
    const entry = await this.entry(tree, path);
    if (entry === null) return 'absent';
    const kind = scriptKindOf(this.#t, path);
    if (!REGULAR_MODES.has(entry.mode) || kind === null) return 'unreadable';
    // `ls-tree -l` sizes every blob it lists, so a file past the cap is never read.
    if (entry.size === null || entry.size > MAX_PARSED_BYTES) return 'unreadable';
    const key = `${entry.oid}\0${String(kind)}`;
    let parsed = this.#parsed.get(key);
    if (parsed === undefined) {
      parsed = await this.#parse(entry.oid, path, kind);
      this.#parsed.set(key, parsed);
    }
    return parsed === 'unreadable' ? parsed : { ...parsed, path };
  }

  async #parse(oid: string, path: string, kind: ts.ScriptKind): Promise<Source | 'unreadable'> {
    const text = await this.#reader.text(oid);
    if (text === null || looksBinary(text)) return 'unreadable';
    const t = this.#t;
    // A parse of a file near the blob cap holds the daemon's thread for tens of
    // milliseconds, and one diagnostic can read four: each parse is a turn of
    // its own, so the longest stall is one file's rather than all of them.
    await yieldToLoop();
    try {
      const file = t.createSourceFile(path, text, t.ScriptTarget.Latest, true, kind);
      const lines = text.split('\n');
      if (file.getLineStarts().length !== lines.length) return 'unreadable';
      return { path, oid, lines, file, declarations: declarationsOf(t, file) };
    } catch (error) {
      // The parser is recursive descent: nesting deep enough overflows the
      // stack, and the file is then one this cannot read, not a reason to fail
      // the batch.
      if (error instanceof RangeError) return 'unreadable';
      throw error;
    }
  }
}

// --- The reference ----------------------------------------------------------------

/** What a diagnostic's location refers to, and where its declaration is looked for. */
export type Reference = {
  readonly family: CodeFamily;
  /** The name the declaration is looked for under. */
  readonly name: string;
} & (
  | {
      readonly shape: 'import';
      /** The module specifier, as written. */
      readonly specifier: string;
      /** For a named import, the local name it binds, whose uses are stale with it. */
      readonly binding: string | null;
    }
  | { readonly shape: 'property' | 'local'; readonly specifier: null; readonly binding: null }
);

/**
 * The innermost node whose source covers `[start, end)`. Iterative: a
 * repository decides how deep its syntax nests.
 */
function nodeCovering(t: Compiler, file: ts.SourceFile, start: number, end: number): ts.Node {
  let node: ts.Node = file;
  for (;;) {
    let next: ts.Node | undefined;
    t.forEachChild(node, (child) => {
      if (child.getStart(file) <= start && end <= child.getEnd()) {
        next = child;
        return true;
      }
      return undefined;
    });
    if (next === undefined) return node;
    node = next;
  }
}

/** The top-level import binding `local`: its specifier, and the name it imports — null for a namespace. */
function importBinding(
  t: Compiler,
  file: ts.SourceFile,
  local: string,
): { readonly specifier: string; readonly imported: string | null } | null {
  for (const statement of file.statements) {
    if (!t.isImportDeclaration(statement) || !t.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    const specifier = statement.moduleSpecifier.text;
    if (t.isNamespaceImport(bindings)) {
      if (bindings.name.text === local) return { specifier, imported: null };
      continue;
    }
    for (const element of bindings.elements) {
      if (element.name.text === local) {
        return { specifier, imported: (element.propertyName ?? element.name).text };
      }
    }
  }
  return null;
}

/**
 * What the diagnostic's location refers to, read from the merged file's syntax
 * and never from the message, whose wording changes between TypeScript
 * releases. Null when the location does not hold what its code describes.
 */
export function readReference(
  t: Compiler,
  file: ts.SourceFile,
  diagnostic: Pick<FileDiagnostic, 'start' | 'length'>,
  code: RecognisedCode,
): Reference | null {
  const start = diagnostic.start;
  const end = diagnostic.start + diagnostic.length;
  const node = nodeCovering(t, file, start, end);

  if (code.family === 'name') {
    if (!t.isIdentifier(node) || node.getStart(file) !== start || node.getEnd() !== end) {
      return null;
    }
    const parent = node.parent;
    switch (code.shape) {
      case 'import': {
        if (!t.isImportSpecifier(parent) || (parent.propertyName ?? parent.name) !== node) {
          return null;
        }
        const declaration = parent.parent.parent.parent;
        if (!t.isStringLiteral(declaration.moduleSpecifier)) return null;
        return {
          family: 'name',
          shape: 'import',
          name: node.text,
          specifier: declaration.moduleSpecifier.text,
          binding: parent.name.text,
        };
      }
      case 'property':
        if (!t.isPropertyAccessExpression(parent) || parent.name !== node) return null;
        return memberReference(t, file, 'name', parent);
      default:
        if (t.isPropertyAccessExpression(parent) && parent.name === node) return null;
        return { family: 'name', shape: 'local', name: node.text, specifier: null, binding: null };
    }
  }

  // An arity is reported at the callee's name when arguments are missing, and
  // over the extra arguments when there are too many — so the call is the
  // innermost one whose callee name, or one of whose arguments, starts the span.
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    if (!t.isCallExpression(at)) continue;
    const callee = at.expression;
    const calleeName = t.isPropertyAccessExpression(callee) ? callee.name : callee;
    const atCallee = calleeName.getStart(file) === start && calleeName.getEnd() === end;
    const atArgument = at.arguments.some((argument) => argument.getStart(file) === start);
    if (!atCallee && !atArgument) continue;
    if (t.isIdentifier(callee)) {
      const bound = importBinding(t, file, callee.text);
      if (bound !== null && bound.imported !== null) {
        return {
          family: 'arity',
          shape: 'import',
          name: bound.imported,
          specifier: bound.specifier,
          binding: callee.text,
        };
      }
      return { family: 'arity', shape: 'local', name: callee.text, specifier: null, binding: null };
    }
    if (t.isPropertyAccessExpression(callee) && t.isIdentifier(callee.name)) {
      return memberReference(t, file, 'arity', callee);
    }
    return null;
  }
  return null;
}

/** `object.name`: a namespace import's export, or a member of whatever `object` is. */
function memberReference(
  t: Compiler,
  file: ts.SourceFile,
  family: CodeFamily,
  access: ts.PropertyAccessExpression,
): Reference {
  const name = access.name.text;
  if (t.isIdentifier(access.expression)) {
    const bound = importBinding(t, file, access.expression.text);
    if (bound !== null && bound.imported === null) {
      return { family, shape: 'import', name, specifier: bound.specifier, binding: null };
    }
  }
  return { family, shape: 'property', name, specifier: null, binding: null };
}

/**
 * The files a relative module specifier in the file at `from` can resolve to,
 * in the order the compiler tries them; none for a bare specifier.
 *
 * A bare specifier — a package, or a `paths` alias — is not resolved: telling
 * which needs the project's options and its dependencies, and a guess would
 * name a declaration nobody imported.
 */
export function moduleCandidates(from: string, specifier: string): string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (target === '..' || target.startsWith('../')) return [];
  const extension = posix.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  // An ECMAScript-style import names the emitted file; the source sits beside it.
  const emitted: Readonly<Record<string, readonly string[]>> = {
    '.js': ['.ts', '.tsx', '.d.ts'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts', '.d.mts'],
    '.cjs': ['.cts', '.d.cts'],
  };
  const sources = emitted[extension];
  if (sources !== undefined) return [...sources.map((suffix) => stem + suffix), target];
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return [target];
  return [
    ...['.ts', '.tsx', '.d.ts', '.js', '.jsx'].map((suffix) => target + suffix),
    ...['index.ts', 'index.tsx', 'index.d.ts', 'index.js'].map((name) => posix.join(target, name)),
  ];
}

// --- One diagnostic ---------------------------------------------------------------

interface SideOf {
  readonly branch: BranchRefId;
  readonly commit: string;
  readonly changeSet: ChangeSet;
}

/** The declaration the diagnostic names, as the pair's merge base has it. */
interface Found {
  readonly path: string;
  readonly source: Source;
  readonly declared: Declared;
}

/**
 * Where a branch's half lies in its own tree: its spans, and the trail step
 * beside them — none for a span widened because its line could not be placed,
 * since a step names a line.
 */
interface Half {
  /** The half's own place first, and at most {@link MAX_SPANS_PER_SIDE} in all. */
  readonly spans: readonly SpanEvidence[];
  readonly step: SymbolTrailStep | null;
}

interface ReferenceSeen {
  readonly adds: Adds;
  readonly holds: boolean;
  readonly half: Half | null;
}

interface ChangeSeen {
  readonly change: DeclarationChange;
  /** None where the declaration's old place cannot be found in this side's file. */
  readonly half: Half | null;
}

const ACTIONS: Readonly<Record<DeclarationChange, SymbolTrailStep['action']>> = {
  renamed: 'renamed',
  moved: 'moved',
  removed: 'deleted',
  'signature-changed': 'signature-changed',
};

type Outcome = DeclarationChange | 'unattributed';

const TITLES: Readonly<Record<Outcome, string>> = {
  renamed: 'One branch renamed a declaration the other still references',
  'signature-changed':
    "One branch changed a function's parameters and the other calls it the old way",
  moved: 'One branch moved an export the other still imports from its old module',
  removed: 'One branch removed a declaration the other still references',
  unattributed: 'The merged tree does not typecheck, and which branch caused it is unclear',
};

const DESCRIPTIONS: Readonly<Record<Outcome, string>> = {
  renamed:
    'One branch renamed a declaration and updated the references it knew of; the other branch added a reference to the old name. Merged, that reference resolves to nothing. Each branch has a span over its half, and the symbol trail names the declaration.',
  'signature-changed':
    'One branch changed the parameters of a function; the other branch added a call written for the old ones. Merged, the call no longer fits. Each branch has a span over its half, and the symbol trail names the function.',
  moved:
    'One branch moved an export to another module; the other branch added an import of it from the module it left. Merged, that import finds nothing. Each branch has a span over its half, and the symbol trail names the export.',
  removed:
    'One branch removed a declaration; the other branch added a reference to it. Merged, that reference resolves to nothing. Each branch has a span over its half, and the symbol trail names the declaration.',
  unattributed:
    'The merged tree reports a compiler error, and which branch caused which half of it could not be told; the rationale says why. The compiler output, and any span that could be placed, are the evidence.',
};

const ATTRIBUTED_RATIONALE =
  "The origin branch's ChangeSet is the only one that changes the declaration the diagnostic names, and its own tree no longer has it as the reference needs; the other branch's ChangeSet is the only one that adds the reference.";

function cancelled(): InterlockError {
  return new InterlockError('REQUEST_CANCELLED', 'Attribution was stopped', {
    remedy: 'None needed: the caller asked for it to stop.',
  });
}

/** The compiler's report of one diagnostic, as `tsc --pretty false` prints it, redacted and capped. */
function toolOutput(version: string, diagnostic: FileDiagnostic): ProcessOutputEvidence {
  const printed = `${diagnostic.file}(${String(diagnostic.line)},${String(diagnostic.column)}): ${diagnostic.category} TS${String(diagnostic.code)}: ${diagnostic.message}`;
  return {
    type: 'process-output',
    tool: `typescript ${version}`,
    exitCode: TSC_ERROR_EXIT,
    // By code point, so a cut never leaves half a surrogate pair.
    output: [...redact(printed)].slice(0, MAX_TOOL_OUTPUT_CHARS).join(''),
    locations: [{ path: diagnostic.file, line: diagnostic.line, column: diagnostic.column }],
  };
}

/** The diagnostic's offset sits where it says it does, in the merged file read here. */
function locates(source: Source, diagnostic: FileDiagnostic): boolean {
  const { start, length } = diagnostic;
  if (start < 0 || length < 0 || start + length > source.file.text.length) return false;
  const at = source.file.getLineAndCharacterOfPosition(start);
  return at.line + 1 === diagnostic.line && at.character + 1 === diagnostic.column;
}

/** Every node of a file, iteratively: a repository decides how deep its syntax nests. */
function walk(t: Compiler, file: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [];
  const pending: ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    t.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return nodes;
}

/** An identifier that reads its binding, rather than naming a declaration or a member. */
function isUse(t: Compiler, node: ts.Identifier): boolean {
  const parent = node.parent;
  if (t.isShorthandPropertyAssignment(parent)) return true;
  // The right of `A.B` in a type is a member; it has no `name` to say so.
  if (t.isQualifiedName(parent)) return parent.left === node;
  // `export { x }` names the binding it exports; `export { x as y }` reads it.
  return (parent as { name?: ts.Node }).name !== node;
}

function spanOf(branch: BranchRefId, source: Source, start: number, end: number): SpanEvidence {
  return {
    type: 'span',
    branchRefId: branch,
    path: source.path,
    startLine: start,
    endLine: end,
    excerpt: excerptOf(source.lines.slice(start - 1, end)),
  };
}

/** Line numbers as runs of adjacent lines, each `[first, last]`, in line order. */
function runsOf(lines: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const at of [...new Set(lines)].sort((x, y) => x - y)) {
    const run = runs.at(-1);
    if (run !== undefined && at === run[1] + 1) run[1] = at;
    else runs.push([at, at]);
  }
  return runs;
}

/** Where lines were, on a branch that has none there now. */
function emptySpan(branch: BranchRefId, path: string, at: number): SpanEvidence {
  return { type: 'span', branchRefId: branch, path, startLine: at, endLine: at - 1, excerpt: '' };
}

class Attributor {
  readonly #t: Compiler;
  readonly #sources: Sources;
  readonly #request: AttributionRequest;
  readonly #log: Logger;

  constructor(t: Compiler, sources: Sources, request: AttributionRequest, log: Logger) {
    this.#t = t;
    this.#sources = sources;
    this.#request = request;
    this.#log = log;
  }

  async attribute(diagnostic: FileDiagnostic): Promise<Finding> {
    const halves: Half[] = [];
    const decision = await this.#examine(diagnostic, halves);
    this.#log.debug('diagnostic attributed', {
      code: diagnostic.code,
      rule: decision.kind === 'attributed' ? ruleFor(decision.change) : ATTRIBUTION_RULES.generic,
      reason: decision.kind === 'unattributed' ? decision.reason : null,
    });
    return this.#finding(decision, halves, toolOutput(this.#t.version, diagnostic));
  }

  /** The decision, with each half that could be placed pushed onto `halves`. */
  async #examine(diagnostic: FileDiagnostic, halves: Half[]): Promise<Decision> {
    const unattributed = (reason: UnattributedReason): Decision => ({
      kind: 'unattributed',
      reason,
    });
    const code = recognise(diagnostic.code);
    if (code === null) return unattributed('unrecognised-code');

    const merged = await this.#sources.read(this.#request.mergedTreeOid, diagnostic.file);
    if (typeof merged === 'string' || !locates(merged, diagnostic)) {
      return unattributed('unreadable-location');
    }
    const reference = readReference(this.#t, merged.file, diagnostic, code);
    if (reference === null) return unattributed('unreadable-location');

    const sides = this.#sides();
    if (sides === null) return unattributed('missing-change-set');

    const where = await this.#referenceFile(diagnostic.file, sides);
    const referencedA = await this.#referenceOn(
      sides.a,
      where.a,
      merged,
      diagnostic.line,
      reference,
    );
    const referencedB = await this.#referenceOn(
      sides.b,
      where.b,
      merged,
      diagnostic.line,
      reference,
    );
    for (const seen of [referencedA, referencedB]) {
      if (seen !== 'stale' && seen.half !== null) halves.push(seen.half);
    }

    const found = await this.#declaration(reference, diagnostic.file, where.base, sides);
    if (found === null) return unattributed('declaration-not-found');
    if (referencedA === 'stale' || referencedB === 'stale') return unattributed('stale-change-set');
    const touchedA = await this.#touches(sides.a, found);
    const touchedB = await this.#touches(sides.b, found);
    if (touchedA === 'stale' || touchedB === 'stale') return unattributed('stale-change-set');

    const facts: SideFacts[] = [];
    const declarationHalves: Half[] = [];
    for (const [side, touched, seen] of [
      [sides.a, touchedA, referencedA],
      [sides.b, touchedB, referencedB],
    ] as const) {
      const change = touched.touches
        ? await this.#changeIn(side, found, touched.headPath, reference)
        : null;
      if (change?.half != null) declarationHalves.push(change.half);
      facts.push({
        touches: touched.touches,
        change: change?.change ?? null,
        adds: seen.adds,
        holds: seen.holds,
      });
    }
    // The declaring side's half first, as a reader takes the story in.
    halves.unshift(...declarationHalves);
    return decide(facts[0]!, facts[1]!);
  }

  /** Each side, when both have a ChangeSet that is theirs. */
  #sides(): Record<Side, SideOf> | null {
    const { changeSetA, changeSetB, branchA, branchB, merge } = this.#request;
    if (changeSetA === null || changeSetB === null) return null;
    // A ChangeSet for another branch describes nothing here: as good as none.
    if (changeSetA.branchRefId !== branchA || changeSetB.branchRefId !== branchB) return null;
    return {
      a: { branch: branchA, commit: merge.commitA, changeSet: changeSetA },
      b: { branch: branchB, commit: merge.commitB, changeSet: changeSetB },
    };
  }

  /**
   * The merged file's path in the merge base and on each side.
   *
   * The same path where the tree has it. Otherwise a rename one branch made:
   * git carries the other branch's edits into the renamed file, so the merged
   * path is on one side only, and the other side's copy sits at the old name.
   */
  async #referenceFile(
    path: string,
    sides: Record<Side, SideOf>,
  ): Promise<Readonly<Record<Side | 'base', string | null>>> {
    const renamedFrom = (side: SideOf): string | null =>
      side.changeSet.files.find((change) => change.kind === 'renamed' && change.path === path)
        ?.previousPath ?? null;
    const first = async (
      tree: string,
      candidates: readonly (string | null)[],
    ): Promise<string | null> => {
      for (const candidate of candidates) {
        if (candidate !== null && (await this.#sources.entry(tree, candidate)) !== null) {
          return candidate;
        }
      }
      return null;
    };
    return {
      base: await first(this.#request.merge.mergeBaseSha, [
        path,
        renamedFrom(sides.a),
        renamedFrom(sides.b),
      ]),
      a: await first(sides.a.commit, [path, renamedFrom(sides.b)]),
      b: await first(sides.b.commit, [path, renamedFrom(sides.a)]),
    };
  }

  /**
   * Whether a side holds the reference's line, and whether its ChangeSet added
   * it — or `stale` when that ChangeSet does not describe the merged commit.
   */
  async #referenceOn(
    side: SideOf,
    path: string | null,
    merged: Source,
    line: number,
    reference: Reference,
  ): Promise<ReferenceSeen | 'stale'> {
    if (path === null) return { adds: 'no', holds: false, half: null };
    const change = await this.#changeAtNewPath(side, path);
    if (change === 'stale') return change;
    const source = await this.#sources.read(side.commit, path);
    if (typeof source === 'string') return { adds: 'unsure', holds: false, half: null };

    const place =
      source.oid === merged.oid
        ? ({ kind: 'exact', line } as const)
        : mapLine(merged.lines, source.lines, line);
    if (place === null) {
      // Too far apart to align: the line is somewhere in what this side
      // wrote in the file, and the span says that much rather than point at a
      // line it cannot vouch for.
      const written = (change?.hunks ?? []).filter((hunk) => hunk.newLines > 0);
      if (written.length === 0) return { adds: 'unsure', holds: false, half: null };
      const start = Math.min(...written.map((hunk) => hunk.newStart));
      const end = Math.max(...written.map((hunk) => hunk.newStart + hunk.newLines - 1));
      return {
        adds: 'unsure',
        holds: false,
        half: { spans: [spanOf(side.branch, source, start, end)], step: null },
      };
    }
    // An unaligned line is one this side does not have: the other side's
    // change, which is what separates the two files.
    if (place.kind === 'between') return { adds: 'no', holds: false, half: null };

    const adds = change?.hunks.some((hunk) => hunkAddsNew(hunk, place.line)) === true;
    return {
      adds: adds ? 'yes' : 'no',
      holds: true,
      half: this.#referenceHalf(side.branch, source, place.line, reference),
    };
  }

  /**
   * The reference's half on one side: for a stale import, the import, then the
   * lines that use the name it binds, which are all stale with it; for an
   * arity, the call; otherwise the line.
   *
   * A use gets a span of its own rather than widening the import's: in a long
   * file the lines between an import and its last use are not the reference.
   */
  #referenceHalf(branch: BranchRefId, source: Source, line: number, reference: Reference): Half {
    const t = this.#t;
    const { file } = source;
    const lineOf = (position: number): number =>
      file.getLineAndCharacterOfPosition(position).line + 1;
    let start = line;
    let end = line;
    let column: number | null = null;
    const uses: number[] = [];

    if (reference.family === 'arity') {
      // The innermost call of that name holding the line: too many arguments
      // are reported over the extras, which need not share the callee's line.
      const callee = reference.binding ?? reference.name;
      let narrowest = Number.POSITIVE_INFINITY;
      for (const node of walk(t, file)) {
        if (!t.isCallExpression(node)) continue;
        const name = t.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression;
        if (!t.isIdentifier(name) || name.text !== callee) continue;
        const from = lineOf(node.getStart(file));
        const to = lineOf(node.getEnd());
        if (from > line || to < line || to - from >= narrowest) continue;
        narrowest = to - from;
        start = from;
        end = to;
        column = file.getLineAndCharacterOfPosition(name.getStart(file)).character + 1;
      }
    } else if (reference.shape === 'import' && reference.binding !== null) {
      const binding = reference.binding;
      for (const node of walk(t, file)) {
        if (!t.isIdentifier(node) || node.text !== binding) continue;
        const parent = node.parent;
        if (t.isImportSpecifier(parent) && lineOf(node.getStart(file)) === line) {
          const statement = parent.parent.parent.parent;
          start = Math.min(start, lineOf(statement.getStart(file)));
          end = Math.max(end, lineOf(statement.getEnd()));
          column = file.getLineAndCharacterOfPosition(node.getStart(file)).character + 1;
        } else if (isUse(t, node)) {
          uses.push(lineOf(node.getStart(file)));
        }
      }
    }
    const used = runsOf(uses.filter((at) => at < start || at > end));
    return {
      spans: [
        spanOf(branch, source, start, end),
        ...used
          .slice(0, MAX_SPANS_PER_SIDE - 1)
          .map(([from, to]) => spanOf(branch, source, from, to)),
      ],
      step: {
        branchRefId: branch,
        symbol: reference.name,
        action: 'referenced',
        location: { path: source.path, line, column },
      },
    };
  }

  /** The declaration in the pair's merge base, or null when it is not one unique place. */
  async #declaration(
    reference: Reference,
    mergedPath: string,
    basePath: string | null,
    sides: Record<Side, SideOf>,
  ): Promise<Found | null> {
    const t = this.#t;
    const base = this.#request.merge.mergeBaseSha;
    const candidates: Found[] = [];
    switch (reference.shape) {
      case 'import': {
        const paths = moduleCandidates(mergedPath, reference.specifier);
        const entries = await this.#sources.entries(base, paths);
        const path = paths.find((candidate) => entries.get(candidate) != null);
        if (path === undefined) return null;
        const source = await this.#sources.read(base, path);
        if (typeof source === 'string') return null;
        for (const declared of exportsNamed(source.declarations, reference.name)) {
          candidates.push({ path, source, declared });
        }
        break;
      }
      case 'local': {
        if (basePath === null) return null;
        const source = await this.#sources.read(base, basePath);
        if (typeof source === 'string') return null;
        for (const declared of source.declarations.all) {
          if (
            declared.container === null &&
            declared.name === reference.name &&
            declared.kind !== t.SyntaxKind.ExportSpecifier
          ) {
            candidates.push({ path: basePath, source, declared });
          }
        }
        break;
      }
      case 'property': {
        // Which type the object has needs a program. Without one, the member
        // is found only when it is the one of that name in what either branch
        // changed — where a member a merge broke has to be.
        const paths = [
          ...new Set(
            [sides.a, sides.b].flatMap(({ changeSet }) =>
              changeSet.files
                .filter((change) => change.kind !== 'added')
                .map((change) => change.previousPath ?? change.path),
            ),
          ),
        ].filter((path) => scriptKindOf(t, path) !== null);
        if (paths.length > MAX_SCANNED_FILES) return null;
        for (const path of paths) {
          const source = await this.#sources.read(base, path);
          if (typeof source === 'string') continue;
          for (const declared of source.declarations.all) {
            if (declared.container !== null && declared.name === reference.name) {
              candidates.push({ path, source, declared });
            }
          }
        }
        break;
      }
    }
    const [only, ...others] = candidates;
    if (only === undefined || others.length > 0) return null;
    if (reference.family === 'arity' && only.declared.arity === null) return null;
    return only;
  }

  /**
   * Whether a side's ChangeSet touches the declaration, and where the
   * declaration's file is on that side — or `stale` when the ChangeSet does
   * not describe the merged commit, or its own base does not hold the
   * declaration to compare its hunks with.
   */
  async #touches(
    side: SideOf,
    found: Found,
  ): Promise<{ readonly touches: boolean; readonly headPath: string | null } | 'stale'> {
    const { changeSet } = side;
    // Hunks are in the coordinates of the ChangeSet's own base — the merge
    // base with the default branch, which need not be the pair's.
    let declared = found.declared;
    if (changeSet.mergeBaseSha !== this.#request.merge.mergeBaseSha) {
      const source = await this.#sources.read(changeSet.mergeBaseSha, found.path);
      if (typeof source === 'string') return 'stale';
      const [same, ...others] = sameIn(source.declarations, found.declared);
      if (same === undefined || others.length > 0) return 'stale';
      declared = same;
    }
    const change = await this.#changeAtOldPath(side, found.path);
    if (change === 'stale') return change;
    const { file, headPath } = change;
    if (file === undefined) return { touches: false, headPath };
    if (file.kind === 'deleted' || file.kind === 'renamed') return { touches: true, headPath };
    return {
      touches: file.hunks.some((hunk) => hunkTouchesOld(hunk, declared.start, declared.end)),
      headPath,
    };
  }

  /**
   * The ChangeSet's record of the file at `path` in its base, checked against
   * the trees: the blobs at its base and at the merged commit must agree with
   * the change it records, or it describes some other commit.
   */
  async #changeAtOldPath(
    side: SideOf,
    path: string,
  ): Promise<
    { readonly file: FileChange | undefined; readonly headPath: string | null } | 'stale'
  > {
    const { changeSet, commit } = side;
    const file = changeSet.files.find(
      (change) => change.kind !== 'added' && (change.previousPath ?? change.path) === path,
    );
    const before = await this.#sources.entry(changeSet.mergeBaseSha, path);
    if (file === undefined) {
      const after = await this.#sources.entry(commit, path);
      if ((before?.oid ?? null) !== (after?.oid ?? null)) return 'stale';
      return { file, headPath: after === null ? null : path };
    }
    if (before === null) return 'stale';
    if (file.kind === 'deleted') {
      return (await this.#sources.entry(commit, path)) === null
        ? { file, headPath: null }
        : 'stale';
    }
    const after = await this.#sources.entry(commit, file.path);
    if (after === null) return 'stale';
    if (file.kind === 'modified' && after.oid === before.oid && file.hunks.length > 0) {
      return 'stale';
    }
    return { file, headPath: file.path };
  }

  /** The ChangeSet's record of the file at `path` on its side, checked as above. */
  async #changeAtNewPath(side: SideOf, path: string): Promise<FileChange | undefined | 'stale'> {
    const { changeSet, commit } = side;
    const file = changeSet.files.find(
      (change) => change.kind !== 'deleted' && change.path === path,
    );
    const after = await this.#sources.entry(commit, path);
    if (after === null) return 'stale';
    if (file === undefined) {
      const before = await this.#sources.entry(changeSet.mergeBaseSha, path);
      return before?.oid === after.oid ? undefined : 'stale';
    }
    const before = await this.#sources.entry(
      changeSet.mergeBaseSha,
      file.kind === 'renamed' ? (file.previousPath ?? path) : path,
    );
    if (file.kind === 'added') return before === null ? file : 'stale';
    if (before === null) return 'stale';
    if (file.kind === 'modified' && before.oid === after.oid && file.hunks.length > 0) {
      return 'stale';
    }
    return file;
  }

  /**
   * What a branch that touched the declaration did to it, read from its own
   * tree; null when what it did does not explain the diagnostic — the name is
   * still there, or the parameters are as they were.
   */
  async #changeIn(
    side: SideOf,
    found: Found,
    headPath: string | null,
    reference: Reference,
  ): Promise<ChangeSeen | null> {
    const { declared } = found;
    const read = headPath === null ? null : await this.#sources.read(side.commit, headPath);
    if (typeof read === 'string') return null;
    const source = read;
    const same = source === null ? [] : sameIn(source.declarations, declared);
    const declarationHalf = (
      to: Source,
      at: Declared,
      last: number,
      change: DeclarationChange,
    ): ChangeSeen => ({
      change,
      half: {
        spans: [spanOf(side.branch, to, at.start, last)],
        step: {
          branchRefId: side.branch,
          symbol: declared.name,
          action: ACTIONS[change],
          location: { path: to.path, line: at.nameLine, column: at.nameColumn },
        },
      },
    });
    const removedAt = (path: string, at: number): ChangeSeen => ({
      change: 'removed',
      half: {
        spans: [emptySpan(side.branch, path, at)],
        step: {
          branchRefId: side.branch,
          symbol: declared.name,
          action: ACTIONS.removed,
          location: { path, line: at, column: null },
        },
      },
    });

    if (reference.family === 'arity') {
      const [now, ...others] = same;
      if (source === null || now === undefined || others.length > 0) return null;
      if (now.arity === null || now.arity === declared.arity) return null;
      return declarationHalf(source, now, now.paramsEnd, 'signature-changed');
    }

    const stillThere =
      reference.shape === 'import'
        ? source !== null && exportsNamed(source.declarations, declared.name).length > 0
        : same.length > 0;
    if (stillThere) return null;

    if (reference.shape === 'import' && declared.container === null) {
      const moved = await this.#movedTo(side, declared.name, headPath);
      if (moved !== null) {
        return declarationHalf(moved.source, moved.declared, moved.declared.end, 'moved');
      }
    }
    // The file went with the name: the place it left from is the merge base's,
    // since this side has no copy of it.
    if (source === null) return removedAt(found.path, declared.start);

    const region =
      source.oid === found.source.oid
        ? { from: declared.start, to: declared.end }
        : mapRange(found.source.lines, source.lines, declared.start, declared.end);
    const renamed =
      region === null
        ? []
        : source.declarations.all.filter(
            (other) =>
              other.container === declared.container &&
              other.kind === declared.kind &&
              other.name !== declared.name &&
              other.start <= region.to &&
              other.end >= region.from,
          );
    const [renamedTo, ...also] = renamed;
    if (renamedTo !== undefined && also.length === 0) {
      return declarationHalf(source, renamedTo, renamedTo.nameLine, 'renamed');
    }
    // The name is gone from the file either way; where it was is known only
    // when the file aligns with the base's.
    return region === null
      ? { change: 'removed', half: null }
      : removedAt(source.path, region.from);
  }

  /**
   * The one declaration, in a file the side added or changed, that now
   * exports `name`. A re-export or an import of it is not where it moved to:
   * each is a pointer at the place that is.
   */
  async #movedTo(
    side: SideOf,
    name: string,
    exclude: string | null,
  ): Promise<{ readonly source: Source; readonly declared: Declared } | null> {
    const t = this.#t;
    const paths = side.changeSet.files
      .filter((change) => change.kind !== 'deleted' && change.path !== exclude)
      .map((change) => change.path)
      .filter((path) => scriptKindOf(t, path) !== null);
    if (paths.length > MAX_SCANNED_FILES) {
      this.#log.debug('too many changed files to look for a move in', {
        files: paths.length,
        bound: MAX_SCANNED_FILES,
      });
      return null;
    }
    const found: { readonly source: Source; readonly declared: Declared }[] = [];
    for (const path of paths) {
      const source = await this.#sources.read(side.commit, path);
      if (typeof source === 'string') continue;
      for (const declared of exportsNamed(source.declarations, name)) {
        if (
          declared.kind !== t.SyntaxKind.ExportSpecifier &&
          declared.kind !== t.SyntaxKind.ImportSpecifier
        ) {
          found.push({ source, declared });
        }
      }
    }
    const [only, ...others] = found;
    return only !== undefined && others.length === 0 ? only : null;
  }

  #finding(decision: Decision, halves: readonly Half[], output: ProcessOutputEvidence): Finding {
    const request = this.#request;
    const attributed = decision.kind === 'attributed';
    const steps = halves.flatMap((half) => (half.step === null ? [] : [half.step]));
    const evidence: Evidence[] = [
      ...halves.flatMap((half) => half.spans),
      ...(steps.length > 0 ? [{ type: 'symbol-trail' as const, steps }] : []),
      output,
    ];
    const outcome: Outcome = attributed ? decision.change : 'unattributed';
    const origin = attributed
      ? decision.origin === 'a'
        ? request.branchA
        : request.branchB
      : null;
    return {
      id: ulid<FindingId>(),
      runId: request.runId,
      kind: 'typecheck',
      rule: attributed ? ruleFor(decision.change) : ATTRIBUTION_RULES.generic,
      severity: 'high',
      confidence: attributed ? ATTRIBUTED_CONFIDENCE : UNATTRIBUTED_CONFIDENCE,
      status: 'open',
      title: TITLES[outcome],
      description: DESCRIPTIONS[outcome],
      attribution: {
        branchA: request.branchA,
        branchB: request.branchB,
        originBranch: origin,
        rationale: attributed ? ATTRIBUTED_RATIONALE : UNATTRIBUTED_RATIONALES[decision.reason],
      },
      evidence,
      firstSeenAt: request.now,
      updatedAt: request.now,
      resolvedAt: null,
    };
  }
}

// --- The batch --------------------------------------------------------------------

export interface AttributionRequest {
  readonly runId: SpeculativeRunId;
  readonly branchA: BranchRefId;
  readonly branchB: BranchRefId;
  /** Each side's diff against its merge base with the default branch; null where none was made. */
  readonly changeSetA: ChangeSet | null;
  readonly changeSetB: ChangeSet | null;
  /** The merge as it was asked for: the shadow, both commits and the merge base. */
  readonly merge: SpeculativeMergeRequest;
  /** The clean merge's tree, which the diagnostics were reported against. */
  readonly mergedTreeOid: string;
  /**
   * The diagnostics the merge introduced — the baseline differ's output, never
   * the service's whole report. Every one becomes a Finding, attributed or
   * not, so an error already on the default branch given here is reported as
   * the pair's. Paths relative to the tree, as the type-check service reports
   * them.
   */
  readonly diagnostics: readonly FileDiagnostic[];
  /** ISO-8601; stamped on every Finding as first seen and updated. */
  readonly now: string;
}

export interface AttributionOptions {
  readonly runner: GitRunner;
  readonly logger?: Logger;
  /** Checked between diagnostics; aborted, the batch stops with `REQUEST_CANCELLED`. */
  readonly signal?: AbortSignal;
}

export interface AttributedDiagnostics {
  /** One per diagnostic attributed, in the order given, at most {@link MAX_FINDINGS_PER_RUN}. */
  readonly findings: readonly Finding[];
  /** Diagnostics past the bound, read for nothing. */
  readonly dropped: number;
}

let compiler: Promise<Compiler> | undefined;

/**
 * Interlock's own compiler, loaded on first use rather than imported:
 * importing `@interlock/core` must not load `typescript`, which only a
 * type-check worker otherwise needs.
 */
function loadCompiler(): Promise<Compiler> {
  compiler ??= import('typescript').then(
    (module) => module.default,
    (error: unknown) => {
      compiler = undefined;
      throw error;
    },
  );
  return compiler;
}

/**
 * Attribute each diagnostic of a merged tree to the branches that caused it.
 *
 * Reads the merged tree, the merge base, both sides and each ChangeSet's own
 * base from the shadow by tree id, and parses with Interlock's own compiler:
 * it never builds a program and never loads anything from a tree. Yields to
 * the event loop between diagnostics, so the daemon's thread is held for one
 * diagnostic's reads and parses at a time.
 *
 * A Finding is made for every diagnostic examined, attributed or not. A git
 * command that fails throws the runner's `InterlockError`: a Finding is never
 * made from less than it claims, and nothing is returned in its place.
 */
export async function attributeDiagnostics(
  request: AttributionRequest,
  options: AttributionOptions,
): Promise<AttributedDiagnostics> {
  const t = await loadCompiler();
  const log = (options.logger ?? silentLogger).child('attribution', { runId: request.runId });
  const sources = new Sources(t, new BlobReader(request.merge.shadow, options.runner));
  const attributor = new Attributor(t, sources, request, log);
  const examined = request.diagnostics.slice(0, MAX_FINDINGS_PER_RUN);

  const findings: Finding[] = [];
  for (const diagnostic of examined) {
    if (options.signal?.aborted === true) throw cancelled();
    findings.push(await attributor.attribute(diagnostic));
    await yieldToLoop();
  }
  const dropped = request.diagnostics.length - examined.length;
  if (dropped > 0) {
    log.warn('diagnostics past the per-run bound were not attributed', {
      dropped,
      bound: MAX_FINDINGS_PER_RUN,
    });
  }
  return { findings, dropped };
}
