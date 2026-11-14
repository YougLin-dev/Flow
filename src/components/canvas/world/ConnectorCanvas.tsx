/** The one native canvas a connector layer draws into: styled from its box. */
import { Canvas, type Accessor, type CanvasRenderingContext2D } from "nsh";
import type { Point, Rect } from "../../../flow/shared";
import { connectorLayerView } from "./connector-layer";

export interface ConnectorCanvasProps {
  /** The world box the layer shows; the canvas is placed and sized from it. */
  readonly box: Accessor<Rect | null>;
  readonly padding?: number;
  readonly zIndex?: number;
  /** Draws the layer; `origin` is null while the layer has no box. */
  readonly draw: (cx: CanvasRenderingContext2D, origin: Point | null) => void;
}

export function ConnectorCanvas(props: ConnectorCanvasProps) {
  const view = connectorLayerView(props.box, props.padding);

  return (
    <Canvas
      style={{
        position: "absolute",
        left: view.left(),
        top: view.top(),
        width: view.width(),
        height: view.height(),
        ...(props.zIndex === undefined ? {} : { zIndex: props.zIndex }),
        pointerEvents: "none",
      }}
      draw={(cx) => props.draw(cx, view.origin())}
    />
  );
}
