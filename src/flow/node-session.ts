/**
 * The document side of the composer and inline text editor: opening a node,
 * saving settings, running the mock provider, managing inputs and uploading
 * images. It owns the small piece of UI state the page renders.
 */
import { signal } from "nsh";
import type { PickedImage, PickImagesOptions } from "nsh";
import type {
  ChangeSet,
  Document,
  EdgeInput,
  NodeDetail,
  NodeInput,
  NodeSummary,
  ResultBatchInput,
  ResultItemInput,
} from "@flow/native";
import type { ConnectionPair } from "./connection-gesture";
import type { NodeRunner } from "./execution";
import {
  canConnectPorts,
  defaultSettings,
  type NodeKindId,
  type NodeSettings,
  nodeKind,
  serializeSettings,
} from "./node-kinds";
import type { FlowScene } from "./scene";
import { capacityOf, hasPortEdge, incomingEdgeCount } from "./scene-ports";

/** The asset URL cache the composer reads; `AssetUrls` implements it. */
export interface AssetUrlSource {
  url(id: string, mime: string): Promise<string | null>;
  get(id: string): string | null;
}

export interface NodeSessionHost {
  document(): Document | null;
  scene(): FlowScene | null;
  assets(): AssetUrlSource | null;
  runner(): NodeRunner | null;
  /** Shows the platform's image picker; a test host can answer it. */
  pickImages(options: PickImagesOptions): Promise<PickedImage[]>;
  applyChanges(changes: ChangeSet): void;
  schedulePreviews(): void;
  activateNode(nodeId: string): void;
  isDisposed(): boolean;
}

export class NodeSession {
  readonly composerId = signal<string | null>(null);
  readonly detail = signal<NodeDetail | null>(null);
  readonly running = signal(false);
  readonly assetVersion = signal(0);
  readonly inlineId = signal<string | null>(null);
  readonly inlineText = signal("");

  private readonly announced = new Set<string>();
  private generation = 0;
  private inlineGeneration = 0;

  constructor(private readonly host: NodeSessionHost) {}

  /**
   * Reloads a composer whose node a command changed. A summary that differs
   * only in x, y, width or height keeps the loaded detail: the composer
   * renders content, not card geometry. Content fields and revisions always
   * reload, and so does every connector change: a connection feeds the
   * composer's inputs, and a removed edge has already left the scene, so its
   * endpoints cannot be matched to decide whether it touched this card.
   */
  onChanges(changes: ChangeSet): void {
    const id = this.composerId();
    if (id !== null) {
      // A removed node has no detail to reload; close before the page's
      // selection effect tries to save drafts back into a deleted row.
      if (changes.removed.includes(id)) {
        this.closeComposer();
      } else {
        const current = this.detail();
        let reload = false;
        if (current === null || current.node.id !== id) {
          reload = true;
        } else {
          for (const node of changes.changed) {
            if (node.id === id && !canSkipDetailReload(current.node, node)) reload = true;
          }
        }
        if (changes.edgesChanged.some((edge) => edge.fromId === id || edge.toId === id)) {
          reload = true;
        }
        if (changes.edgesRemoved.length > 0) reload = true;
        if (reload) void this.loadComposer(id);
      }
    }
    const inline = this.inlineId();
    if (inline !== null && changes.removed.includes(inline)) this.closeInline();
  }

  onSettled(nodeId: string): void {
    if (this.composerId() !== nodeId) return;
    this.running.set(this.host.runner()?.isRunning(nodeId) ?? false);
    void this.loadComposer(nodeId);
  }

  openComposer(id: string): void {
    if (this.composerId() === id && this.detail()) return;
    this.composerId.set(id);
    this.detail.set(null);
    this.running.set(this.host.runner()?.isRunning(id) ?? false);
    void this.loadComposer(id);
  }

  closeComposer(): void {
    this.generation += 1;
    this.composerId.set(null);
    this.detail.set(null);
    this.running.set(false);
  }

