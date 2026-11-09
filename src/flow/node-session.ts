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
  NodeDetail,
  NodeInput,
  ResultBatchInput,
  ResultItemInput,
} from "@flow/native";
import type { AssetUrls } from "./asset-urls";
import type { NodeRunner } from "./execution";
import {
  canConnect,
  defaultSettings,
  type NodeKindId,
  type NodeSettings,
  nodeKind,
  serializeSettings,
} from "./node-kinds";
import type { FlowScene } from "./scene";

export interface NodeSessionHost {
  document(): Document | null;
  scene(): FlowScene | null;
  assets(): AssetUrls | null;
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

  private readonly urls = new Map<string, string>();
  private generation = 0;
  private inlineGeneration = 0;

  constructor(private readonly host: NodeSessionHost) {}

  /** Reloads a composer whose node a command changed. */
  onChanges(changes: ChangeSet): void {
    const id = this.composerId();
    if (id !== null) {
      // A removed node has no detail to reload; close before the page's
      // selection effect tries to save drafts back into a deleted row.
      if (changes.removed.includes(id)) this.closeComposer();
      else if (changes.changed.some((node) => node.id === id)) void this.loadComposer(id);
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
    return Object.fromEntries(this.urls);
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

  async connectNodes(fromId: string, toId: string): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || fromId === toId || this.host.isDisposed()) return;
    const fromKind = scene.kindOf(fromId);
    const toKind = scene.kindOf(toId);
    if (!fromKind || !toKind || !canConnect(fromKind, toKind)) return;
    try {
      const changes = await document.connectEdge({
        id: `edge-${crypto.randomUUID()}`,
        fromId,
        toId,
        fromPort: "out",
        toPort: "in",
        kind: "flow",
      });
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

  async reconnectEdge(edgeId: string, fromId: string, toId: string): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || fromId === toId || this.host.isDisposed()) return;
    const fromKind = scene.kindOf(fromId);
    const toKind = scene.kindOf(toId);
    if (!fromKind || !toKind || !canConnect(fromKind, toKind)) return;
    try {
      const changes = await document.updateEdge({
        id: edgeId,
        fromId,
        toId,
        fromPort: "out",
        toPort: "in",
        kind: "flow",
      });
      if (!this.host.isDisposed()) this.host.applyChanges(changes);
      this.host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not reconnect the nodes", error);
    }
  }

  private async loadComposer(id: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const generation = ++this.generation;
    try {
      const detail = await document.nodeDetail(id);
      if (this.host.isDisposed() || generation !== this.generation || this.composerId() !== id) {
        return;
      }
      if (!detail) {
        this.closeComposer();
        return;
      }
      this.detail.set(detail);
      this.running.set(this.host.runner()?.isRunning(id) ?? false);
      await this.ensureAssets(detail);
      if (generation !== this.generation) return;
      this.assetVersion.update((value) => value + 1);
    } catch (error) {
      console.error("Flow could not read the node detail", error);
    }
  }

  private async ensureAssets(detail: NodeDetail): Promise<void> {
    const assets = this.host.assets();
    if (!assets) return;
    const wanted = new Map<string, string>();
    const collect = (id: string | null | undefined, mime: string | null | undefined): void => {
      if (id && mime) wanted.set(id, mime);
    };
    for (const item of detail.batch?.items ?? []) collect(item.assetId, item.asset?.mime);
    for (const input of detail.inputs) {
      collect(input.assetId, input.asset?.mime);
      collect(input.item?.assetId, input.item?.asset?.mime);
    }
    await Promise.all(
      [...wanted].map(async ([id, mime]) => {
        const url = await assets.url(id, mime);
        if (url) this.urls.set(id, url);
      }),
    );
  }
}
