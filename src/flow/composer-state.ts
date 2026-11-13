/**
 * The composer's drafts: the settings and body the native panel edits before
 * they are written. The page owns one per open composer and saves it on close,
 * run or an explicit body save.
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
  commitBody(nodeId: string, text: string): Promise<void>;
}

export class ComposerState {
  readonly settings = signal<NodeSettings | null>(null);
  readonly body = signal("");
  private nodeId: string | null = null;
  /** The last document values the drafts came from, to detect user edits. */
  private syncedSettings: string | null = null;
  private syncedBody: string | null = null;

  /** Loads the drafts, adopting document changes the user has not edited. */
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
      this.body.set(detail.node.body);
    } else {
      // A run, undo or another command can rewrite the node while the
      // composer is open; adopt that value only when the user has not
      // diverged from what was last loaded. The drafts are read untracked so
      // the page's sync effect depends on the document detail alone, never on
      // the values this method writes.
      untracked(() => {
        const current = this.settings();
        const currentJson = current === null ? null : serializeSettings(current);
        if (currentJson === null || currentJson === this.syncedSettings) {
          if (currentJson !== settingsJson) this.settings.set(settings);
        }
        if (this.body() === this.syncedBody && this.body() !== detail.node.body) {
          this.body.set(detail.node.body);
        }
      });
    }
    this.syncedSettings = settingsJson;
    this.syncedBody = detail.node.body;
  }

  reset(): void {
    this.nodeId = null;
    this.syncedSettings = null;
    this.syncedBody = null;
    this.settings.set(null);
    this.body.set("");
  }

  prompt(): string {
    const settings = this.settings();
    return settings !== null && "prompt" in settings ? settings.prompt : "";
  }

  setPrompt(prompt: string): void {
    const settings = this.settings();
    if (settings !== null && "prompt" in settings) this.settings.set({ ...settings, prompt });
  }

  setBody(body: string): void {
    this.body.set(body);
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

  /** Writes the drafts; the body only when it changed. */
  save(session: ComposerSaver | null, detail: NodeDetail | null): void {
    if (session === null || detail === null) return;
    const settings = this.settings();
    if (settings !== null) void session.saveSettings(detail.node.id, settings);
    if (this.body() !== detail.node.body) {
      void session.commitBody(detail.node.id, this.body());
    }
  }

  /** The current drafts, for a command that must snapshot them first. */
  drafts(): { settings: NodeSettings | null; body: string } {
    return { settings: this.settings(), body: this.body() };
  }
}
