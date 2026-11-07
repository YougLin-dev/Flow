import { isRecord } from "./values";

/** The URL of a drawable image (a string, or an object with `url`/`src`). */
export function imageSource(image: unknown): string | null {
  if (!image) return null;
  if (typeof image === "string") return image;
  if (isRecord(image)) {
    if (typeof image.url === "string") return image.url;
    if (typeof image.src === "string") return image.src;
  }
  return null;
}

/** The density an asset's file name names (`logo@2x.png` is 2), else 1. */
export function assetScale(url: string): number {
  const match = /@(\d+(?:\.\d+)?)x\.[a-z0-9]+(?:[?#]|$)/i.exec(url);
  return match ? Number(match[1]) || 1 : 1;
}
