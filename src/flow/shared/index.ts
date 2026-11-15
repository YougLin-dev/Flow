/** The shared kernel's public surface; cross-area imports use this facade. */
export { AsyncDrain, type DrainStep, type DrainStepResult } from "./async-drain";
export {
  containsPoint,
  mergeBounds,
  overlaps,
  type BoxGeometry,
  type Point,
  type Rect,
  type Size,
  type StageSize,
} from "./geometry";
export { RECT_EPSILON, sameBounds, sameBox, samePoint, sameRect, sameRectWithin } from "./equality";
export { keepsWheel } from "./wheel";
export { KeyedFlags } from "./keyed-flags";
export { FIT_KEY, ZOOM_IN_KEY, ZOOM_OUT_KEY } from "./shortcuts";
export type {
  ChangeSet,
  Document,
  EdgeInput,
  EdgeSummary,
  InputItemSummary,
  NodeBounds,
  NodeDetail,
  NodeInput,
  NodePreview,
  NodeSummary,
  Overview,
  OverviewCard,
  ProjectEntry,
  ProjectInfo,
  ResultBatchInput,
  ResultItemInput,
  SceneSnapshot,
  SearchHit,
  SeedDocumentInput,
  Viewport,
} from "./native-types";
export {
  imageResultItem,
  type ManualTextResult,
  manualTextResult,
  type ResultBatchFields,
  resultBatch,
  type ResultItemFields,
  resultItem,
  textResultItem,
} from "./result-inputs";