  closeInline(): void {
    this.inlineGeneration += 1;
    this.inlineId.set(null);
    this.inlineText.set("");
  }

  /** Keeps the inline editor's uncommitted draft across a remount. */
  setInlineText(text: string): void {
    this.inlineText.set(text);
  }

  /** Asset URLs for the composer's current images. */
  assetUrls(): Record<string, string> {
    this.assetVersion();
    const detail = this.detail();
    const assets = this.host.assets();
    if (detail === null || assets === null) return {};
    const entries: Array<readonly [string, string]> = [];
    for (const id of assetIds(detail)) {
      const url = assets.get(id);
      if (url !== null) entries.push([id, url]);
    }
    return Object.fromEntries(entries);
  }

  async saveSettings(id: string, settings: NodeSettings): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const json = serializeSettings(settings);
    const current = this.detail();
    if (current?.node.id === id && current.node.settingsJson === json) return;
    try {
      const changes = await document.setNodeSettings(id, json);
      if (!this.host.isDisposed()) this.host.applyChanges(changes);
    } catch (error) {
      console.error("Flow could not save the node settings", error);
    }
  }

  async run(settings: NodeSettings): Promise<void> {
    const detail = this.detail();
    const id = this.composerId();
    const runner = this.host.runner();
    if (!detail || !id || !runner || this.running()) return;
    this.running.set(true);
    await this.saveSettings(id, settings);
    if (this.host.isDisposed()) return;
    await runner.run(detail, settings);
  }

  cancel(): void {
    const id = this.composerId();
    if (id) this.host.runner()?.cancel(id);
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
      // Inputs may have gaps after removals, so append past the highest
      // position instead of counting rows; a duplicate position would make
      // the order ambiguous. Read the current list: the composer may have
      // closed while the picker was open.
      const current = await document.nodeDetail(id);
      const base =
        current?.inputs.reduce((next, input) => Math.max(next, input.position + 1), 0) ?? 0;
      // Upload concurrently; each image gets its own position, and a failure
      // is isolated so the images that did upload still commit.
      const results = await Promise.allSettled(
        picked.map(async (image, index) => {
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
          return document.addInput({
            id: `input-${crypto.randomUUID()}`,
            nodeId: id,
            position: base + index,
            portId: "references",
            kind: "image",
            origin: "local",
            assetId: asset.id,
            text: "",
            metaJson,
          });
        }),
      );
      if (this.host.isDisposed()) return;
      for (const result of results) {
        if (result.status === "fulfilled") this.host.applyChanges(result.value);
        else console.error("Flow could not upload an image", result.reason);
      }
      this.host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not upload an image", error);
    }
  }

  async openInline(nodeId: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const generation = ++this.inlineGeneration;
    try {
      const node = await document.getNode(nodeId);
      if (this.host.isDisposed() || generation !== this.inlineGeneration || !node) return;
      if (node.kind !== "text") {
        this.openComposer(nodeId);
        return;
      }
      this.closeComposer();
      this.inlineText.set(node.body);
      this.inlineId.set(nodeId);
    } catch (error) {
      console.error("Flow could not open the text editor", error);
    }
  }

  async commitBody(nodeId: string, text: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    try {
      const current = await document.getNode(nodeId);
      if (!current || current.body === text) {
        if (this.inlineId() === nodeId) this.closeInline();
        return;
      }
      const batch: ResultBatchInput = {
        id: `batch-${crypto.randomUUID()}`,
        nodeId,
        trigger: "manual",
        provider: "manual",
        model: "",
        paramsJson: "{}",
        status: "done",
      };
      const item: ResultItemInput = {
        id: `item-${crypto.randomUUID()}`,
        position: 0,
        portId: "text",
        kind: "text",
        text,
      };
      const changes = await document.setManualText(nodeId, text, batch, item);
      if (this.host.isDisposed()) return;
      this.host.applyChanges(changes);
      if (this.inlineId() === nodeId) this.closeInline();
    } catch (error) {
      console.error("Flow could not save the text", error);
    }
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

  /** Connects one or more pairs in one write; duplicates and bad pairs skip. */
  async connectNodes(pairs: readonly ConnectionPair[]): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || this.host.isDisposed()) return;
    const valid: ConnectionPair[] = [];
    for (const pair of pairs) {
      if (pair.fromId === pair.toId) continue;
      const fromKind = scene.kindOf(pair.fromId);
      const toKind = scene.kindOf(pair.toId);
      if (!fromKind || !toKind) continue;
      if (!canConnectPorts(fromKind, pair.fromPort, toKind, pair.toPort)) continue;
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
    const fromKind = scene.kindOf(pair.fromId);
    const toKind = scene.kindOf(pair.toId);
    if (!fromKind || !toKind) return;
    if (!canConnectPorts(fromKind, pair.fromPort, toKind, pair.toPort)) return;
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

  private async loadComposer(id: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const generation = ++this.generation;
    try {
      const detail = await this.nodeDetail(id);
      if (this.host.isDisposed() || generation !== this.generation || this.composerId() !== id) {
        return;
      }
      if (!detail) {
        this.closeComposer();
        return;
      }
      this.detail.set(detail);
      this.running.set(this.host.runner()?.isRunning(id) ?? false);
      // Cache URLs even after a newer load superseded this one: an asset
      // that resolves late must still notify the composer's readers.
      await this.ensureAssets(detail);
    } catch (error) {
      console.error("Flow could not read the node detail", error);
    }
  }

  /** Loads the detail's asset URLs, returning whether any URL was new. */
  private async ensureAssets(detail: NodeDetail): Promise<boolean> {
    const assets = this.host.assets();
    if (!assets) return false;
    const wanted = new Map<string, string>();
    const collect = (id: string | null | undefined, mime: string | null | undefined): void => {
      if (id && mime) wanted.set(id, mime);
    };
    for (const item of detail.batch?.items ?? []) collect(item.assetId, item.asset?.mime);
    for (const input of detail.inputs) {
      collect(input.assetId, input.asset?.mime);
      collect(input.item?.assetId, input.item?.asset?.mime);
    }
    let inserted = false;
    await Promise.all(
      [...wanted].map(async ([id, mime]) => {
        const previous = assets.get(id);
        const url = await assets.url(id, mime);
        if (url && previous === null && this.noteAssetUrl(id)) inserted = true;
      }),
    );
    return inserted;
  }

  /** Announces a URL this session has not announced yet. */
  private noteAssetUrl(id: string): boolean {
    if (this.announced.has(id)) return false;
    this.announced.add(id);
    this.assetVersion.update((value) => value + 1);
    return true;
  }
}

/** The asset IDs a detail's composer shows, matching `ensureAssets`. */
function assetIds(detail: NodeDetail): Set<string> {
  const ids = new Set<string>();
  for (const item of detail.batch?.items ?? []) {
    if (item.assetId) ids.add(item.assetId);
  }
  for (const input of detail.inputs) {
    if (input.assetId) ids.add(input.assetId);
    if (input.item?.assetId) ids.add(input.item.assetId);
  }
  return ids;
}

/**
 * Whether an incoming summary differs from the open detail's node only in
 * the fields the composer does not render: its card bounds. Identical
 * summaries skip too. Every other field, including z and rev, is content.
 */
function canSkipDetailReload(current: NodeSummary, incoming: NodeSummary): boolean {
  const sameContent =
    current.id === incoming.id &&
    current.kind === incoming.kind &&
    current.title === incoming.title &&
    current.body === incoming.body &&
    current.z === incoming.z &&
    current.rev === incoming.rev &&
    current.dataJson === incoming.dataJson &&
    current.settingsJson === incoming.settingsJson &&
    current.status === incoming.status &&
    (current.outputBatchId ?? null) === (incoming.outputBatchId ?? null);
  return sameContent;
}
