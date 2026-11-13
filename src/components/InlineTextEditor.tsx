/**
 * A text card's body in edit mode: a borderless input at the body's world
 * size and type, under the camera's scale (applied by `FlowCanvas`), so its
 * font, wrapping and box are identical to the card's static text. Entering
 * edit mode changes nothing but the caret and any overflow scrolling; there
 * is no separate panel, border or confirm control.
 */
import { token } from "nsh";
import { Input } from "nsh/base";
import { CARD_BODY_FONT_SIZE, CARD_BODY_LINE_HEIGHT } from "../flow/card-layout";
import { keepsWheel } from "../flow/page-chrome";

export interface InlineTextEditorProps {
  /** The body's world size; the surrounding view scales it with the camera. */
  readonly width: number;
  readonly height: number;
  /** The draft, owned by the page's session so a remount keeps it. */
  readonly text: () => string;
  readonly onChange: (text: string) => void;
  /** Clicking away or losing focus writes the draft and closes the editor. */
  readonly onCommit: () => void;
}

export function InlineTextEditor(props: InlineTextEditorProps) {
  return (
    <Input
      testID="inline-text-input"
      accessibilityLabel="Text body"
      value={props.text()}
      onChange={(event) => props.onChange(event.value)}
      onBlur={props.onCommit}
      multiline
      autoFocus
      submitBehavior="newline"
      scrollbar={false}
      onWheel={keepsWheel}
      class="text-card-foreground"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: props.width,
        height: props.height,
        fontSize: CARD_BODY_FONT_SIZE,
        lineHeight: CARD_BODY_LINE_HEIGHT,
        padding: 0,
        borderWidth: 0,
        outlineWidth: 0,
        backgroundColor: "transparent",
        caretColor: token("card-foreground"),
      }}
    />
  );
}
