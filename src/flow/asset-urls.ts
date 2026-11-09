/**
 * Asset bytes to a URL NSH's `<Image>` can show. NSH's image
 * loader does not read `blob:` URLs (it waits for them forever), so assets
 * become `data:` URLs, which it decodes on every platform.
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

  /** Drops the decoded URL cache. */
  dispose(): void {
    this.disposed = true;
    this.urls.clear();
  }

  private async load(assetId: string, mime: string): Promise<string | null> {
    try {
      const bytes = await this.document.assetBytes(assetId);
      if (this.disposed || bytes.length === 0) return null;
      const url = `data:${mime};base64,${base64(bytes)}`;
      if (this.disposed) return null;
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

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x1000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
