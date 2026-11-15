/**
 * Writes the editors' uncommitted drafts before the document closes. The
 * composer's draft lives only in `ComposerState` until its close path saves
 * it, and the inline editor's draft only in the editor; shutting down
 * without them would silently discard what the user typed. Both writes are
 * enqueued on the FIFO document worker, so they land ahead of the close job.
 */
import type { ComposerState } from "../../../flow/composer";
import type { NodeSettings } from "../../../flow/nodes";
import type { NodeDetail } from "../../../flow/shared";

/** The session members the draft save needs; `NodeSession` implements it. */
export interface DraftSession {
  detail(): NodeDetail | null;
  saveSettings(nodeId: string, settings: NodeSettings): Promise<void>;
  closeComposer(): void;
  commitInline(): Promise<void>;
}

/**
 * Saves and closes the open composer, then awaits the inline editor's write.
 * The settings write is enqueued synchronously by `ComposerState.save`; the
 * inline commit is awaited because it may queue behind a write already in
 * flight. With no session (a close before the document opened) it is a no-op.
 */
export async function saveOpenDrafts(
  session: DraftSession | null,
  composerState: ComposerState,
): Promise<void> {
  if (session === null) return;
  composerState.save(session, session.detail());
  composerState.reset();
  session.closeComposer();
  await session.commitInline();
}
