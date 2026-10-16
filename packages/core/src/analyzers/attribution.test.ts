import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTED_CONFIDENCE,
  ATTRIBUTION_RULES,
  UNATTRIBUTED_CONFIDENCE,
  UNATTRIBUTED_RATIONALES,
  UNATTRIBUTED_REASONS,
  arityOf,
  declarationsOf,
  decide,
  exportsNamed,
  hunkAddsNew,
  hunkTouchesOld,
  mapLine,
  mapRange,
  moduleCandidates,
  readReference,
  recognise,
  ruleFor,
  scriptKindOf,
} from './attribution.js';
import type { Declared, SideFacts } from './attribution.js';

describe('recognise', () => {
  it.each([
    [2304, 'name', 'local'],
    [2552, 'name', 'local'],
    [2339, 'name', 'property'],
    [2551, 'name', 'property'],
    [2305, 'name', 'import'],
    [2614, 'name', 'import'],
    [2724, 'name', 'import'],
    [2554, 'arity', null],
    [2555, 'arity', null],
  ])('reads TS%i as a %s that is looked for as %s', (code, family, shape) => {
    expect(recognise(code)).toEqual({ family, shape });
  });

  it.each([2307, 2322, 2345, 1005, 0])('does not read TS%i', (code) => {
    expect(recognise(code)).toBeNull();
  });
});

describe('rules', () => {
  it('are the names the evaluation suite labels typecheck conflicts with', () => {
    // Spelt out rather than read from `eval/`, which nothing in `packages/`
    // imports; the integration suite's mirrored cases carry the same labels.
    expect(ATTRIBUTION_RULES).toEqual({
      rename: 'rename-vs-callsite',
      signature: 'signature-vs-caller',
      movedExport: 'moved-export-vs-import',
      generic: 'merge-breaks-typecheck',
    });
  });

  it('are never a compiler code', () => {
    for (const rule of Object.values(ATTRIBUTION_RULES)) {
      expect(rule).toMatch(/^[a-z]+(?:-[a-z]+)+$/u);
      expect(rule).not.toMatch(/ts\d/iu);
    }
  });

  it.each([
    ['renamed', 'rename-vs-callsite'],
    ['moved', 'moved-export-vs-import'],
    ['signature-changed', 'signature-vs-caller'],
    ['removed', 'merge-breaks-typecheck'],
  ] as const)('name a declaration %s as %s', (change, rule) => {
    expect(ruleFor(change)).toBe(rule);
  });

  it('give every reason a rationale of its own', () => {
    const rationales = UNATTRIBUTED_REASONS.map((reason) => UNATTRIBUTED_RATIONALES[reason]);
    expect(rationales.every((text) => text.length > 0)).toBe(true);
    expect(new Set(rationales).size).toBe(UNATTRIBUTED_REASONS.length);
  });
});

describe('hunkTouchesOld', () => {
  // A declaration on lines 3–5.
  it.each([
    ['a line before it', { oldStart: 2, oldLines: 1 }, false],
    ['its first line', { oldStart: 3, oldLines: 1 }, true],
    ['its last line', { oldStart: 5, oldLines: 1 }, true],
    ['the line after it', { oldStart: 6, oldLines: 1 }, false],
    ['lines running into it', { oldStart: 1, oldLines: 3 }, true],
    ['lines running out of it', { oldStart: 5, oldLines: 4 }, true],
    ['an insertion before its first line', { oldStart: 2, oldLines: 0 }, false],
    ['an insertion after its first line', { oldStart: 3, oldLines: 0 }, true],
    ['an insertion after its second line', { oldStart: 4, oldLines: 0 }, true],
    ['an insertion after its last line', { oldStart: 5, oldLines: 0 }, false],
    ['an insertion at the top of the file', { oldStart: 0, oldLines: 0 }, false],
  ])('%s: %s', (_, old, touches) => {
    expect(hunkTouchesOld({ ...old, newStart: 1, newLines: 1 }, 3, 5)).toBe(touches);
  });
});

