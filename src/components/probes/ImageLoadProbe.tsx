import { host } from "nsh";
import { Input } from "nsh/base";
import type { CardImageEvent } from "../../flow/canvas";

/** The host regression's report, or nothing unless its launch parameter asks. */
export function imageProbeText(event: CardImageEvent): string {
  if (host.params.flowImageLoadProbe !== 1) return "";
  return [event.kind, event.nodeId, event.url, event.width, event.height, event.message].join(";");
}

/** The invisible input a host test reads the last image event from. */
export function ImageLoadProbe(props: { readonly value: string }) {
  return (
    <Input
      testID="image-load-probe"
      readonly
      value={props.value}
      style={{ position: "absolute", left: 8, top: 8, width: 360, height: 1, opacity: 0 }}
    />
  );
}
