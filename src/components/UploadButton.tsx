/**
 * The upload card's own Upload/Replace button: a native control in the
 * canvas's world-point controls layer, so it scales with the camera and holds
 * its place on the card. The layer passes pointer events through; this button
 * sets `pointerEvents: "auto"` to take its press while the rest of the layer
 * stays transparent to the canvas.
 */
import { Text, token } from "nsh";
import { Button } from "nsh/base";
import { ImageUp, LoaderCircle, RefreshCw } from "lucide";
import type { IconNode } from "../flow/icon-shape";
import { Icon } from "./Icon";

/** The button's size and inset from the card's bottom-right, in world points. */
export const UPLOAD_BUTTON_WIDTH = 104;
export const UPLOAD_BUTTON_HEIGHT = 32;
export const UPLOAD_BUTTON_INSET = 12;

/** What the button does now: a first file, a replacement, or a busy import. */
export type UploadButtonState = "upload" | "replace" | "saving";

const ICONS: Record<UploadButtonState, IconNode> = {
  upload: ImageUp,
  replace: RefreshCw,
  saving: LoaderCircle,
};

const LABELS: Record<UploadButtonState, string> = {
  upload: "Upload",
  replace: "Replace",
  saving: "Saving…",
};

const ACCESSIBLE_LABELS: Record<UploadButtonState, string> = {
  upload: "Upload an image",
  replace: "Replace the image",
  saving: "Saving the image",
};

export interface UploadButtonProps {
  /** Its top-left point in the canvas's world coordinates. */
  readonly left: number;
  readonly top: number;
  readonly state: UploadButtonState;
  readonly disabled: () => boolean;
  readonly onPress: () => void;
}

export function UploadButton(props: UploadButtonProps) {
  return (
    <Button
      testID="upload-node-button"
      accessibilityLabel={ACCESSIBLE_LABELS[props.state]}
      disabled={props.disabled()}
      onPress={props.onPress}
      class="absolute flex-row items-center justify-center gap-1.5 rounded-(--radius) bg-primary px-3 shadow-lg hover:bg-primary-hover active:bg-primary-active"
      style={{
        left: props.left,
        top: props.top,
        width: UPLOAD_BUTTON_WIDTH,
        height: UPLOAD_BUTTON_HEIGHT,
        pointerEvents: "auto",
      }}
    >
      <Icon icon={ICONS[props.state]} size={14} tint={() => token("primary-foreground")} />
      <Text class="text-xs font-semibold text-primary-foreground" style={{ numberOfLines: 1 }}>
        {LABELS[props.state]}
      </Text>
    </Button>
  );
}
