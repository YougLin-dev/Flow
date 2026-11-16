/**
 * The document side of the composer, inline text editor and card menu:
 * opening a node, saving settings, running the mock provider, managing
 * inputs, uploading images and copying or deleting cards. It exposes the
 * sessions' signals and delegates the composer's own state.
 */
import { signal } from "nsh";
import type { PickedImage, PickImagesOptions, Signal } from "nsh";
import type { ChangeSet, EdgeInput, NodeDetail, NodeInput } from "../../shared";
import { ComposerSession, type AssetUrlSource } from "./composer-session";
import type { NodeRunner } from "../../execution";
import { InlineEditor } from "./inline-editor";
import {
  copyNode as copyNodeCommand,
  copyNodeWithDrafts as copyNodeWithDraftsCommand,
  deleteNodes as deleteNodesCommand,
  deleteNodeWithDrafts as deleteNodeWithDraftsCommand,
  type NodeCommandHost,
} from "../commands/node-commands";
import {
  canConnectPorts,
  defaultSettings,
  type NodeKindId,
  type NodeSettings,
  nodeKind,
  portsOfNode,
  serializeSettings,
} from "../../nodes";
import { capacityOf, hasPortEdge, incomingEdgeCount, type ConnectionPair } from "../../canvas";
import { uploadSource as uploadSourceFile } from "../commands/upload-source";

export type { AssetUrlSource } from "./composer-session";

export interface NodeSessionHost extends NodeCommandHost {
  assets(): AssetUrlSource | null;
  runner(): NodeRunner | null;
  /** Shows the platform's image picker; a test host can answer it. */
  pickImages(options: PickImagesOptions): Promise<PickedImage[]>;
  schedulePreviews(): void;
}

export class NodeSession {
  readonly composerId: Signal<string | null>;
  readonly detail: Signal<NodeDetail | null>;
  readonly running: Signal<boolean>;
  /** The upload node whose picked files are importing, if any. */
  readonly uploadingNode = signal<string | null>(null);
  readonly assetVersion: Signal<number>;
  /** The card whose body is edited in place, and the draft it shows. */
  readonly inlineId: Signal<string | null>;
  readonly inlineText: Signal<string>;

  private readonly composer: ComposerSession;
  private readonly inline: InlineEditor;
  /** A pick, import or write is in flight; not the same as the Saving label. */
  private uploadInFlight = false;

  constructor(private readonly host: NodeSessionHost) {
    this.composer = new ComposerSession({
      document: () => this.host.document(),
      assets: () => this.host.assets(),
      runner: () => this.host.runner(),
      applyChanges: (changes) => this.host.applyChanges(changes),
      isDisposed: () => this.host.isDisposed(),
      // Keep the protected hook: tests observe the read through a subclass.
      nodeDetail: (id) => this.nodeDetail(id),
    });
    this.inline = new InlineEditor({
      document: () => this.host.document(),
      isDisposed: () => this.host.isDisposed(),
      applyChanges: (changes) => this.host.applyChanges(changes),
      openComposer: (nodeId) => this.openComposer(nodeId),
      closeComposer: () => this.closeComposer(),
    });
    this.composerId = this.composer.id;
    this.detail = this.composer.detail;
    this.running = this.composer.running;
    this.assetVersion = this.composer.assetVersion;
    this.inlineId = this.inline.nodeId;
    this.inlineText = this.inline.text;
  }

  /**
   * Reloads a composer whose node a command changed. A summary that differs
   * only in x, y, width or height keeps the loaded detail: the composer
   * renders content, not card geometry. Content fields and revisions always
   * reload, and so does every connector change: a connection feeds the
   * composer's inputs, and a removed edge has already left the scene, so its
   * endpoints cannot be matched to decide whether it touched this card.
   */
  onChanges(changes: ChangeSet): void {
    this.composer.noteChanges(changes);
    const inline = this.inlineId();
    if (inline !== null) {
      if (changes.removed.includes(inline)) {
        this.inline.close();
      } else if (!this.inline.applying()) {
        // A run, an undo or another editor changed the body under the
        // draft: the new content wins, and the stale draft must not write
        // back over it.
        const changed = changes.changed.find((node) => node.id === inline);
        if (changed !== undefined && this.inline.replaced(changed.body)) this.inline.close();
      }
    }
  }

  onSettled(nodeId: string): void {
    this.composer.onSettled(nodeId);
  }

  openComposer(id: string): void {
    this.composer.open(id);
  }

  closeComposer(): void {
    this.composer.close();
  }

  closeInline(): void {
    this.inline.close();
  }

  /** Keeps the inline editor's uncommitted draft across a remount. */
  setInlineText(text: string): void {
    this.inline.setText(text);
  }

  /** Writes the inline editor's draft and closes it once the write lands. */
  commitInline(): Promise<void> {
    return this.inline.commit();
  }

  /** Asset URLs for the composer's current images. */
  assetUrls(): Record<string, string> {
    return this.composer.assetUrls();
  }

