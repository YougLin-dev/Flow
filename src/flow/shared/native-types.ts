/**
 * The one type-only seam over the Rust document core. Outside
 * `flow/document`, TSX imports these types here instead of `@flow/native`;
 * the runtime module stays document-only.
 */
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
} from "@flow/native";
