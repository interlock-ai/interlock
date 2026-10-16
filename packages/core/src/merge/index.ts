/**
 * Speculative merge engine: combine two in-flight branches in the shadow's
 * object database and classify what breaks.
 *
 * Nothing here touches a user repository — every function takes a `ShadowRepo`.
 */
export * from './speculative-merge.js';
// Listed by name: the classifier also exports the blob reader, its tree entry,
// and the binary check and alignment bound attribution shares with it, which
// are core's own.
export {
  MAX_BLOB_BYTES,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  MAX_FINDINGS_PER_RUN,
  MAX_SPANS_PER_SIDE,
  SEVERITY_BY_CLASS,
  changedHunks,
  classifyTextualConflicts,
  excerptOf,
  placeRegions,
  regionOverlaps,
  textualFindingContent,
  textualFindingKey,
} from './conflict-classifier.js';
export type {
  ClassifiedConflicts,
  ClassifyOptions,
  ClassifyRequest,
  TextualConflictClass,
} from './conflict-classifier.js';
