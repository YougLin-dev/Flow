/**
 * One typed port: a small circle in the type's color with the type's icon.
 * It is the connector's handle; the canvas controller reads the port's hit
 * zone, so the view itself is never pressed. A following port springs to its
 * caller's target within `PORT_FOLLOW_MAX` and springs back when the caller
 * asks for none, while its connector anchor stays put.
 */
import { cleanup, createAnimatedValue, effect, token, View } from "nsh";
import { Icon } from "./Icon";
import { followPoint, type Point, PORT_FOLLOW_MAX, PORT_SIZE } from "../flow/connection";
import type { InputPort, OutputPort } from "../flow/node-kinds";
import { portVisual, type PortToken } from "../flow/port-visuals";

/** The hovered port's follow and return springs, tuned to settle quickly. */
const FOLLOW_SPRING = { stiffness: 1200, damping: 68, mass: 1 } as const;
const RETURN_SPRING = { stiffness: 650, damping: 29, mass: 1 } as const;

/** The type-colored ring that makes a port readable on the dark canvas. */
const RING: Record<PortToken, string> = {
  "port-text": "border-port-text",
  "port-image": "border-port-image",
};

export interface PortProps {
  /** The port schema entry; its kind picks the icon and color. */
  readonly port: InputPort | OutputPort;
  /** The icon centre in the parent's coordinates. */
  readonly center: () => Point;
  /** The target, in the parent's coordinates, this port follows while the
   * pointer hovers it or a dragged connector end magnetizes it; the view caps
   * the lean at `PORT_FOLLOW_MAX`. */
  readonly follow?: () => Point | null;
  /** False when the port cannot start a connection right now. */
  readonly enabled?: () => boolean;
}

export function Port(props: PortProps) {
  const visual = portVisual(props.port.kind);
  const enabled = (): boolean => props.enabled?.() ?? true;

  // Start where the port should be this instant: one mounted while the
  // pointer already holds it appears under the pointer, not at rest.
  const start = (): Point => {
    const target = props.follow?.() ?? null;
    if (target === null) return { x: 0, y: 0 };
    const center = props.center();
    const followed = followPoint(center, target, PORT_FOLLOW_MAX);
    return { x: followed.x - center.x, y: followed.y - center.y };
  };
  const initial = start();
  const offsetX = createAnimatedValue(initial.x);
  const offsetY = createAnimatedValue(initial.y);
  let following = initial.x !== 0 || initial.y !== 0;
  effect(() => {
    const target = props.follow?.() ?? null;
    if (target === null) {
      // The other ports ignore the pointer; do not restart their rest
      // spring on every move.
      if (!following) return;
      following = false;
      void offsetX.spring(0, RETURN_SPRING);
      void offsetY.spring(0, RETURN_SPRING);
      return;
    }
    following = true;
    const center = props.center();
    const followed = followPoint(center, target, PORT_FOLLOW_MAX);
    void offsetX.spring(followed.x - center.x, FOLLOW_SPRING);
    void offsetY.spring(followed.y - center.y, FOLLOW_SPRING);
  });
  cleanup(() => {
    void offsetX.stop();
    void offsetY.stop();
  });

  return (
    <View
      class="absolute items-center justify-center rounded-full bg-card"
      accessibilityLabel={portLabel(props.port)}
      style={{
        left: props.center().x - PORT_SIZE / 2,
        top: props.center().y - PORT_SIZE / 2,
        width: PORT_SIZE,
        height: PORT_SIZE,
        opacity: enabled() ? 1 : 0.4,
        translate: [offsetX, offsetY],
      }}
    >
      {/* The ring is a background child, so a border on the positioned view
          cannot shift the icon. It carries the type's color, so a port reads
          as text or image at a glance. */}
      <View
        classList={{ "absolute rounded-full border": true, [RING[visual.token]]: true }}
        style={{ left: 0, top: 0, width: PORT_SIZE, height: PORT_SIZE }}
      />
      <Icon icon={visual.icon} size={11} strokeWidth={2.4} tint={() => token(visual.token)} />
    </View>
  );
}

/** The accessible name: the port's role, its type and its capacity. */
function portLabel(port: InputPort | OutputPort): string {
  return "capacity" in port
    ? `${port.name} (${port.kind}, up to ${port.capacity})`
    : `${port.name} (${port.kind})`;
}
