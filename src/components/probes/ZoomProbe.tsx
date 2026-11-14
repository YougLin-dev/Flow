import { Input } from "nsh/base";

/** The invisible input a test reads the camera scale from, when it asks for it. */
export function ZoomProbe(props: { readonly value: number | null }) {
  return (
    <Input
      testID="zoom-probe"
      readonly
      value={props.value === null ? "" : String(props.value)}
      style={{ position: "absolute", left: 8, top: 8, width: 1, height: 1, opacity: 0 }}
    />
  );
}
