# Attribution

How a compiler diagnostic from a merged tree becomes a Finding about two
branches. The code in `attribution.ts` carries the rules; this is why they are
shaped as they are.

## The code gives the family, the change gives the rule

A rename and a moved export reach the compiler as the same thing: an import of
a name the module no longer exports, TS2305 at the import specifier. A table
from code to rule would call every stale import a move, or every one a rename.
So a code says only which family the error is in:

| Codes            | Family | Looked for                                |
| ---------------- | ------ | ----------------------------------------- |
| 2304, 2552       | name   | at the top of the reference's own file    |
| 2339, 2551       | name   | as a member, or a namespace import's name |
| 2305, 2614, 2724 | name   | as an export of the imported module       |
| 2554, 2555       | arity  | by the callee: imported, local or member  |
| anything else    | —      | not looked for; no branch is named        |

Each twin — 2552 of 2304, 2551 of 2339 — is the same error with a "did you
mean" attached, which TypeScript adds whenever the old name is close to one in
scope. The rule comes from what the declaring branch did to the declaration:
renamed is `rename-vs-callsite`, moved is `moved-export-vs-import`, a changed
parameter list is `signature-vs-caller`, and a removal is the generic
`merge-breaks-typecheck`, since no label names it and calling it a rename would
claim a new name that does not exist.

The name is read from the merged file's syntax at the diagnostic's offset,
never from its message, whose wording changes between releases. The offset
must land on the line and column the diagnostic reports, or the file read from
the shadow is not the file the compiler read.

## Which branch did what

Both halves are needed for these conflicts, so attribution makes two decisions
and names a branch only when both are certain:

- The **declaring** branch is the one whose ChangeSet touches the declaration —
  a hunk's old range crosses it, an insertion lands strictly inside it, or its
  file was deleted or renamed — and whose own tree then shows a change the
  family explains: the name moved, renamed or gone, or the parameters changed.
  The declaration is found in the pair's merge base first, and found again in
  the ChangeSet's own base before its hunks are compared, because a ChangeSet is
  diffed against the merge base with the default branch, which need not be the
  pair's.
- The **referencing** branch is the one whose ChangeSet adds the line holding
  the diagnostic, placed in that branch's own copy of the file.

`originBranch` is the declaring branch: `Attribution.originBranch` is "the side
that introduced the change that broke the other", and that is the side whose
change took the name away. It is chosen once, for every rule.

## When it cannot tell, it names no branch

The questions are asked in a fixed order, and the first that has no certain
answer is the rationale:

1. a code this does not read;
2. a location that does not hold what the code describes, or a file that
   cannot be read — absent, over the parse cap, binary, nested past the
   parser's stack, or with a line break git does not count;
3. a ChangeSet missing, or naming another branch;
4. no unique declaration — a bare specifier, a global, several candidates;
5. a ChangeSet that does not describe the merged commit;
6. the reference already in the base;
7. both branches, or neither, touching the declaration, or the one that did
   still having it as the diagnostic needs;
8. a line that cannot be placed in a branch's file;
9. both branches, or neither, adding the reference, or the declaring branch
   adding it too.

Every one of these still raises a Finding: the merged tree does not compile,
and that is ground truth. It names no branch, carries confidence 0.5 against an
attributed one's 1, and keeps whatever evidence was established — the
compiler's output always, and any span that could be placed. A wrong accusation
costs more agent trust than a vague warning, so a guess is never the tiebreak.

It is the merge's ground truth only because of what attribution is given: the
baseline differ's output, the diagnostics present in the merged tree and absent
from the merge base and from each branch alone. Given the type-check
service's whole report, every error already on the default branch would come
back as a Finding about the pair, at 0.5 where nothing else could be told.

A **stale ChangeSet** is real, not theoretical: a side the scheduler captures
again keeps the ChangeSet it had, against a new tree. For every path a decision
reads, the blobs at the ChangeSet's base and at the merged commit are checked
against what it claims — added, deleted, renamed, modified or untouched — and
one that disagrees is treated as missing.

## Lines are each branch's own

The diagnostic's line is the merged tree's. A file the other branch also
changed has different lines on this one, so the merged file is aligned to the
branch's file (`alignLines`, at most `MAX_ALIGN_EDITS` differing lines):

- an identical blob maps line for line;
- an aligned line maps exactly;
- an unaligned line is one this branch does not have — the other branch's
  change is precisely what separates the two files;
- files too far apart to align leave the line unplaced: the branch's span
  widens to the lines its own hunks wrote in that file, and its answer is
  unsure, which names no branch.

A renamed declaration is found where the base declaration maps to: everything
strictly between the images of the nearest aligned lines around it, which still
bounds the place when the renamed line itself has no image.

Spans follow the labels the evaluation suite was written with: the declaring
branch's on the declaration — from its start to its name for a rename, to the
close of its parameters for a signature, the whole of it in its new file for a
move, and empty where a removed one was — and the referencing branch's on the
reference — the import and every use of the name it binds for a stale import,
the call for an arity, and the line otherwise.

A label marks a stale import from the import to its last use, but a span that
long claims every line between, which in a long file is most of it. So the
import is one span and each run of adjacent lines using the name is another,
up to `MAX_SPANS_PER_SIDE` in all: together they reach both ends of the label,
which the suite scores by overlap, without covering what lies between.

## What it reads, and what it must not

Sources come from the shadow by tree id, through the textual classifier's blob
reader, and are parsed with Interlock's own TypeScript — `createSourceFile`,
never a program, so nothing in the tree is resolved, loaded or run. The
compiler is imported on first use: importing `@interlock/core` must not load it.

Names, paths and excerpts are repository content. They go into the spans, the
symbol trail and the compiler output, which the CLI does not print; titles,
descriptions and rationales are fixed text.

It runs on the daemon's thread, so its cost is bounded where a repository
chooses it. A parse costs about 130 ms a megabyte once warm, so a file past
`MAX_PARSED_BYTES` (256 KiB) is not parsed, and each parse is a turn of the
event loop of its own: the longest stall is one file's, a few tens of
milliseconds. A repository decides how many files a branch touches, so a search
across them stops at `MAX_SCANNED_FILES`, and the batch at
`MAX_FINDINGS_PER_RUN` diagnostics. Loading the compiler on first use holds the
thread for a few hundred milliseconds, once per process.
