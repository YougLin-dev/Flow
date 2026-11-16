/**
 * The composer's document-side session: the open card's detail and asset URL
 * cache, saving settings and the mock run. It owns the small piece of UI state
 * the composer renders; `NodeSession` wires it to the page.
 */
import { signal } from "nsh";
import type { ChangeSet, Document, NodeDetail } from "../../shared";
import { canSkipDetailReload, detailAssetIds } from "./composer-detail";
import type { NodeRunner } from "../../execution";
import {
  isKnownKind,
  isRunnableKind,
  portsOfNode,
  serializeSettings,
  type NodeKindId,
  type NodeSettings,
} from "../../nodes";

/** The asset URL cache the composer reads; `AssetUrls` implements it. */
export interface AssetUrlSource {
  url(id: string, mime: string): Promise<string | null>;
  get(id: string): string | null;
}

export interface ComposerHost {
  document(): Document | null;
  assets(): AssetUrlSource | null;
  runner(): NodeRunner | null;
  applyChanges(changes: ChangeSet): void;
  isDisposed(): boolean;
  /** The detail read; `NodeSession` keeps the protected test hook. */
  nodeDetail(id: string): Promise<NodeDetail | null>;
}

/** The kind a settings draft belongs to when no open detail names it. */
function settingsKind(settings: NodeSettings): NodeKindId {
  if ("media" in settings) return "upload";
  if ("count" in settings) return "image";
  return "text";
}

export class ComposerSession {
  readonly id = signal<string | null>(null);
  readonly detail = signal<NodeDetail | null>(null);
  readonly running = signal(false);
  readonly assetVersion = signal(0);

  private readonly announced = new Set<string>();
  private generation = 0;

  constructor(private readonly host: ComposerHost) {}

  /**
   * Reloads the composer whose node a command changed. A summary that differs
   * only in x, y, width or height keeps the loaded detail: the composer
   * renders content, not card geometry. Content fields and revisions always
   * reload, and so does every connector change: a connection feeds the
   * composer's inputs, and a removed edge has already left the scene, so its
   * endpoints cannot be matched to decide whether it touched this card.
   */
  noteChanges(changes: ChangeSet): void {
    const id = this.id();
    if (id === null) return;
    // A removed node has no detail to reload; close before the page's
    // selection effect tries to save drafts back into a deleted row.
    if (changes.removed.includes(id)) {
      this.close();
      return;
    }
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
    if (reload) void this.load(id);
  }

  onSettled(nodeId: string): void {
    if (this.id() !== nodeId) return;
    this.running.set(this.host.runner()?.isRunning(nodeId) ?? false);
    void this.load(nodeId);
  }

  open(id: string): void {
    if (this.id() === id && this.detail()) return;
    this.id.set(id);
    this.detail.set(null);
    this.running.set(this.host.runner()?.isRunning(id) ?? false);
    void this.load(id);
  }

  close(): void {
    this.generation += 1;
    this.id.set(null);
    this.detail.set(null);
    this.running.set(false);
  }

  /** Asset URLs for the composer's current images. */
  assetUrls(): Record<string, string> {
    this.assetVersion();
    const detail = this.detail();
    const assets = this.host.assets();
    if (detail === null || assets === null) return {};
    const entries: Array<readonly [string, string]> = [];
    for (const id of detailAssetIds(detail)) {
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
    const kind = current?.node.id === id ? current.node.kind : settingsKind(settings);
    // A kind this build does not know keeps its edges: the fallback port
    // schema is a reading aid, not an authoritative list of the node's ports.
    const ports = isKnownKind(kind) ? portsOfNode({ kind, settingsJson: json }) : null;
    const validPorts =
      ports === null
        ? null
        : [...new Set([...ports.inputs, ...ports.outputs].map((port) => port.id))];
    try {
      const changes = await document.setNodeSettings(id, json, validPorts);
      if (!this.host.isDisposed()) this.host.applyChanges(changes);
    } catch (error) {
      console.error("Flow could not save the node settings", error);
    }
  }

  async run(settings: NodeSettings): Promise<void> {
    const detail = this.detail();
    const id = this.id();
    const runner = this.host.runner();
    if (!detail || !id || !runner || this.running()) return;
    if (!isRunnableKind(detail.node.kind)) return;
    this.running.set(true);
    await this.saveSettings(id, settings);
    if (this.host.isDisposed()) return;
    await runner.run(detail, settings);
  }

  cancel(): void {
    const id = this.id();
    if (id) this.host.runner()?.cancel(id);
  }

  private async load(id: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const generation = ++this.generation;
    try {
      const detail = await this.host.nodeDetail(id);
      if (this.host.isDisposed() || generation !== this.generation || this.id() !== id) {
        return;
      }
      if (!detail) {
        this.close();
        return;
      }
      this.detail.set(detail);
      this.running.set(this.host.runner()?.isRunning(id) ?? false);
      // Cache URLs even after a newer load superseded this one: an asset
      // that resolves late must still notify the composer's readers.
      await this.ensureAssets(detail);
    } catch (error) {
      // A read in flight at quit rejects because the document closed; the
      // composer is gone with it, so only a live session reports the failure.
      if (!this.host.isDisposed()) {
        console.error("Flow could not read the node detail", error);
      }
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
