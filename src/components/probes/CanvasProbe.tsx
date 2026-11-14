import { Input } from "nsh/base";

/** The invisible input a test reads the canvas' selection and composer state from. */
export function CanvasProbe(props: { readonly selected: number; readonly composing: boolean }) {
  return (
    <Input
      testID="canvas-probe"
      readonly
      value={`${props.selected};${props.composing ? 1 : 0}`}
      style={{ position: "absolute", left: 8, top: 8, width: 1, height: 1, opacity: 0 }}
    />
  );
}
