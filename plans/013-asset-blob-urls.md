# Plan 013: Show asset images through blob URLs instead of base64 data URLs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/flow/asset-urls.ts src/flow/asset-urls.test.ts src/flow/node-session.ts src/flow/node-session.native.test.ts src/flow/node-session-detail.native.test.ts src/components/FlowCard.tsx src/components/FlowCanvas.tsx src/pages/FlowPage.tsx src/App.test.tsx src/App.host.test.tsx CHANGELOG.md plans/README.md`
> `plans/README.md` is maintained by the advisor; the executor only updates
> this plan's status row when the advisor explicitly delegates index editing.
> This plan depends on `plans/006-composer-stays-mounted.md`, whose changes to
> `node-session.ts` and its tests are expected. Confirm that dependency's row
> is DONE in `plans/README.md`; then compare only the excerpts this plan edits.
> A mismatch NOT explained by that dependency is a STOP condition. Never edit
> generated `src/.nsh/` files. Do not switch or reset the current worktree if
> an isolated branch was supplied to you; otherwise follow the Git workflow
> below.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/006-composer-stays-mounted.md`
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `300227c`, 2026-11-11 — plan 006 landed. The
  `assetVersion`/`cacheUrl` seams and the one-notification-per-asset contract
  now live in `node-session-detail.native.test.ts`; `asset-urls.ts` is still
  the base64 implementation quoted below; the `App`/host-test line references
  and the `FlowCard` image seam are updated.
- **Executed at**: commit `4f2b23b`, 2026-11-11. Deviations recorded: the
  host test tells headless from Windows by whether `app.screenshot()` resolves
  (headless also renders `id:title-bar` under `platform: "windows"`); the
  `ImageLoadProbe` input and `imageProbeText` live in `FlowCard.tsx` because
  `FlowPage.tsx` exceeded the 500-code-line cap; an image-composer reopen test
  was added because no existing App case covered it; optional event props are
  typed `| undefined` for `exactOptionalPropertyTypes`.

## Why this matters

Building a 1 MB asset's base64 data URL takes 64–70 ms in QuickJS. The pinned
NSH core then decodes and hashes that string for every `<Image>` mount
(8–9.6 ms/MB release, 42 ms/MB debug); eight 1 MB mounts measured 75–80 ms of
commit work, versus 0.07–0.5 ms with `blob:` URLs. Blob creation itself was
0.6 ms versus 64–70 ms in the advisor's probes at this revision. Replace the
obsolete data-URL workaround without invalidating already-mounted images.

## Current state

- `src/flow/asset-urls.ts` — owns asset-byte loading, caching and disposal.
- `src/flow/node-session.ts` — owns composer detail, loads its assets and
  exposes a record to `NodeComposer`.
- `src/flow/node-session.native.test.ts` — existing native-session fixtures.
- `src/flow/node-session-detail.native.test.ts` — plan 006's detail/asset
  notification fixtures, including the one-notification-per-asset contract
  this plan must preserve (`:439-523`).
- `src/App.test.tsx` — headless image-node/composer coverage and a callback
  observability contract used only to prove the real host's `onLoad`.
- `src/App.host.test.tsx` — the actual Windows image-decoding regression;
  `scripts/test-host.mjs:48-53` invokes it with `--target windows`.
- `CHANGELOG.md` — `## [Unreleased]` followed by `### Changed` at line 71.

The cache currently keeps base64 strings for the whole page session. Its
header claims the opposite of the now-pinned NSH behavior:

```ts
// src/flow/asset-urls.ts:1-5 (at 1956ebb)
/**
 * Asset bytes to a URL NSH's `<Image>` can show. NSH's image
 * loader does not read `blob:` URLs (it waits for them forever), so assets
 * become `data:` URLs, which it decodes on every platform.
 */
```

```ts
// src/flow/asset-urls.ts:41-48 (at 1956ebb)
private async load(assetId: string, mime: string): Promise<string | null> {
  try {
    const bytes = await this.document.assetBytes(assetId);
    if (this.disposed || bytes.length === 0) return null;
    const url = `data:${mime};base64,${base64(bytes)}`;
    if (this.disposed) return null;
    this.urls.set(assetId, url);
    return url;
```

Plan 006 landed `assetVersion`/`cacheUrl` and split the composer's detail
tests into `src/flow/node-session-detail.native.test.ts`. The seams this plan
touches are still the duplicate map and `ensureAssets`:

