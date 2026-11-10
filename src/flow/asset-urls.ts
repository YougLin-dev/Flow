/**
 * Asset bytes to a URL NSH's `<Image>` can show. NSH resolves a `blob:` URL
 * into shared native image bytes once per URL, so this cache creates one
 * blob per asset and owns its revocation until the page is disposed.
 */
import type { Document } from "@flow/native";

export class AssetUrls {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private disposed = false;

  constructor(private readonly document: Document) {}

  /** The URL if it is already loaded. */
  get(assetId: string): string | null {
    return this.urls.get(assetId) ?? null;
  }

  /** Loads an asset's bytes and returns a URL (or null when it cannot show). */
  async url(assetId: string, mime: string): Promise<string | null> {
    const cached = this.urls.get(assetId);
    if (cached) return cached;
    const running = this.pending.get(assetId);
    if (running) return running;
    if (this.disposed) return null;

    const loading = this.load(assetId, mime).finally(() => {
      this.pending.delete(assetId);
    });
    this.pending.set(assetId, loading);
    return loading;
  }

  /** Revokes the URLs this cache still owns; safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private async load(assetId: string, mime: string): Promise<string | null> {
    try {
      const bytes = await this.document.assetBytes(assetId);
      if (this.disposed || bytes.length === 0) return null;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (this.disposed) {
        URL.revokeObjectURL(url);
        return null;
      }
      this.urls.set(assetId, url);
      return url;
    } catch (error) {
      // A read in flight when the page closes rejects because the document
      // is gone; that is not a failure worth reporting.
      if (!this.disposed) console.error("Flow could not load an asset", error);
      return null;
    }
  }
}
