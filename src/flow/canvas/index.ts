/**
 * The canvas area facade: the geometry other features and the views need.
 * The area's model and interaction modules stay internal; canvas views
 * deep-import those within the feature.
 */
export type { BoxGeometry } from "../shared";
export {
  connectionBounds,
  connectorControls,
  cubicBounds,
  EDGE_DASH,
  EDGE_PADDING,
  EDGE_THICKNESS,
  followPoint,
  magnetIconPoint,
  PORT_CENTER_GAP,
  PORT_FOLLOW_MAX,
  PORT_SIZE,
  type PortSide,
  portOffset,
} from "./geometry/connection";
export { cubicInsideView, visibleCubicRuns } from "./geometry/edge-clip";
export { gridLayout, wrappedGridOffset } from "./geometry/grid";
export { previewCell } from "./geometry/preview-grid";
export { tipWidth, tooltipBox, type TipPlacement } from "./geometry/tooltip";
export { cardInView } from "./geometry/view-culling";
