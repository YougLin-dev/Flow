/**
 * The document commands behind a card's context menu: copying a card (after
 * writing any open editor's drafts) and deleting cards. They read the scene
 * and write through the document, so the menu stays a state and gesture
 * controller.
 */
import type { ChangeSet, Document, NodeDetail, NodeInput } from "@flow/native";
import type { NodeSettings } from "./node-kinds";
import type { FlowScene } from "./scene";

/** The open composer's unsaved values, which a copy writes before reading
 * the card so the duplicate carries what the user sees. */
export interface ComposerDrafts {
  readonly settings: NodeSettings | null;
  readonly body: string;
}

/** The session state a draft-aware copy writes before reading the card. */
export interface DraftSession {
  inlineId(): string | null;
  inlineText(): string;
  composerId(): string | null;
  detail(): NodeDetail | null;
  commitBody(nodeId: string, text: string): Promise<void>;
  saveSettings(nodeId: string, settings: NodeSettings): Promise<void>;
}

/** The document, scene and callbacks a node command needs. */
export interface NodeCommandHost {
  document(): Document | null;
  scene(): FlowScene | null;
  isDisposed(): boolean;
  applyChanges(changes: ChangeSet): void;
  activateNode(nodeId: string): void;
}

/** World points a copied card sits down-right of its source, so the two
 * cards read as separate rather than one drawn twice. */
const COPY_OFFSET = 24;

/**
 * Inserts a copy of a card's content and settings, offset from the source,
 * and selects it. Inputs, outputs and connectors are the original's, not
 * the card's own content, so they are not copied.
 *
 * `activateIf` is the selection the action started with: if the user has
 * selected something else while the command awaited the document, the copy
 * stays in the scene but does not steal that selection.
 */
export async function copyNode(
  host: NodeCommandHost,
  id: string,
  activateIf: readonly string[] | null = null,
): Promise<void> {
  const document = host.document();
  const scene = host.scene();
  if (!document || !scene || host.isDisposed()) return;
  const source = scene.node(id);
  // The effective rectangle includes a drag or resize not yet committed.
  const rect = scene.cardRect(id);
  if (!source || !rect) return;
  const copyId = `node-${crypto.randomUUID()}`;
  const input: NodeInput = {
    id: copyId,
    kind: source.kind,
    title: source.title,
    body: source.body,
    // A summary carries no tags; the kind is the same tag a new card gets.
    tags: [source.kind],
    x: rect.x + COPY_OFFSET,
    y: rect.y + COPY_OFFSET,
    width: rect.width,
    height: rect.height,
    z: source.z,
    dataJson: source.dataJson,
    settingsJson: source.settingsJson,
  };
  try {
    const changes = await document.insertNodes([input]);
    if (host.isDisposed()) return;
    host.applyChanges(changes);
    if (activateIf !== null && !sameSelection(scene.selection(), activateIf)) return;
    host.activateNode(copyId);
  } catch (error) {
    console.error("Flow could not copy the node", error);
  }
}

/**
 * Copies a card as the user sees it: an open inline editor's or composer's
 * drafts are written and awaited first, so the duplicate is not built from
 * stale committed content.
 */
export async function copyNodeWithDrafts(
  host: NodeCommandHost,
  session: DraftSession,
  id: string,
  drafts: ComposerDrafts | null,
): Promise<void> {
  const selection = host.scene()?.selection() ?? [];
  await flushDrafts(session, id, drafts);
  await copyNode(host, id, selection);
}

/**
 * Deletes a card, writing the drafts of an open editor for it first: undo
 * then restores the content the user saw before deleting.
 */
export async function deleteNodeWithDrafts(
  host: NodeCommandHost,
  session: DraftSession,
  id: string,
  drafts: ComposerDrafts | null,
): Promise<void> {
  await flushDrafts(session, id, drafts);
  await deleteNodes(host, [id]);
}

/** Deletes cards in one write; the change set also drops their connectors. */
export async function deleteNodes(host: NodeCommandHost, ids: readonly string[]): Promise<void> {
  const document = host.document();
  if (!document || host.isDisposed() || ids.length === 0) return;
  try {
    const changes = await document.deleteNodes([...ids]);
    if (!host.isDisposed()) host.applyChanges(changes);
  } catch (error) {
    console.error("Flow could not delete the nodes", error);
  }
}

/** Writes an open editor's drafts for `id`, the same writes closing it makes. */
async function flushDrafts(
  session: DraftSession,
  id: string,
  drafts: ComposerDrafts | null,
): Promise<void> {
  if (session.inlineId() === id) await session.commitBody(id, session.inlineText());
  if (drafts === null || session.composerId() !== id) return;
  const detail = session.detail();
  if (detail === null) return;
  if (drafts.settings !== null) await session.saveSettings(id, drafts.settings);
  if (drafts.body !== detail.node.body) await session.commitBody(id, drafts.body);
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