describe('hunkAddsNew', () => {
  const hunk = { oldStart: 3, oldLines: 0, newStart: 4, newLines: 3 };
  it.each([
    [3, false],
    [4, true],
    [6, true],
    [7, false],
  ])('line %i: %s', (line, adds) => {
    expect(hunkAddsNew(hunk, line)).toBe(adds);
  });

  it('adds nothing for a deletion', () => {
    expect(hunkAddsNew({ oldStart: 4, oldLines: 2, newStart: 3, newLines: 0 }, 3)).toBe(false);
  });
});

describe('mapLine', () => {
  const file = ['a', 'b', 'c', 'd', 'e'];

  it('maps a line of an identical file to itself', () => {
    expect(mapLine(file, file, 3)).toEqual({ kind: 'exact', line: 3 });
  });

  it('follows lines inserted above', () => {
    expect(mapLine(file, ['x', 'y', ...file], 3)).toEqual({ kind: 'exact', line: 5 });
  });

  it('follows lines removed above', () => {
    expect(mapLine(file, ['a', 'c', 'd', 'e'], 4)).toEqual({ kind: 'exact', line: 3 });
  });

  it('places a changed line between its neighbours', () => {
    expect(mapLine(file, ['a', 'b', 'C', 'd', 'e'], 3)).toEqual({
      kind: 'between',
      from: 3,
      to: 3,
    });
  });

  it('places a line the other file lacks in an empty gap', () => {
    expect(mapLine(file, ['a', 'b', 'd', 'e'], 3)).toEqual({ kind: 'between', from: 3, to: 2 });
  });

  it('bounds a gap at the start and the end of the file', () => {
    expect(mapLine(file, ['A', 'b', 'c', 'd', 'e'], 1)).toEqual({
      kind: 'between',
      from: 1,
      to: 1,
    });
    expect(mapLine(file, ['a', 'b', 'c', 'd', 'E'], 5)).toEqual({
      kind: 'between',
      from: 5,
      to: 5,
    });
  });

  it('gives up on files too far apart to align', () => {
    const far = Array.from({ length: 1200 }, (_, index) => `line ${String(index)}`);
    expect(mapLine(file, [...far, ...file.slice(1)], 1)).toBeNull();
  });
});

describe('mapRange', () => {
  const base = ['// head', 'function a() {', '  return 1;', '}', '', 'function b() {}'];

  it('covers a range whose first line changed', () => {
    const renamed = ['// head', 'function z() {', '  return 1;', '}', '', 'function b() {}'];
    expect(mapRange(base, renamed, 2, 4)).toEqual({ from: 2, to: 4 });
  });

  it('follows the range past inserted lines', () => {
    const shifted = ['// new', '// new', ...base];
    expect(mapRange(base, shifted, 2, 4)).toEqual({ from: 4, to: 6 });
  });

  it('is empty where the range was removed', () => {
    const removed = ['// head', '', 'function b() {}'];
    expect(mapRange(base, removed, 2, 4)).toEqual({ from: 2, to: 1 });
  });

  it('gives up on files too far apart to align', () => {
    const far = Array.from({ length: 1200 }, (_, index) => `line ${String(index)}`);
    expect(mapRange(base, far, 2, 4)).toBeNull();
  });
});