  async saveSettings(id: string, settings: NodeSettings): Promise<void> {
    return this.composer.saveSettings(id, settings);
  }

  async run(settings: NodeSettings): Promise<void> {
    return this.composer.run(settings);
  }

  cancel(): void {
    this.composer.cancel();
  }

  async removeInput(inputId: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    try {
      const changes = await document.removeInput(inputId);
      if (this.host.isDisposed()) return;
      this.host.applyChanges(changes);
      this.host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not remove the input", error);
    }
  }

  async reorderInputs(ids: string[]): Promise<void> {
    const document = this.host.document();
    const id = this.composerId();
    if (!document || !id || this.host.isDisposed()) return;
    try {
      const changes = await document.reorderInputs(id, ids);
      if (this.host.isDisposed()) return;
      this.host.applyChanges(changes);
    } catch (error) {
      console.error("Flow could not reorder the inputs", error);
    }
  }

  async upload(): Promise<void> {
    const document = this.host.document();
    const id = this.composerId();
    if (!document || !id || this.host.isDisposed()) return;
    try {
      const picked = await this.host.pickImages({
        multiple: true,
        limit: 4,
        maxDimension: 2048,
        quality: 0.9,
      });
      // Read and import concurrently, then append in picker order: the
      // document assigns each input the next position on its port, so the
      // worker order is the display order. A failed import or append is
      // isolated so the images that did import still commit.
      const imports = await Promise.allSettled(
        picked.map(async (image) => {
          const bytes = new Uint8Array(await image.file.arrayBuffer());
          const metaJson = JSON.stringify({
            width: image.size.width,
            height: image.size.height,
          });
          const asset = await document.importAsset({
            id: `asset-${crypto.randomUUID()}`,
            kind: "image",
            name: image.file.name || "image",
            mime: image.file.type || "image/jpeg",
            bytes,
            metaJson,
          });
          return { asset, metaJson };
        }),
      );
      if (this.host.isDisposed()) return;
      let appends = Promise.resolve();
      for (const result of imports) {
        if (result.status === "rejected") {
          console.error("Flow could not upload an image", result.reason);
          continue;
        }
        appends = appends.then(async () => {
          if (this.host.isDisposed()) return;
          try {
            const changes = await document.addInput({
              id: `input-${crypto.randomUUID()}`,
              nodeId: id,
              portId: "references",
              kind: "image",
              origin: "local",
              assetId: result.value.asset.id,
              text: "",
              metaJson: result.value.metaJson,
            });
            if (!this.host.isDisposed()) this.host.applyChanges(changes);
          } catch (error) {
            console.error("Flow could not upload an image", error);
          }
        });
      }
      await appends;
      if (this.host.isDisposed()) return;
      this.host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not upload an image", error);
    }
  }

  /**
   * Uploads a local file as an upload node's output. The card's own button
   * calls this; one upload runs at a time.
   */
  async uploadSource(nodeId: string): Promise<void> {
    // The guard also covers the picker, but only the import and write are
    // "saving": the button must stay Upload/Replace while the picker is open.
    if (this.uploadInFlight || this.host.isDisposed()) return;
    this.uploadInFlight = true;
    try {
      await uploadSourceFile(this.host, nodeId, (saving) => {
        if (this.host.isDisposed()) return;
        this.uploadingNode.set(saving ? nodeId : null);
      });
    } catch (error) {
      console.error("Flow could not upload the file", error);
    } finally {
      this.uploadInFlight = false;
      if (this.uploadingNode() === nodeId) this.uploadingNode.set(null);
    }
  }

  async openInline(nodeId: string): Promise<void> {
    return this.inline.open(nodeId);
  }

  /** Writes `text` as the node's body: one undoable manual text item. */
  async writeBody(nodeId: string, text: string): Promise<void> {
    await this.inline.write(nodeId, text);
  }

