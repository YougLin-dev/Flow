/** The shared kernel's public surface; cross-area imports use this facade. */
export { AsyncDrain, type DrainStep, type DrainStepResult } from "./async-drain";
export type { Point, Rect, Size } from "./geometry";
export { RECT_EPSILON, sameBounds, sameBox, samePoint, sameRect, sameRectWithin } from "./equality";
export { keepsWheel } from "./wheel";
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
  ResultBatchInput,
  ResultItemInput,
  SceneSnapshot,
  SearchHit,
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
