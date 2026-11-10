import { expect, test } from "nsh/test";
import type { Document } from "@flow/native";
import { AssetUrls } from "./asset-urls";

/** The asset bytes reader AssetUrls owns; a test controls its answers. */
class FakeDocument {
  reads = 0;

  constructor(private readonly readBytes: (id: string) => Promise<Uint8Array>) {}

  async assetBytes(id: string): Promise<Uint8Array> {
    this.reads += 1;
    return this.readBytes(id);
  }
}

/** The test-only platform double: AssetUrls reads only an asset's bytes. */
function assetsOf(fake: FakeDocument): AssetUrls {
  return new AssetUrls(fake as unknown as Document);
}

const PNG = Uint8Array.from([137, 80, 78, 71]);

test("concurrent reads share one cached blob URL and one byte read", async () => {
  const fake = new FakeDocument(async () => PNG);
  const assets = assetsOf(fake);

  const first = assets.url("asset", "image/png");
  const second = assets.url("asset", "image/png");
  const url = await first;
  if (url === null) throw new Error("the asset did not produce a URL");

  expect(await second).toBe(url);
  expect(new URL(url).protocol).toBe("blob:");
  expect(fake.reads).toBe(1);

  assets.dispose();
});

test("the synchronous cache read is empty until a blob URL arrives", async () => {
  const fake = new FakeDocument(async () => PNG);
  const assets = assetsOf(fake);

  expect(assets.get("asset")).toBeNull();
  const url = await assets.url("asset", "image/png");
  expect(assets.get("asset")).toBe(url);
  expect(assets.get("asset")?.startsWith("blob:")).toBe(true);
  expect(assets.get("asset")?.startsWith("data:")).toBe(false);

  assets.dispose();
});

test("disposal revokes its URLs, is idempotent and stops future reads", async () => {
  const fake = new FakeDocument(async () => PNG);
  const assets = assetsOf(fake);
  const url = await assets.url("asset", "image/png");
  if (url === null) throw new Error("the asset did not produce a URL");

  assets.dispose();
  assets.dispose();
  expect(assets.get("asset")).toBeNull();
  expect(await assets.url("asset", "image/png")).toBeNull();
  expect(fake.reads).toBe(1);

  await fetch(url).then(
    () => {
      throw new Error("revoked URL still resolved");
    },
    () => undefined,
  );
});

test("empty asset bytes publish no URL", async () => {
  const fake = new FakeDocument(async () => new Uint8Array());
  const assets = assetsOf(fake);

  expect(await assets.url("empty", "image/png")).toBeNull();
  expect(assets.get("empty")).toBeNull();

  assets.dispose();
});

test("failed asset bytes return null and a later read can still cache", async () => {
  let fail = true;
  const fake = new FakeDocument(async () => {
    if (fail) throw new Error("the asset is unreadable");
    return PNG;
  });
  const assets = assetsOf(fake);

  expect(await assets.url("asset", "image/png")).toBeNull();
  expect(assets.get("asset")).toBeNull();

  fail = false;
  const url = await assets.url("asset", "image/png");
  expect(url).not.toBeNull();
  expect(assets.get("asset")).toBe(url);
  expect(fake.reads).toBe(2);

  assets.dispose();
});

test("disposal while a read is pending drops its bytes without publishing", async () => {
  let deliver: (bytes: Uint8Array) => void = () => {
    throw new Error("the byte read did not start");
  };
  const fake = new FakeDocument(
    () =>
      new Promise<Uint8Array>((resolve) => {
        deliver = resolve;
      }),
  );
  const assets = assetsOf(fake);

  const pending = assets.url("asset", "image/png");
  expect(fake.reads).toBe(1);

  assets.dispose();
  deliver(PNG);
  expect(await pending).toBeNull();
  expect(assets.get("asset")).toBeNull();
  expect(await assets.url("asset", "image/png")).toBeNull();
  expect(fake.reads).toBe(1);
});