describe('moduleCandidates', () => {
  it('tries the source extensions, then an index', () => {
    expect(moduleCandidates('src/support.ts', './payments')).toEqual([
      'src/payments.ts',
      'src/payments.tsx',
      'src/payments.d.ts',
      'src/payments.js',
      'src/payments.jsx',
      'src/payments/index.ts',
      'src/payments/index.tsx',
      'src/payments/index.d.ts',
      'src/payments/index.js',
    ]);
  });

  it('reads an emitted name as the source beside it first', () => {
    expect(moduleCandidates('src/support.ts', './payments.js')).toEqual([
      'src/payments.ts',
      'src/payments.tsx',
      'src/payments.d.ts',
      'src/payments.js',
    ]);
    expect(moduleCandidates('src/a.ts', './b.mjs')).toEqual([
      'src/b.mts',
      'src/b.d.mts',
      'src/b.mjs',
    ]);
    expect(moduleCandidates('src/a.ts', './b.cjs')).toEqual([
      'src/b.cts',
      'src/b.d.cts',
      'src/b.cjs',
    ]);
    expect(moduleCandidates('src/a.tsx', './b.jsx')).toEqual(['src/b.tsx', 'src/b.jsx']);
  });

  it('takes a source extension as written', () => {
    expect(moduleCandidates('src/a/b.ts', '../lib/x.ts')).toEqual(['src/lib/x.ts']);
  });

  it('resolves nothing bare, and nothing outside the tree', () => {
    expect(moduleCandidates('src/a.ts', 'lodash')).toEqual([]);
    expect(moduleCandidates('src/a.ts', '@/payments')).toEqual([]);
    expect(moduleCandidates('src/a.ts', '#payments')).toEqual([]);
    expect(moduleCandidates('src/a.ts', '../../x')).toEqual([]);
    expect(moduleCandidates('a.ts', '..')).toEqual([]);
  });
});

describe('arityOf', () => {
  const first = (source: string): ts.Node => {
    const file = ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true);
    const statement = file.statements[0]!;
    return ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]!
      : ts.isClassDeclaration(statement)
        ? statement.members[0]!
        : statement;
  };

  it.each([
    ['function f(a: number, b: string) {}', { min: 2, max: 2 }],
    ['function f(a: number, b?: string) {}', { min: 1, max: 2 }],
    ['function f(a: number, b = "x") {}', { min: 1, max: 2 }],
    ['function f(a = 1, b: string) {}', { min: 2, max: 2 }],
    ['function f(this: Window, a: number) {}', { min: 1, max: 1 }],
    ['function f(a: number, ...rest: string[]) {}', { min: 1, max: null }],
    ['function f() {}', { min: 0, max: 0 }],
    ['const f = (a: number) => a;', { min: 1, max: 1 }],
    ['const f = function (a: number, b?: number) { return a; };', { min: 1, max: 2 }],
    ['class C { m(a: number, b: number) {} }', { min: 2, max: 2 }],
    ['class C { m = (a: number) => a; }', { min: 1, max: 1 }],
  ])('%s takes %o', (source, arity) => {
    expect(arityOf(ts, first(source))).toEqual(arity);
  });

  it.each(['const x = 1;', 'class C { x = 1; }', 'interface I { x: number }'])(
    'reads %s as no function',
    (source) => {
      expect(arityOf(ts, first(source))).toBeNull();
    },
  );
});