  async addNode(kind: NodeKindId, x: number, y: number): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const definition = nodeKind(kind);
    const id = `node-${crypto.randomUUID()}`;
    const input: NodeInput = {
      id,
      kind,
      title: definition.name,
      body: "",
      tags: [kind],
      x: x - definition.size.width / 2,
      y: y - definition.size.height / 2,
      width: definition.size.width,
      height: definition.size.height,
      z: 0,
      settingsJson: serializeSettings(defaultSettings(kind)),
    };
    try {
      const changes = await document.insertNodes([input]);
      if (this.host.isDisposed()) return;
      this.host.applyChanges(changes);
      this.host.activateNode(id);
    } catch (error) {
      console.error("Flow could not add a node", error);
    }
  }

  /**
   * Inserts a copy of a card's content and settings, offset from the source,
   * and selects it. Inputs, outputs and connectors are the original's, not
   * the card's own content, so they are not copied.
   */
  async copyNode(id: string): Promise<void> {
    return copyNodeCommand(this.host, id);
  }

  /**
   * Copies a card as the user sees it: an open inline editor's or composer's
   * drafts are written and awaited first, so the duplicate is not built from
   * stale committed content.
   */
  async copyNodeWithDrafts(id: string, settings: NodeSettings | null): Promise<void> {
    return copyNodeWithDraftsCommand(this.host, this, id, settings);
  }

  /**
   * Deletes cards in one write; the change set also drops their connectors.
   * A deleted card's run is cancelled first so its provider cannot keep
   * importing assets for a node that no longer exists.
   */
  async deleteNodes(ids: readonly string[]): Promise<void> {
    this.cancelRuns(ids);
    return deleteNodesCommand(this.host, ids);
  }

  /**
   * Deletes one card, writing its open editor's drafts first so undo
   * restores the content the user saw.
   */
  async deleteNodeWithDrafts(id: string, settings: NodeSettings | null): Promise<void> {
    this.cancelRuns([id]);
    return deleteNodeWithDraftsCommand(this.host, this, id, settings);
  }

  private cancelRuns(ids: readonly string[]): void {
    const runner = this.host.runner();
    for (const id of ids) runner?.cancel(id);
  }

  /** Connects one or more pairs in one write; duplicates and bad pairs skip. */
  async connectNodes(pairs: readonly ConnectionPair[]): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || this.host.isDisposed()) return;
    const valid: ConnectionPair[] = [];
    for (const pair of pairs) {
      if (pair.fromId === pair.toId) continue;
      const fromNode = scene.node(pair.fromId);
      const toNode = scene.node(pair.toId);
      if (fromNode === null || toNode === null) continue;
      if (
        !canConnectPorts(portsOfNode(fromNode), pair.fromPort, portsOfNode(toNode), pair.toPort)
      ) {
        continue;
      }
      if (hasPortEdge(scene, pair.fromId, pair.fromPort, pair.toId, pair.toPort)) continue;
      valid.push(pair);
    }
    // Capacity is checked for the whole batch: one full input rejects the
    // gesture rather than writing a partial fan-out.
    const proposed = new Map<string, number>();
    for (const pair of valid) {
      const key = `${pair.toId}\u0000${pair.toPort}`;
      const capacity = capacityOf(scene, pair.toId, pair.toPort);
      const existing = incomingEdgeCount(scene, pair.toId, pair.toPort);
      const added = proposed.get(key) ?? 0;
      if (capacity === null || existing + added + 1 > capacity) return;
      proposed.set(key, added + 1);
    }
    const edges: EdgeInput[] = valid.map((pair) => ({
      id: `edge-${crypto.randomUUID()}`,
      fromId: pair.fromId,
      toId: pair.toId,
      fromPort: pair.fromPort,
      toPort: pair.toPort,
      portKind: pair.portKind,
      fromOffset: pair.fromOffset,
      toOffset: pair.toOffset,
      kind: "flow",
    }));
    if (edges.length === 0) return;
    const only = edges.length === 1 ? edges[0] : null;
    try {
      const changes = only ? await document.connectEdge(only) : await document.connectEdges(edges);
      if (this.host.isDisposed()) return;
      this.host.applyChanges(changes);
      this.host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not connect the nodes", error);
    }
  }

  async deleteEdge(id: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    try {
      const changes = await document.deleteEdges([id]);
      if (!this.host.isDisposed()) this.host.applyChanges(changes);
    } catch (error) {
      console.error("Flow could not delete the connection", error);
    }
  }

  async reconnectEdge(edgeId: string, pair: ConnectionPair): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || pair.fromId === pair.toId || this.host.isDisposed()) return;
    const fromNode = scene.node(pair.fromId);
    const toNode = scene.node(pair.toId);
    if (fromNode === null || toNode === null) return;
    if (!canConnectPorts(portsOfNode(fromNode), pair.fromPort, portsOfNode(toNode), pair.toPort)) {
      return;
    }
    // The pair a reconnect would write must not already belong to another
    // edge: the writer rejects it, and the gesture should never have offered it.
    if (hasPortEdge(scene, pair.fromId, pair.fromPort, pair.toId, pair.toPort)) return;
    // The edge being moved does not occupy a slot in its new target.
    const capacity = capacityOf(scene, pair.toId, pair.toPort);
    const existing = incomingEdgeCount(scene, pair.toId, pair.toPort, edgeId);
    if (capacity === null || existing + 1 > capacity) return;
    try {
      const changes = await document.updateEdge({
        id: edgeId,
        fromId: pair.fromId,
        toId: pair.toId,
        fromPort: pair.fromPort,
        toPort: pair.toPort,
        portKind: pair.portKind,
        fromOffset: pair.fromOffset,
        toOffset: pair.toOffset,
        kind: "flow",
      });
      if (!this.host.isDisposed()) this.host.applyChanges(changes);
      this.host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not reconnect the nodes", error);
    }
  }

  /** Reads one node's detail; tests observe the read through a subclass. */
  protected async nodeDetail(id: string): Promise<NodeDetail | null> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return null;
    return document.nodeDetail(id);
  }
}
