/**
 * The workspace's composer policy: which card's composer is open, how
 * switching cards keeps the open drafts, and where the composer sits. The
 * workspace owns the `ComposerState`; this module owns the rules around it so
 * the canvas controller and the page share one implementation.
 */
import type { CanvasCamera, FlowScene } from "../../../flow/canvas";
import type { CanvasController } from "../../../flow/canvas/interaction/canvas-controller";
import { composerPlacement, type ComposerState } from "../../../flow/composer";
import type { NodeSession } from "../../../flow/document";
import type { StageSize } from "../../../flow/shared";

export interface WorkspaceComposerDeps {
  readonly session: () => NodeSession | null;
  readonly state: ComposerState;
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
  readonly stage: () => StageSize;
}

export interface WorkspaceComposer {
  readonly position: () => ReturnType<typeof composerPlacement>;
  readonly open: () => boolean;
  /** Opens the composer for `id`, saving a previously open one's drafts. */
  readonly openAt: (id: string) => void;
  readonly close: () => void;
  /** Writes the inline editor's draft and closes it. */
  readonly closeInlineDraft: () => void;
}

export function createWorkspaceComposer(deps: WorkspaceComposerDeps): WorkspaceComposer {
  const close = (): void => {
    const session = deps.session();
    deps.state.save(session, session?.detail() ?? null);
    deps.state.reset();
    session?.closeComposer();
  };

  const closeInlineDraft = (): void => {
    void deps.session()?.commitInline();
  };

  const openAt = (id: string): void => {
    const session = deps.session();
    if (!session) return;
    // An upload card is its own control: selecting it closes an editor left
    // open elsewhere, but shows the card's own button instead of a composer.
    if (deps.scene.node(id)?.kind === "upload") {
      if (session.inlineId() !== null) closeInlineDraft();
      if (session.composerId() !== null) close();
      return;
    }
    const previous = session.composerId();
    if (previous === id) return;
    // Switching cards directly (a click or a search result) must keep the
    // open composer's drafts; only the close paths saved them before.
    if (previous !== null) {
      deps.state.save(session, session.detail());
      deps.state.reset();
    }
    if (session.inlineId() !== null && session.inlineId() !== id) closeInlineDraft();
    if (session.inlineId() === id) return;
    session.openComposer(id);
  };

  const position = (): ReturnType<typeof composerPlacement> =>
    composerPlacement(
      deps.session()?.composerId() ?? null,
      // A click on the selected card stays a click: only real movement (a
      // drag, a resize or a pulled connector) hides the composer, so its
      // native input keeps its draft and caret while the press is held.
      deps.controller.gestureMoved(),
      (id) => deps.scene.cardRect(id),
      deps.camera,
      deps.stage(),
    );

  const open = (): boolean => (deps.session()?.composerId() ?? null) !== null;

  return { position, open, openAt, close, closeInlineDraft };
}
