/** The icon and theme token a port type uses everywhere: cards, edges, previews. */
import { Image, Type } from "lucide";
import type { IconNode } from "./icon-shape";
import type { PortKind } from "./node-kinds";

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
