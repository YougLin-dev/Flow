/**
 * A round plus button outside a card or selection frame. It rests at the
 * default anchor, eases toward the pointer while a side zone holds it, and
 * springs back when the zone lets go. It is the connector's drag handle; the
 * pointer never presses the view itself, the canvas controller reads the zone.
 */
import { cleanup, createAnimatedValue, effect, token, View } from "nsh";
import { Plus } from "lucide";
import { Icon } from "./Icon";
import { PORT_PLUS_SIZE, type Point } from "../flow/connection";
import type { FlowAccent } from "../flow/node-kinds";

/** The plus button's follow and snap-back springs. */
const FOLLOW_SPRING = { stiffness: 600, damping: 48, mass: 1 } as const;
const RETURN_SPRING = { stiffness: 300, damping: 20, mass: 1 } as const;

export interface PortPlusProps {
  readonly accent: FlowAccent;
  readonly base: () => Point;
  readonly follow: () => Point | null;
}

export function PortPlus(props: PortPlusProps) {
  // Start where the plus should be this instant: a plus mounted while the
  // pointer already holds it appears in its followed place instead of
  // snapping back to rest and flying out again.
  const start = (): Point => {
    const followed = props.follow();
    if (followed === null) return { x: 0, y: 0 };
    const base = props.base();
    return { x: followed.x - base.x, y: followed.y - base.y };
  };
  const initial = start();
  // Animated values, not CSS transitions: the follow retargets on every
  // pointer move, which a style transition can stall between its frames.
  const offsetX = createAnimatedValue(initial.x);
  const offsetY = createAnimatedValue(initial.y);
  let following = initial.x !== 0 || initial.y !== 0;
  effect(() => {
    const followed = props.follow();
    if (followed === null) {
      // The other side ignores the pointer; do not restart its rest spring
      // on every move.
      if (!following) return;
      following = false;
      void offsetX.spring(0, RETURN_SPRING);
      void offsetY.spring(0, RETURN_SPRING);
      return;
    }
    following = true;
    const base = props.base();
    void offsetX.spring(followed.x - base.x, FOLLOW_SPRING);
    void offsetY.spring(followed.y - base.y, FOLLOW_SPRING);
  });
  cleanup(() => {
    void offsetX.stop();
    void offsetY.stop();
  });

  return (
    <View
      class="absolute items-center justify-center rounded-full bg-card shadow-sm"
      style={{
        left: props.base().x - PORT_PLUS_SIZE / 2,
        top: props.base().y - PORT_PLUS_SIZE / 2,
        width: PORT_PLUS_SIZE,
        height: PORT_PLUS_SIZE,
        translate: [offsetX, offsetY],
      }}
    >
      {/* The ring is a background child and flex centres the icon, so neither
          depends on the positioned parent's padding box (a border on it would
          otherwise shift absolute children by the border width). The plus is
          one canvas path, so its two bars cannot round apart. */}
      <View
        class="absolute rounded-full border border-border"
        style={{ left: 0, top: 0, width: PORT_PLUS_SIZE, height: PORT_PLUS_SIZE }}
      />
      <Icon icon={Plus} size={PORT_PLUS_SIZE} strokeWidth={3} tint={() => token(props.accent)} />
    </View>
  );
}
