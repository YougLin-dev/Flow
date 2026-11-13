/**
 * The composer's settings draft: the values the native panel edits before
 * they are written. The page owns one per open composer and saves it on
 * close or run. A text card's body is not a composer draft: the card edits
 * it in place (`InlineTextEditor`), so the composer only holds the prompt and
 * the image settings.
 */
import { signal, untracked } from "nsh";
import type { NodeDetail } from "@flow/native";
import {
  type ImageAspect,
  parseSettings,
  type NodeSettings,
  serializeSettings,
} from "./node-kinds";

/** The writes the composer drafts make; `NodeSession` implements it. */
export interface ComposerSaver {
  saveSettings(nodeId: string, settings: NodeSettings): Promise<void>;
}

export class ComposerState {
  readonly settings = signal<NodeSettings | null>(null);
  private nodeId: string | null = null;
  /** The last document values the drafts came from, to detect user edits. */
  private syncedSettings: string | null = null;

  /** Loads the draft, adopting document changes the user has not edited. */
  sync(detail: NodeDetail | null): void {
    if (detail === null) {
      this.reset();
      return;
    }
    const settings = parseSettings(detail.node.kind, detail.node.settingsJson);
    const settingsJson = serializeSettings(settings);
    if (this.nodeId !== detail.node.id) {
      this.nodeId = detail.node.id;
      this.settings.set(settings);
    } else {
      // A run, undo or another command can rewrite the node while the
      // composer is open; adopt that value only when the user has not
      // diverged from what was last loaded. The draft is read untracked so
      // the page's sync effect depends on the document detail alone, never on
      // the values this method writes.
      untracked(() => {
        const current = this.settings();
        const currentJson = current === null ? null : serializeSettings(current);
        if (currentJson === null || currentJson === this.syncedSettings) {
          if (currentJson !== settingsJson) this.settings.set(settings);
        }
      });
    }
    this.syncedSettings = settingsJson;
  }

  reset(): void {
    this.nodeId = null;
    this.syncedSettings = null;
    this.settings.set(null);
  }

  prompt(): string {
    const settings = this.settings();
    return settings !== null && "prompt" in settings ? settings.prompt : "";
  }

  setPrompt(prompt: string): void {
    const settings = this.settings();
    if (settings !== null && "prompt" in settings) this.settings.set({ ...settings, prompt });
  }

  aspect(): ImageAspect {
    const settings = this.settings();
    return settings !== null && settings.version === 1 && "aspect" in settings
      ? settings.aspect
      : "1:1";
  }

  count(): number {
    const settings = this.settings();
    return settings !== null && settings.version === 1 && "count" in settings ? settings.count : 1;
  }

  setAspect(aspect: ImageAspect): void {
    const settings = this.settings();
    if (settings !== null && settings.version === 1 && "aspect" in settings) {
      this.settings.set({ ...settings, aspect });
    }
  }

  setCount(delta: number): void {
    const settings = this.settings();
    if (settings !== null && settings.version === 1 && "count" in settings) {
      this.settings.set({
        ...settings,
        count: Math.min(4, Math.max(1, settings.count + delta)),
      });
    }
  }

  /** Writes the draft. */
  save(session: ComposerSaver | null, detail: NodeDetail | null): void {
    if (session === null || detail === null) return;
    const settings = this.settings();
    if (settings !== null) void session.saveSettings(detail.node.id, settings);
  }
}