```ts
// src/flow/node-session.ts:57, 131-135, 427-456 (at 300227c)
private readonly urls = new Map<string, string>();

assetUrls(): Record<string, string> {
  this.assetVersion();
  return Object.fromEntries(this.urls);
}

private async ensureAssets(detail: NodeDetail): Promise<boolean> {
  // ... collect wanted ids/mimes from the batch and inputs ...
  let inserted = false;
  await Promise.all(
    [...wanted].map(async ([id, mime]) => {
      const url = await assets.url(id, mime);
      if (url && this.cacheUrl(id, url)) inserted = true;
    }),
  );
  return inserted;
}

private cacheUrl(id: string, url: string): boolean {
  if (this.urls.has(id)) return false;
  this.urls.set(id, url);
  this.assetVersion.update((value) => value + 1);
  return true;
}
```

`src/flow/node-session-detail.native.test.ts:439-523` ("an asset URL that
resolves after a reload notifies once") pins the notification contract: two
overlapping `ensureAssets` calls awaiting the same pending asset URL must
increment `assetVersion` exactly once, and a later load served from the cache
must not increment it again. That file must pass unmodified.

At `src/flow/node-session.native.test.ts:27-56`, `makeSession()` constructs
`AssetUrls` and exposes it through `assets()`. Its image test "runs the mock
image provider and stores an immutable batch" (lines 58-85) awaits
`Object.keys(session.assetUrls()).length > 0` at lines 76-77 and disposes the
runner, assets and document at lines 82-84. Reuse that lifecycle pattern.
`src/App.test.tsx:328-340` ("removes an input from the composer") is the
existing image-composer flow; there is no separate text-to-image switch test.
These are reactive wiring tests, not pixel assertions.

Preserved generated types already prove the API signatures:

```ts
// src/.nsh/types/nsh/globals.d.ts:287-288, 320-328
static createObjectURL(blob: Blob): string;
static revokeObjectURL(url: string): void;

declare class Blob {
  constructor(blobParts?: Iterable<BlobPart>, options?: BlobPropertyBag);
  readonly size: number;
  readonly type: string;
  slice(start?: number, end?: number, contentType?: string): Blob;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
```

`src/.nsh/types/nsh/types.d.ts:941-958` declares `ImageHostProps` with
`onLoad?: (e: { size: PixelSize }) => void`, `onError?: (e: { message:
string; code?: string }) => void` and `onLoadEnd?: () => void`. The
`standard/` declarations do not contain URL/Blob directly; `globals.d.ts:6`
references them and supplies the declarations above.

At NSH pin `f0b4659`, `nsh-js/src/web/blob.rs:377-408` resolves a `blob:`
source into shared native image bytes, memoized once per URL. Its
`create_object_url` and `revoke_object_url` functions are at lines 410–429.
A mounted image retains resolved bytes after revocation; a _new_ mount of a
revoked URL fails. This is why `AssetUrls`, not `NodeSession`, must be the
only owner and why disposal must remain page-scoped.

**Headless image limitation**: pinned NSH explicitly says at
`E:\code\mine\nsh-pr\crates\nsh-testing\src\headless\mod.rs:292-298`:
"Images are not loaded: no `onLoad` comes, and `Image.getSize` /
`Image.prefetch` fail." NodeComposer / FlowCard mounted-text tests and the
existing App cases pass on headless without an `onLoad` callback, so they
verify only reactive URL/string wiring and preserved content. They cannot
verify decoding, PNG/SVG support, callback firing or revocation-vs-mount
lifetime. Only the Windows desktop probe and the new App host test below can
prove that part of this migration. Do not make a headless `Image.onLoad` test
`todo`/`skip` or a source-only assertion masquerade as proof.

The host test's observation mechanism is test-side text, not a host-handler
spy: `test.d.ts:327-328` says `host.handlers` is unsupported with `--target`,
and `scripts/test-host.mjs` always supplies that target. Test Input values
remain readable via `app.value("id:<testID>")` on the actual native host
(`test.d.ts:380-385`). Therefore an `onLoad` callback can update a
test-provided input's text through the page's ordinary test-only display;
`app.waitFor` on a stable exposed waypoint is also legitimate. Never invent
`app.host.events()` or depend on `host.posts()`, which records only the
embedding handlers registered at test-open, not the app's arbitrary native
callbacks.

Repository constraints, quoted for this change:

- Tests use `app.waitUntil` when mounted and ordinary awaited/polled native
  assertions in headless-only native tests. From standards §9: "Each test
  MUST cover one behavior and be named for the user action or invariant."
- From standards §7.3: "Async work MUST drop its result after disposal" and
  "Cleanup MUST be idempotent." Existing `AssetUrls` implements the first;
  step 3 must add the second.

## Commands you will need

| Purpose                       | Command                                                                                  | Expected on success                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Probe Windows only            | `nsh test App.test.tsx --filter "blob image" --target windows`, from the probe directory | PNG and SVG both reach real-host `onLoad`, neither reaches `onError` |
| Host image regression         | `bun run test:host -- --filter "loads a blob image through the asset cache"`             | exits 0 after the actual AssetUrls-backed `onLoad`; no `onError`     |
| Headless observation contract | `nsh test src/App.test.tsx --filter "publishes image load"`                              | exits 0; the host event is read but never claims decoding            |
| Typecheck                     | `nsh check src`                                                                          | exit 0, no errors                                                    |
| Asset unit tests              | `nsh test src/flow/asset-urls.test.ts`                                                   | all asset-cache tests pass                                           |
| Node-session tests            | `nsh test src/flow/node-session.native.test.ts`                                          | all existing/new tests pass                                          |
| Plan 006 asset contract       | `nsh test src/flow/node-session-detail.native.test.ts`                                   | all pass, file unmodified                                            |
| Mounted coverage              | `nsh test src/App.test.tsx --filter "composer"`                                          | matching app tests pass                                              |
| Real host coverage            | `bun run test:host`                                                                      | all `*.host.test.tsx` tests pass                                     |
| Format changed paths          | `./node_modules/.bin/vp fmt --check <changed paths>`                                     | all matched files use the correct format                             |
| Full gate                     | `bun run check` and `bun run test`                                                       | exit 0, all tests pass                                               |

## Scope

**In scope** (the only files you should modify):

- `src/flow/asset-urls.ts`
- `src/flow/asset-urls.test.ts` (create)
- `src/flow/node-session.ts`
- `src/flow/node-session.native.test.ts`
- `src/App.test.tsx` (existing image/composer flows and the explicit headless
  observation-contract below)
- `src/App.host.test.tsx` (real Windows `Image.onLoad` regression;
  never a headless load expectation)
- `src/components/FlowCard.tsx` — wire typed `onLoad`/`onError` observation
  to its existing `<Image>`, with a string-URL report binding for host tests
- `src/components/FlowCanvas.tsx` — forward that optional props reader only
- `src/pages/FlowPage.tsx` — host-parameter-probe status input wiring only
- `CHANGELOG.md` — `### Changed` requires one blob-URL bullet

**Out of scope** (do NOT touch, even though they look related):

- Any file under `src/.nsh/`, including generated declarations.
- `src/flow/previews.ts` and `preview-loader.ts`: both already use
  `assets.url()` and need no URL-policy change.
- `NodeComposer.tsx`: keyed bindings remain Plan 006's work; existing image
  props already use session strings. Scoped FlowCard/FlowCanvas props are
  only the callback observation path explicit below, not a URL source change.
- `FlowPage.tsx`: keep any existing non-probe delegation untouched. Its only
  authorized added behavior is the described status-binding. No generic event
  bus, new `nsh.json` capability, host-message loop or new Image mounting.
- URL eviction/LRU, asset deletion, MIME validation policy, or an NSH upgrade.
- `src/flow/node-session-detail.native.test.ts` — plan 006 owns it; it must
  stay green unmodified. If the new `ensureAssets` shape cannot satisfy it,
  STOP rather than editing the test.
- `plans/README.md` is the only exception to this scope list, for status.

## Git workflow

- Branch: `advisor/013-asset-blob-urls` from `main` with
  `git switch -c advisor/013-asset-blob-urls`.
- Suggested commits: `perf: serve asset images from blob URLs` and, separately,
  `refactor: keep one composer asset URL cache`. Add an explanatory body.
  Match the repository's lower-case imperative Conventional Commits, e.g.
  `perf: keep canvas gestures to one update per moved card` (`1956ebb`).
- Never add AI attribution: no `Co-Authored-By:` trailer naming an AI and no
  "Generated with ..." line. Do not push or open a PR.
- At completion, update this plan's row in `plans/README.md` and run
  `./node_modules/.bin/vp fmt plans/README.md` so table alignment passes check.

## Steps

### Step 1: Verify real image loading for PNG and SVG blobs on Windows

The Windows desktop check is the mandatory prerequisite; headless load is
explicitly impossible at the pinned engine for the source reason quoted
above. Create a disposable TSX app outside the repository at
`C:\Users\Y\AppData\Local\Temp\claude\E--code-mine-oflow\plan-probes\013\`.
Copy `src/nsh.json` and `src/theme.json` as starting points, remove the
`"rust"` entry from the probe's `nsh.json`, and create only `App.tsx` and
`App.test.tsx` there. The probe must not import repository source or native
code. Never leave it under `src/`.

Construct in-memory bytes in the test: a known-valid 1×1 PNG (for example the
standard 67-byte transparent PNG) and an SVG containing a small valid
`<svg ...><rect .../></svg>`. For each, create
`URL.createObjectURL(new Blob([bytes], { type: mime }))` and render an
`<Image src={url} testID={...} onLoad={...} onError={...}/>` with explicit
width/height. Track one `loaded` and one `failed` state per format through
signals; assert with `app.waitUntil` that both load, and assert after load
that no format reported an error. `onLoad` is the required evidence; merely
finding the view or resolving without an error is insufficient. Put both
images in one probe test named `blob image`. Dispose the app-owned blob URLs
at test cleanup only after the load assertions (a mounted image may retain
its bytes, but a future mount must not depend on that).

```sh
# Working directory: the probe directory, not the Flow repository.
nsh test App.test.tsx --filter "blob image" --target windows
```

Record the probe's file path and its Windows outcome in the eventual
completion summary. Headless assertion of `onLoad` is not a Verify or Done
criterion; `nsh test App.test.tsx` without `--target` cannot supply any such
evidence. NSH source inspection alone is not an alternative.

**Verify**: the one Windows command exits 0; both PNG and SVG reach `onLoad`
and neither reaches `onError`. If image decoding fails on Windows, STOP and
report it rather than reintroducing base64. Do not retry headlessly or
convert this to mounted-text, source-only or no-error-so-far assertions.

### Step 2: Introduce owned blob creation/revocation and unit-test its lifecycle

In `src/flow/asset-urls.ts`, replace the synchronous base64 conversion with:

```ts
const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
```

Keep `url(assetId, mime)` returning `Promise<string | null>`, its pending-load
coalescing, and caching by `assetId` (an imported asset is content addressed).
Keep the `disposed` check immediately after `await document.assetBytes` and
after URL construction. In the latter case revoke the just-created URL before
returning `null`, so closing the page while construction completes leaks
nothing. `urls.get()` remains the synchronous read used by `get()`.

Add `src/flow/asset-urls.test.ts` beside the subject. Use the documented test
exception for a typed platform stand-in rather than `any`: a class with
`async assetBytes(id: string): Promise<Uint8Array>` whose `id` is read and
whose byte responses and call counter are controlled per test, cast through
`unknown as Document` once under the test-only platform-double allowance in
standards §5. The imported `Document` is type-only. Model the cast after the
`File` stand-in at `src/flow/node-session.native.test.ts:177-187`; never mock
global `URL`, `Blob`, or `Image` methods in tests.

Test all of these independent cases:

1. Two awaits of `url("asset", "image/png")` return one identical URL whose
   prefix is `blob:`, and the fake document's `assetBytes` runs only once.
   Assert via `new URL(url).protocol === "blob:"`; do not mock global URL.
2. `get("asset")` returns null before loading and the same cached URL after;
   no base64/data scheme is returned.
3. `dispose()` is idempotent and later `url()` returns null without reading.
   Then reject the unresolved URL with the unpinned runtime-independent API
   `await fetch(url).then(() => { throw new Error("revoked URL still resolved"); }, () => undefined);`
   NSH's `revoke_object_url` deletes it from its registry; a previously
   _mounted_ image can still retain its bytes and is not used for this case.
   Call `assets.dispose(); assets.dispose()` after the single load/dispose run;
   repeated synchronous disposal must not throw. Fresh `fetch` rejection proves
   unresolved revoked URLs; mounted images keep already-resolved native bytes.
4. An empty byte array returns null and leaves `get()` null (proves no URL is
   exposed). It is independent of byte-rejection behavior, so use its own test.
5. Rejected bytes return null, retain console.error as existing; a subsequent
   successful call for that same ID can still create/cache a valid blob URL.
   Keep assertion scoped: no second generic error-read workaround required.
6. Disposal while asset promise is pending resolves `url()` null without
   publishing an entry; resolve manually. If Blob construction does happen
   before the post-check, immediately revoke via its URL and assert fresh
   fetch rejection; if bytes are dropped before any Blob was created,
   assert no `urls.get` entry and no future document reads instead. Do not
   sleep or assume a particular promise scheduling sequence.

Six cases total, including disposal twice and post-disposal no-read.

Do not introduce URL eviction or retention limits in this step.

**Verify**: `nsh test src/flow/asset-urls.test.ts` → all six tests pass, and
`nsh check src` → no type/lint-boundary errors.

### Step 3: Remove the duplicate NodeSession URL registry

In `src/flow/node-session.ts`, delete `private readonly urls` (line 57) and
every read/write of it. In `assetUrls()` (lines 131-135) read the current
detail through the existing signals, collect exactly the same IDs as
`ensureAssets` (output batch item `assetId`, local input `assetId`, and
`input.item.assetId`), map each through `this.host.assets()?.get(id) ?? null`,
drop the nulls, and use `Object.fromEntries` to retain the public
`Record<string, string>` return shape. Read `assetVersion()` before returning
so URL arrival remains reactive. Never recreate a URL here, revoke one here,
or read through a disposed session.

`ensureAssets()` (lines 427-448) still calls `assets.url(id, mime)` but must
not store the URL in the session. Replace `cacheUrl` with a notification-only
helper that keeps plan 006's exact contract:

```ts
/** Announces a URL this session has not announced yet. */
private noteAssetUrl(id: string): boolean {
  if (this.announced.has(id)) return false;
  this.announced.add(id);
  this.assetVersion.update((value) => value + 1);
  return true;
}
```

with `private readonly announced = new Set<string>()` and a per-id body that
captures the pre-load cache state before awaiting:

```ts
const previous = assets.get(id);
const url = await assets.url(id, mime);
if (url && previous === null && this.noteAssetUrl(id)) inserted = true;
```

`previous === null` is the "newly visible" condition: a URL already in the
AssetUrls cache must not wake readers again. Two detail reloads can await the
same pending `assets.url()` and both observe `previous === null`, so the
`announced` set is what preserves
`node-session-detail.native.test.ts`'s exactly-one-notification contract. It
is not a second URL cache: it stores no URLs and never serves one; it only
records which asset ids this session has already announced. `loadComposer`
has no unconditional post-ensure increment. `assetUrls()` reads
`assetVersion` exactly as plan 006 leaves it and still returns
`Record<string, string>`. Confirm plan 006's `AssetUrlSource (url/get)`
interface is unchanged; the real `AssetUrls` owns the only URL map and its
pending coalescing.

The lookup helper may be a small private `assetIds()` or `urlsFor(detail)`
method if needed to avoid a >500-code-line module; do not add a generic helper
module. `NodeComposer` receives the same record type and continues to decide
which item/input IDs matter for rendering.

Extend `src/flow/node-session.native.test.ts` using `makeSession()` and the
existing `runs the mock image provider and stores an immutable batch` fixture:
for every asset ID in the open detail, assert that `session.assetUrls()[id]`
strictly equals `assets.get(id)` and starts with `blob:`; a second
`session.assetUrls()` call must return those same string identities. Keep the
seeded runner/assets/document cleanup and plan 006's new tests unchanged.
Do not add an unrelated composer remount assertion: that belongs to 006.

Run existing App image flows. Add one `App.test.tsx` case only if existing
coverage does not show and then reopen the image composer's images: select
the existing image node using the same search-based pattern as
`selecting a text node opens its composer` and `removes an input from the
composer`; do not create a probe, upload fixture, or screenshot assertion in
application code. Headless assertions must observe stable composer content,
not raw URL decoding.

**Verify**: `nsh test src/flow/node-session.native.test.ts` → all pass,
including `asset URLs come from their one AssetUrls cache`; then
`nsh test src/flow/node-session-detail.native.test.ts` → all pass unmodified,
including "an asset URL that resolves after a reload notifies once"; then
`nsh test src/App.test.tsx --filter "composer"` → every matching test passes.

### Step 4: Add the real AssetUrls-to-Image.onLoad host regression

This is an actual `App.host.test.tsx` case during implementation, not merely
the Step 1 disposable probe. It must cover `Document.assetBytes → AssetUrls →
loadPreviews → scene.previews → FlowCard's <Image> → onLoad`, using the actual
blob URL which Step 2 now returns and observing a real native callback. The
seeded image provider generates valid SVG output; use this **mock-SVG**
fixture instead of uploading a browser file or a base64 URL. The Path through
`NodeSession.assetUrls` is separately checked in Step 3; this host test's
probe asset ID comes from card previews (`loadPreviews`), so no duplicate
image renderer or direct `new Blob` detaches the test from production.

In `src/App.host.test.tsx`, add `loads a blob image through the asset cache`:

1. `const app = await open("./App.tsx", { width: 900, height: 1300, platform:
   "windows", host: { params: { flowImageLoadProbe: 1 } } });` — the tall
   stage is the existing `openTallApp` size, needed for `id:composer-run` to
   be reachable. Host params are passed to the real host
   (`nsh-testing/src/run.rs:688-690`); `platform:"windows"` is a headless
   instruction the host mapper ignores, and `host.handlers` must **not** be
   supplied because the real target rejects it.
2. Use existing `selectSeed(app, "Image", "id:search-result-seed-image")` and
   `await app.waitFor("id:composer-run")`. Before pressing Run, handle the
   ordinary headless run of `.host.test.tsx`: `if (!app.shows("id:title-bar"))`.
   Then `expect(app.shows("id:brand-card")).toBe(true)` and
   `await app.waitFor("id:image-load-probe")`; `expect(app.value("id:image-load-probe")).toBe("")`
   and return. This explicitly does not wait for onLoad at headless. On
   Windows its real title bar is present so run the actual image use-case;
   `test:host` must exercise the following assertion, never this branch.
   If a Windows target shows brand-card, STOP rather than accept host absence.
3. On desktop `await app.press("id:composer-run")`, await `app.waitUntil(()
   => app.texts().some((text) => text.endsWith("Done")))` once provider
   populated results. Then `await app.waitUntil(() => { const parts =
   (app.value("id:image-load-probe") ?? "").split(";"); return parts[0] ===
   "load" && parts[1] === "seed-image" && parts[2]?.startsWith("blob:") ===
   true && Number(parts[3]) > 0 && Number(parts[4]) > 0;})`.
   Record `const report = ...`; `expect(report).not.toMatch(/^error;/)`, and
   `Number.isFinite` width/height positive finite. These are `onLoad
   e.size` PixelSize, not metrics derived from text/layout, not a bare mount/no-error.
4. Assert `new URL(report.split(";")[2] ?? "").protocol === "blob:"` and
   no `error;seed-image` substring. Assert fields exactly
   `kind;nodeId;url;width;height;message`; url() actual cache result via
   preview loader (mock SVG generated by seeded runner). Width/height are
   native decoded pixel source dimensions, not `testID` viewport measure
   same card still exists alongside optional callback binding. Real runtime
   `onError` fires typed e.message as another field if failure. No sleep.
   Native host callback absence fails the host test; no text-only substitute.

Provide the callback through the existing FlowCard image itself. The preview
`<Image>` is inside the `<Each of={props.preview()?.urls ?? []} key="index">`
at `src/components/FlowCard.tsx:186-205`; wrap that element rather than adding
a second image. Do not make a probe-only duplicate `<Image>` or a new canvas.
The optional hook is defined so all normal app rendering has the old semantics
and headless never has an onLoad requirement.

1. In `FlowCard.tsx` export:

   ```ts
   export interface CardImageEvent {
     readonly nodeId: string;
     readonly kind: "load" | "error";
     readonly url: string;
     readonly width: number;
     readonly height: number;
     readonly message: string;
   }
   ```

   Add `readonly imageEvent?: (event: CardImageEvent) => void` to
   `FlowCardProps` (`FlowCard.tsx:28-44`) and `FlowCanvasProps`
   (`FlowCanvas.tsx:26-38`); FlowCanvas forwards it unchanged on its
   `<FlowCard>` at `FlowCanvas.tsx:290-306`. Within the existing `<Each>` child pass the **already
   decoded asset-URL string** through:

   ```tsx
   onLoad={(event) => props.imageEvent?.({
     nodeId: props.node().id, kind: "load", url: url(),
     width: event.size.width, height: event.size.height, message: "",
   })}
   onError={(event) => props.imageEvent?.({
     nodeId: props.node().id, kind: "error", url: url(),
     width: 0, height: 0, message: event.message,
   })}
   ```

   These two callbacks wrap the existing `<Image>` and source unchanged, so
   the host proof observes an actual AssetUrls-provided `blob:` source, not
   test bytes unrelated to the session. `url()` is the existing Each accessor
   available in that child function. `e.size` is the documented `PixelSize`;
   `e.message` comes from the optional `code?` typed event. The `index`
   doesn't have to become a key; only record actual event arrival. At least
   one `nodeId:"seed-image"` load from SVG is expected; do not choose a
   fixed second/third output item position.

2. `FlowPage.tsx` currently imports
   `cleanup, effect, keymap, Picker, signal, untracked, View` from `"nsh"` at
   line 1; add `host` to that list, and import `type CardImageEvent` from the
   normal component export. Its `imageProbe = signal("")` has a
   single handler `reportImage(event)` which calls `set()` with `[event.kind,
   event.nodeId, event.url, event.width.toString(),
   event.height.toString(), event.message].join(";")`. That gives exact
   `kind;nodeId;url;width;height;message` order without storing the whole
   SVG payload. The report always uses the actual URL rather than
   hardcoded "blob:"; `app.value` allows the test to assert `url.startsWith
   ("blob:")` and positive size without a direct `src` inspector. A tiny
   pure helper `imageProbeText(event)` in `FlowCard.tsx` is a suitable
   typed fallback if line cap requires; no new spy module or global store.
   Since plan 006 already controls FlowPage's composer guards, don't modify
   those. The page hasn't passed onImageEvent before; the lone added
   binding is `imageEvent={reportImage}` on `FlowCanvas`.

   Mount the observability `<Input testID="image-load-probe" readonly
   value={imageProbe()}>` inside `<If when={host.params.flowImageLoadProbe
   === 1}>` only. `Host.params` is
   `{ readonly [key: string]: HostValue }` (`index.d.ts:1773`), so `=== 1`
   narrows without a type assertion. Mount it inside FlowPage's root
   `<View class="flex-1">` (`FlowPage.tsx:418`) and pass
   `imageEvent={reportImage}` on its `<FlowCanvas>` (`FlowPage.tsx:420`). `host.handlers` must not be
   passed (real-host API refuses handlers test option), but
   `open("./App.tsx", {platform:"windows",host:{params:{flowImageLoadProbe:1}}})`
   forwards those params per pinned `nsh-testing/run.rs:688-690`. Use the
   existing FlowPage root view as its parent; outside a card/composer clip.
   Give it style `{position:"absolute", left:8, top:8, width:360, height:1,
   opacity:0}` (UI test selector still finds its Input, not user input).
   Do not put a `hidden` display skip on it. This test-only invisible Input
   is not a user-facing persistent telemetry system. No `nsh.json`
   capability/network/write changes. The host launch key is exactly
   `flowImageLoadProbe=1`, used nowhere else for app behavior.

   `signal` already exists at FlowPage at current HEAD. It may cause local
   event updates only when probe is active: `reportImage` should first
   test `host.params.flowImageLoadProbe` (read during the callback at
   mounted runtime), returning if not exactly `1`. The `If` JS expression
   reads it as a constant configuration, not a reactive signal; its purpose
   is to select host-test instrumentation only, not track interactive state.

3. Add a separate `src/App.test.tsx` case `"publishes an empty image-load probe while headless"`:
   launch via the exact same params as the host case, select Image, then
   `await app.waitFor("id:image-load-probe")`; immediately assert
   `app.value("id:image-load-probe")` equals `""`. Assert the normal composer
   is present `id:composer-run` to prove the probe app rendered. Never run
   one and wait for `onLoad`, infer native image decoding from `No output
   yet` disappearing, or use that headless empty probe as successful content
   of the Windows test. Why this remains vacuous no-call callback on
   headless is explicitly the NSH line above. Keeping this observability
   contract as its only headless test prevents an accidentally fired
   synthetic load in future from masquerading headless proof.

**Verify**: `bun run test:host -- --filter "loads a blob image through the
asset cache"` observes `kind:"load"`, `nodeId:"seed-image"`, a blob URL and
finite >0 dimensions from the real host; no matching `error` event exists.
Keep `bun run test:host` as the complete host suite gate. Headless companion
command is `nsh test src/App.test.tsx --filter "empty image-load probe"`;
if this adds no meaningful compiler-free behavior, still keep its probe
observability red/green explicit by simply checking the empty value. Never
replace the required host `waitUntil` by this headless check.

### Step 5: Update the explanatory comments, changelog and run the complete evidence gates

Change the `asset-urls.ts` header to say blob URLs let NSH resolve and share
native image bytes; this cache owns revocation until page disposal. Update
`dispose()` docs to say it revokes the URLs still owned and is idempotent.
Do not claim native images immediately disappear: the pinned semantics retain
their resolved bytes. Add one concise `CHANGELOG.md` `### Changed` bullet
stating that preview and composer images now use cached `blob:` URLs rather
than per-mount base64 data-URL decoding.

Run formatting, then:

```sh
bun run check
bun run test
bun run test:host
./node_modules/.bin/vp fmt plans/README.md
```

Capture the host run separately from automated headless evidence. Ensure the
disposable probe did not become a repository file (step 1 used a path outside
the repo), and confirm the working tree only contains this plan's scope and
ledger update.

**Verify**: all three gate commands exit 0; the changelog contains the blob
entry under `### Changed`, and `git diff --stat 1956ebb --name-only` names no
out-of-scope source file (dependency-plan changes already landed outside your
branch are not yours).

## Test plan

- New `src/flow/asset-urls.test.ts` cases: cached blob URL/single byte read;
  synchronous cache read; disposal plus restart rejection; empty and failed
  byte reads; pending-load completion after disposal. Each is one behavior.
- Extend `src/flow/node-session.native.test.ts`'s first image-provider case
  with `session.assetUrls()` ↔ `assets.get()` identity and scheme assertions,
  following its existing `makeSession()` fixture.
- Keep `src/flow/node-session-detail.native.test.ts` unmodified and green,
  especially "an asset URL that resolves after a reload notifies once"
  (`:439-523`): one `assetVersion` increment per asset, none for a cached
  load.
- Keep existing `src/App.test.tsx` composer/image behavior green. Add only a
  missing image-remount flow if coverage inspection proves that gap.
- Mandatory real-Windows `loads a blob image through the asset cache` in
  `src/App.host.test.tsx` observes the AssetUrls-seeded preview's `onLoad`,
  positive native dimensions and `blob:` URL with no `onError`. The separate
  Windows Step 1 probe proves PNG and SVG. No headless onLoad test is
  expected to run or pass; the explicit headless probe contract remains empty.
- Verification: `nsh test src/flow/asset-urls.test.ts` (6 new cases),
  `nsh test src/flow/node-session.native.test.ts`, `bun run test`, and
  `bun run test:host` all pass.

## Done criteria

- [ ] Windows-only disposable probe reports `onLoad` for PNG and SVG blob
      URLs with zero `onError` callbacks. No headless onLoad criterion exists.
- [ ] `! grep -n "base64\|btoa\|String.fromCharCode" src/flow/asset-urls.ts`
      exits 0 when no forbidden conversion remains (empty grep output alone
      suffices if `--status` is unavailable on the executor's shell).
- [ ] `! grep -n "private readonly urls\|this.urls" src/flow/node-session.ts`
      exits 0 when the duplicate cache is absent; `assetUrls()` still returns
      `Record<string, string>`.
- [ ] `bun run test:host -- --filter "loads a blob image through the asset cache"`
      observes the actual AssetUrls-provided FlowCard `<Image>` onLoad on
      Windows, with the mock SVG's positive `onLoad` dimensions and `blob:` URL.
      This is required proof of the switch, not an ordinary headless App test.
- [ ] Six focused AssetUrls tests pass, including pending-load disposal.
- [ ] `nsh test src/flow/node-session-detail.native.test.ts` passes with the
      file unmodified: one `assetVersion` increment per newly visible asset,
      none for a load served from the cache.
- [ ] `bun run check`, `bun run test` and `bun run test:host` all exit 0.
- [ ] `CHANGELOG.md` has a `### Changed` blob-URL bullet.
- [ ] `git status --short` shows only in-scope changes (plus the index row),
      no probe files and no `src/.nsh/` changes.
- [ ] `plans/README.md` status row updated and formatted.

## STOP conditions

Stop and report back (do not improvise) if:

- Any required Windows PNG/SVG image or the host AssetUrls mock-SVG preview
  fails `onLoad` or reports `onError`. Do not reintroduce base64 silently.
  A headless callback failure is expected from `headless/mod.rs:292-298`,
  not a result to weaken or a failing signal reported as a Windows error.
- Disposal cannot be observed as preventing future URL resolution in step 2,
  or the generated URL/Blob declarations differ from the excerpts.
- Plan 006's index row is not DONE, or an excerpt mismatch is not explained
  by its `assetVersion` and keyed-composer changes.
- `Blob([bytes])` or the fake Document would require `any`,
  an unsafe assertion in app code, or replacement of global `URL` methods.
- An existing image composer preview fails because a previously retained
  duplicate map made URLs outlive `AssetUrls`; this indicates a lifetime
  dependency the design did not expect.
- A verification fails twice after a reasonable fix attempt, or success would
  require editing an out-of-scope file.

## Maintenance notes

- URL lifetime is deliberately page-scoped in this plan. Do not add an LRU or
  revoke on composer close: preview cards can mount the same asset later and
  a revoked URL cannot resolve in a new mount. A future cache eviction design
  must account for both mounted and future users before taking ownership.
- Keep one blob per content-addressed asset ID in `AssetUrls`. Never mint
  duplicate URLs per consumer or per detail load. Reviewers should inspect
  the post-`await` disposal branch for immediate revocation.
- If NSH's pin changes, repeat the PNG/SVG **Windows** probe before relying
  on blob support. Never repeat a headless load prerequisite: that sampler
  explicitly emits no onLoad. The old "waits forever" header is obsolete at
  the current pin, not a safe assumption for arbitrary versions.
- No runtime dependency, network host, facade change, or schema migration is
  introduced, so no ADR is needed. If image bytes must be surfaced via the
  document facade instead, that requires a different plan.
