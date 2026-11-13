/**
 * A text card's in-place body editor: which card is being edited, its draft,
 * and the write that saves it. The session owns one and delegates; the card's
 * input reads `nodeId` and `text`.
 *
 * The editor separates its own write from an edit made under the draft: a
 * run, undo or another writer that replaces the body closes the draft (the
 * new content wins) instead of letting it write back, while the editor's own
 * write landing never closes an editor reopened since it started.
 */
import { signal } from "nsh";
import type { ChangeSet, Document, ResultBatchInput, ResultItemInput } from "@flow/native";

/** What the editor needs from the session and the document. */
export interface InlineEditorHost {
  document(): Document | null;
  isDisposed(): boolean;
  applyChanges(changes: ChangeSet): void;
  /** A non-text card has no body to edit: it opens its composer instead. */
  openComposer(nodeId: string): void;
  closeComposer(): void;
}

export class InlineEditor {
  /** The card whose body the editor shows, or null when closed. */
  readonly nodeId = signal<string | null>(null);
  /** The draft, kept by the session so a remount does not lose it. */
  readonly text = signal("");
  /** The body the draft started from, to tell an external write from a reload. */
  private base = "";
  /** Changes on every close or reopen: a write closes only its own edit. */
  private generation = 0;
  private applyingOwnWrite = false;
  private commitInFlight: Promise<void> | null = null;
  private pendingText: string | null = null;

  constructor(private readonly host: InlineEditorHost) {}

  /** Whether the session is applying this editor's own write. */
  applying(): boolean {
    return this.applyingOwnWrite;
  }

  /** Whether `body` replaces the content the draft was opened on. */
  replaced(body: string): boolean {
    return body !== this.base;
  }

  /** Closes the editor, discarding the draft. */
  close(): void {
    this.generation += 1;
    this.base = "";
    this.nodeId.set(null);
    this.text.set("");
  }

  /** Keeps the draft across a remount. */
  setText(text: string): void {
    this.text.set(text);
  }

  /** Opens `nodeId`'s body; a non-text card opens its composer instead. */
  async open(nodeId: string): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    const generation = ++this.generation;
    try {
      const node = await document.getNode(nodeId);
      if (this.host.isDisposed() || generation !== this.generation || !node) return;
      if (node.kind !== "text") {
        this.host.openComposer(nodeId);
        return;
      }
      this.host.closeComposer();
      this.base = node.body;
      this.text.set(node.body);
      this.nodeId.set(nodeId);
    } catch (error) {
      console.error("Flow could not open the text editor", error);
    }
  }

  /**
   * Writes `text` as the node's body, without touching the editor's state.
   * The write is one undoable manual text item. `own` marks the draft's own
   * write: its change set applies as `applying`, so an editor reopened while
   * it was in flight stays open. Returns whether the body now holds `text`;
   * a failed write returns false.
   */
  async write(nodeId: string, text: string, own = false): Promise<boolean> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return false;
    try {
      const current = await document.getNode(nodeId);
      if (!current) return false;
      if (current.body === text) return true;
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
      if (this.host.isDisposed()) return false;
      this.applyingOwnWrite = own;
      try {
        this.host.applyChanges(changes);
      } finally {
        this.applyingOwnWrite = false;
      }
      return true;
    } catch (error) {
      console.error("Flow could not save the text", error);
      return false;
    }
  }

  /**
   * Writes the draft and closes it once the write lands. Blur and a press on
   * the canvas can both ask for this within one gesture: the second ask waits
   * for the first write instead of inserting a duplicate manual batch, and a
   * newer draft waits behind an older write so the two bodies land in the
   * order they were typed. The editor stays open (and keeps the draft) while
   * the write is in flight or if it fails.
   */
  commit(): Promise<void> {
    const id = this.nodeId();
    if (id === null) return Promise.resolve();
    const text = this.text();
    // The same draft is already being written: wait for that write.
    if (this.commitInFlight !== null && this.pendingText === text) return this.commitInFlight;
    const generation = this.generation;
    const prior = this.commitInFlight ?? Promise.resolve();
    const write = prior
      .then(() => this.write(id, text, true))
      .then((written) => {
        // Only the edit this write started closes, and only once its body
        // landed: an editor reopened since has its own draft, and a failed
        // write keeps this one open with what the user typed.
        if (!written) return;
        if (this.nodeId() === id && this.text() === text && generation === this.generation) {
          this.close();
        }
      })
      .finally(() => {
        if (this.commitInFlight === write) {
          this.commitInFlight = null;
          this.pendingText = null;
        }
      });
    this.commitInFlight = write;
    this.pendingText = text;
    return write;
  }
}
