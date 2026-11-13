/**
 * The inline text editor's screen-space overlay. It reads the page's session
 * and follows the card's current screen rectangle, like the composer and the
 * upload button; the page mounts it once and it renders nothing while closed.
 */
import type { CanvasCamera } from "../flow/camera";
import type { NodeSession } from "../flow/node-session";
import { inlinePlacement, type StageSize } from "../flow/overlay";
import type { FlowScene } from "../flow/scene";
import { InlineTextEditor } from "./InlineTextEditor";

export interface InlineEditorProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly stage: () => StageSize;
  readonly session: () => NodeSession | null;
}

export function InlineEditor(props: InlineEditorProps) {
  const placement = () => {
    const id = props.session()?.inlineId() ?? null;
    if (id === null) return null;
    const rect = (nodeId: string) => props.scene.cardRect(nodeId);
    return inlinePlacement(id, rect, props.camera, props.stage());
  };

  return (
    <If when={props.session()?.inlineId()}>
      {(id) => (
        <If when={placement()}>
          {(position) => (
            <InlineTextEditor
              nodeId={() => props.session()?.inlineId() ?? null}
              text={() => props.session()?.inlineText() ?? ""}
              left={position().left}
              top={position().top}
              width={position().width}
              height={position().height}
              onChange={(text) => props.session()?.setInlineText(text)}
              onSave={(text) => void props.session()?.commitBody(id(), text)}
              onCancel={() => props.session()?.closeInline()}
            />
          )}
        </If>
      )}
    </If>
  );
}
