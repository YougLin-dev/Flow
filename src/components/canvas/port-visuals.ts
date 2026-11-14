/** The icon and theme token a port type uses everywhere: cards, edges, previews. */
import { token } from "nsh";
import { Image, Type } from "lucide";
import { isPortKind, type PortKind } from "../../flow/node-kinds";
import type { IconNode } from "../primitives";

/** The theme tokens a port type may use for its icon, edges and previews. */
export type PortToken = "port-text" | "port-image";

export interface PortVisual {
  readonly icon: IconNode;
  readonly token: PortToken;
  /** The type's name in labels, such as "Text inputs". */
  readonly label: string;
}

const VISUALS: Record<PortKind, PortVisual> = {
  text: { icon: Type, token: "port-text", label: "Text" },
  image: { icon: Image, token: "port-image", label: "Image" },
};

export function portVisual(kind: PortKind): PortVisual {
  return VISUALS[kind];
}

/**
 * The stroke color a connector takes from its port type. Read it inside a
 * draw callback: `token()` must run per paint so a theme switch repaints.
 */
export function connectorColor(kind: string): string {
  return token(portVisual(isPortKind(kind) ? kind : "text").token);
}