describe('decide', () => {
  /** Branch `a` renamed the declaration; branch `b` added the call. */
  const declaring: SideFacts = { touches: true, change: 'renamed', adds: 'no', holds: false };
  const referencing: SideFacts = { touches: false, change: null, adds: 'yes', holds: true };

  it('names the branch that changed the declaration, whichever side it is', () => {
    expect(decide(declaring, referencing)).toEqual({
      kind: 'attributed',
      origin: 'a',
      referencing: 'b',
      change: 'renamed',
    });
    expect(decide(referencing, declaring)).toEqual({
      kind: 'attributed',
      origin: 'b',
      referencing: 'a',
      change: 'renamed',
    });
  });

  it.each([
    [
      'the reference was in the base',
      { ...declaring, adds: 'no', holds: true },
      { ...referencing, adds: 'no', holds: true },
      'reference-in-base',
    ],
    [
      'both changed the declaration',
      declaring,
      { ...referencing, touches: true },
      'both-changed-declaration',
    ],
    [
      'neither changed it',
      { ...declaring, touches: false },
      referencing,
      'neither-changed-declaration',
    ],
    [
      'its change does not explain it',
      { ...declaring, change: null },
      referencing,
      'change-does-not-explain',
    ],
    [
      "the reference's side is unsure",
      declaring,
      { ...referencing, adds: 'unsure' },
      'mapping-unsure',
    ],
    [
      "the declaring side's is unsure",
      { ...declaring, adds: 'unsure' },
      referencing,
      'mapping-unsure',
    ],
    [
      'both added the reference',
      { ...declaring, adds: 'yes', holds: true },
      referencing,
      'both-hold-reference',
    ],
    ['neither added it', declaring, { ...referencing, adds: 'no' }, 'neither-holds-reference'],
    [
      'the declaring branch added it too',
      { ...declaring, adds: 'yes', holds: true },
      { ...referencing, adds: 'no', holds: false },
      'same-branch',
    ],
  ] as const)('names no branch when %s', (_, a, b, reason) => {
    expect(decide(a, b)).toEqual({ kind: 'unattributed', reason });
  });

  it('asks about the declaration before the reference, and the base before both', () => {
    // Every reason holds at once, each pair of them in turn: the earlier one wins.
    expect(
      decide(
        { touches: true, change: 'renamed', adds: 'no', holds: true },
        { touches: true, change: 'renamed', adds: 'no', holds: true },
      ),
    ).toEqual({ kind: 'unattributed', reason: 'reference-in-base' });
    expect(
      decide(
        { touches: true, change: 'renamed', adds: 'yes', holds: true },
        { touches: true, change: null, adds: 'yes', holds: true },
      ),
    ).toEqual({ kind: 'unattributed', reason: 'both-changed-declaration' });
    expect(
      decide({ ...declaring, change: null, adds: 'unsure' }, { ...referencing, adds: 'unsure' }),
    ).toEqual({ kind: 'unattributed', reason: 'change-does-not-explain' });
    expect(decide({ ...declaring, adds: 'unsure' }, { ...referencing, adds: 'yes' })).toEqual({
      kind: 'unattributed',
      reason: 'mapping-unsure',
    });
  });
});

describe('confidence', () => {
  it('is lower for a Finding that names no branch than for one that does', () => {
    expect(UNATTRIBUTED_CONFIDENCE).toBeLessThan(ATTRIBUTED_CONFIDENCE);
    expect(UNATTRIBUTED_CONFIDENCE).toBeGreaterThan(0);
  });
});

const parse = (source: string, name = 'a.ts'): ts.SourceFile =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);

/** The declarations of a source, reduced to what each test asks about. */
const declared = (source: string): Pick<Declared, 'name' | 'container' | 'exported'>[] =>
  declarationsOf(ts, parse(source)).all.map(({ name, container, exported }) => ({
    name,
    container,
    exported,
  }));

