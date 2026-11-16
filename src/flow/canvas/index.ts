/**
 * The canvas area facade: the model and geometry surface other features and
 * the views use. Interaction stays internal except the document-facing
 * `ConnectionPair`; canvas views deep-import the interaction modules within
 * the feature.
 */
export type { BoxGeometry } from "../shared";
export { CanvasCamera, wheelNotches, wheelZoomFactor, type CameraSize } from "./model/camera";
export { screenRectOf } from "./model/screen-rect";
export { CardContent } from "./model/cards/card-content";
export type { CardImageEvent } from "./model/cards/card-image";
export { CardGeometry, cardLocalLayout, type CardSize } from "./model/cards/card-geometry";
export {
  CARD_BODY_FONT_SIZE,
  CARD_BODY_INSET,
  CARD_BODY_LINE_HEIGHT,
  CARD_TITLE_HEIGHT,
} from "./model/cards/card-layout";
export { inlineBodyBox } from "./model/cards/inline-body";
export { connectorLayerBox, trimConnectorBox } from "./model/edge-layer";
export { groupPorts, type GroupPort } from "./model/scene/group-ports";
export { FlowScene } from "./model/scene/scene";
export { capacityOf, hasPortEdge, incomingEdgeCount } from "./model/scene/scene-ports";
export type { ConnectionPreview, PreviewView } from "./model/scene/scene-types";
export type { ConnectionPair } from "./interaction/connection-gesture";
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
