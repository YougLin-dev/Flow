/**
 * The context-menu layer: while a secondary press's menu is open, the popup
 * for the card, connector or empty canvas it landed on. The page owns the
 * menu controller; this view binds its anchor, target and items.
 */
import type { Accessor } from "nsh";
import { type CanvasMenuController, contextMenuPosition } from "../flow/context-menu";
import type { StageSize } from "../flow/overlay";
import { CanvasContextMenu } from "./CanvasContextMenu";

export interface CanvasMenuLayerProps {
  readonly menu: CanvasMenuController;
  /** The canvas size the popup is kept inside. */
  readonly stage: Accessor<StageSize>;
}

export function CanvasMenuLayer(props: CanvasMenuLayerProps) {
  return (
    <If when={props.menu.open()}>
      {(press) => (
        <CanvasContextMenu
          left={contextMenuPosition(press(), props.stage()).left}
          top={contextMenuPosition(press(), props.stage()).top}
          nodeId={() => press().nodeId}
          edgeId={() => press().edgeId}
          onClose={() => {
            props.menu.close();
          }}
          onAddText={() => props.menu.add("text", press())}
          onAddImage={() => props.menu.add("image", press())}
          onAddUpload={() => props.menu.add("upload", press())}
          canEditText={() => props.menu.canEditBody()}
          onEditText={() => props.menu.editBody(press())}
          onCopyNode={() => props.menu.copyCard(press())}
          onDeleteNode={() => props.menu.deleteCard(press())}
          onDeleteEdge={() => props.menu.deleteEdge(press())}
          onMove={(x, y, held) => props.menu.move(x, y, held)}
          onPress={(x, y) => props.menu.press({ x, y })}
          onRelease={() => props.menu.release()}
        />
      )}
    </If>
  );
}