describe('declarationsOf', () => {
  it('reads overloads as one declaration whose arity is their signatures, not the implementation', () => {
    const [only, ...rest] = declarationsOf(
      ts,
      parse(
        [
          'export function f(a: string): string;',
          'export function f(a: number, b: number): number;',
          'export function f(a: unknown, b?: unknown): unknown {',
          '  return a;',
          '}',
        ].join('\n'),
      ),
    ).all;
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      name: 'f',
      exported: true,
      start: 1,
      end: 5,
      arity: '[[1,1],[2,2]]',
    });
  });

  it("reads a class's and an interface's named members, and nothing unnamed", () => {
    expect(
      declared(
        [
          'export class C {',
          '  m(a: number) {}',
          '  p = 1;',
          '  get g() { return 1; }',
          '  set g(v: number) {}',
          '  [Symbol.iterator]() {}',
          "  'quoted'() {}",
          '  constructor() {}',
          '}',
          'interface I { s(a: number): void; q: string }',
          'export default class {}',
        ].join('\n'),
      ),
    ).toEqual([
      { name: 'C', container: null, exported: true },
      { name: 'm', container: 'C', exported: true },
      { name: 'p', container: 'C', exported: true },
      { name: 'g', container: 'C', exported: true },
      { name: 'g', container: 'C', exported: true },
      { name: 'I', container: null, exported: false },
      { name: 's', container: 'I', exported: false },
      { name: 'q', container: 'I', exported: false },
    ]);
  });

  it('reads types, enums and variables, each declarator for itself', () => {
    const all = declarationsOf(
      ts,
      parse(
        [
          'export type T = string;',
          'enum E { A }',
          'export const a = 1,',
          '  b = (x: number) => x;',
          'const { c } = { c: 1 };',
          'const f = x => x;',
        ].join('\n'),
      ),
    ).all;
    expect(all.map(({ name, exported }) => [name, exported])).toEqual([
      ['T', true],
      ['E', false],
      ['a', true],
      ['b', true],
      ['f', false],
    ]);
    // Two declarators each own their own line; one owns the statement's.
    expect(all.find((each) => each.name === 'b')).toMatchObject({ start: 4, arity: '[[1,1]]' });
    // No parentheses to close: the parameters end on the name's line.
    expect(all.find((each) => each.name === 'f')).toMatchObject({ paramsEnd: 6, arity: '[[1,1]]' });
  });

  it('reads a named import as a binding, and no other kind of import', () => {
    expect(
      declared(
        [
          "import x from './x';",
          "import * as ns from './ns';",
          "import './side';",
          "import { a, b as c } from './m';",
        ].join('\n'),
      ),
    ).toEqual([
      { name: 'a', container: null, exported: false },
      { name: 'c', container: null, exported: false },
    ]);
  });

  it('reads local exports by name, and a re-export from another module as an export', () => {
    const declarations = declarationsOf(
      ts,
      parse(
        [
          'const local = 1;',
          'export { local as shown, local };',
          "export { r as re } from './r';",
          "export * from './all';",
          "export { x as 'not-a-name' } from './s';",
          'export const z = 2;',
          'export { z };',
        ].join('\n'),
      ),
    );
    expect([...declarations.exportedAs]).toEqual([
      ['shown', 'local'],
      ['local', 'local'],
      ['z', 'z'],
    ]);
    expect(declarations.all.map((each) => each.name)).toEqual(['local', 're', 'z']);
    expect(exportsNamed(declarations, 'shown').map((each) => each.name)).toEqual(['local']);
    expect(exportsNamed(declarations, 're').map((each) => each.name)).toEqual(['re']);
    // Exported directly and by name: one declaration, not two.
    expect(exportsNamed(declarations, 'z')).toHaveLength(1);
    expect(exportsNamed(declarations, 'absent')).toEqual([]);
  });
});

describe('scriptKindOf', () => {
  it.each([
    ['src/a.ts', ts.ScriptKind.TS],
    ['src/a.mts', ts.ScriptKind.TS],
    ['src/a.cts', ts.ScriptKind.TS],
    ['src/a.d.ts', ts.ScriptKind.TS],
    ['src/a.tsx', ts.ScriptKind.TSX],
    ['src/a.js', ts.ScriptKind.JS],
    ['src/a.mjs', ts.ScriptKind.JS],
    ['src/a.cjs', ts.ScriptKind.JS],
    ['src/a.jsx', ts.ScriptKind.JSX],
  ])('reads %s as source', (path, kind) => {
    expect(scriptKindOf(ts, path)).toBe(kind);
  });

  it.each(['package.json', 'Makefile', 'src/a.ts.orig', 'tsconfig.tsbuildinfo'])(
    'does not read %s',
    (path) => {
      expect(scriptKindOf(ts, path)).toBeNull();
    },
  );
});

describe('readReference', () => {
  /** Read the reference at the `occurrence`th `text` in `source`, as code `code` reports it. */
  const at = (source: string, text: string, code: number, occurrence = 1): unknown => {
    let start = -1;
    for (let found = 0; found < occurrence; found++) start = source.indexOf(text, start + 1);
    return readReference(ts, parse(source), { start, length: text.length }, recognise(code)!);
  };

  it('reads a stale import as the name it imports from its module, under its alias', () => {
    const source = "import { a as b } from './m';";
    expect(at(source, 'a', 2305)).toEqual({
      family: 'name',
      shape: 'import',
      name: 'a',
      specifier: './m',
      binding: 'b',
    });
    // The alias is not what the module is asked for.
    expect(at(source, 'b', 2305)).toBeNull();
    expect(at('const a = 1;', 'a', 2305)).toBeNull();
    expect(at('import { a } from x;', 'a', 2305)).toBeNull();
  });

  it('reads a property as a member, or as an export through a namespace import', () => {
    expect(at('declare const o: object;\no.prop;', 'prop', 2339)).toEqual({
      family: 'name',
      shape: 'property',
      name: 'prop',
      specifier: null,
      binding: null,
    });
    // The second `f`: the first is in `from`.
    expect(at("import * as ns from './m';\nns.f;", 'f', 2339, 2)).toMatchObject({
      shape: 'import',
      specifier: './m',
      binding: null,
    });
    expect(at('a.b.c;', 'c', 2339)).toMatchObject({ shape: 'property', name: 'c' });
    // The object, not the property, is not what 2339 is about.
    expect(at('o.prop;', 'o', 2339)).toBeNull();
  });

  it('reads an unresolved name as one at the top of its own file, but not a member', () => {
    expect(at('foo();', 'foo', 2304)).toMatchObject({ shape: 'local', name: 'foo' });
    expect(at('x.foo;', 'foo', 2304)).toBeNull();
  });

  it('refuses a span that is not exactly a name', () => {
    expect(at("import { abc } from './m';", 'ab', 2305)).toBeNull();
    expect(at("import { abc } from './m';", "'./m'", 2305)).toBeNull();
  });

  it('reads an arity from the callee, at its name or at an extra argument', () => {
    expect(at('f(1);', 'f', 2554)).toMatchObject({ family: 'arity', shape: 'local', name: 'f' });
    expect(at('f(1, 2);', '2', 2554)).toMatchObject({ shape: 'local', name: 'f' });
    expect(at("import { g as h } from './m';\nh(1);", 'h', 2554, 2)).toMatchObject({
      shape: 'import',
      name: 'g',
      specifier: './m',
      binding: 'h',
    });
    expect(at('o.m(1, 2);', 'm', 2554)).toMatchObject({ shape: 'property', name: 'm' });
    expect(
      at("import * as other from './o';\nimport * as ns from './m';\nns.f(1);", 'f', 2554, 3),
    ).toMatchObject({
      shape: 'import',
      specifier: './m',
    });
    expect(at("import * as ns from './m';\nns.f(1);", 'f', 2554, 2)).toMatchObject({
      shape: 'import',
      name: 'f',
    });
    // An argument that is itself a call belongs to the call around it.
    expect(at('f(1, g(2));', 'g(2)', 2554)).toMatchObject({ name: 'f' });
  });

  it('reads no arity where the callee is not a name, or nothing is called', () => {
    expect(at('class K { #p(a: number) {} q() { this.#p(); } }', '#p', 2554, 2)).toBeNull();
    expect(at('((a: number) => a)();', '((a: number) => a)', 2554)).toBeNull();
    expect(at('const x = 1;', 'x', 2554)).toBeNull();
  });
});

describe('importing @interlock/core', () => {
  it('does not load the compiler, which only attribution and a type-check worker use', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => {
      throw new Error('typescript was loaded by importing @interlock/core');
    });
    try {
      await expect(import('../index.js')).resolves.toBeDefined();
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});
