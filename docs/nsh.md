# Canvas SVG images: the NSH build Flow needed (historical)

> **Status: superseded.** Flow's canvas is now a native NSH view tree
> ([ADR 0004](adr/0004-native-view-canvas.md)), so the Leafer adapter and the
> layer-rasterization path described here no longer exist. This document is
> kept as the record of the host changes that path required.

Flow's former Leafer adapter rasterized an offscreen layer as one picture when
layer's compositing must stay inside it (alpha masks, erasers, blend copies,
group opacity, grayscale masks, patterned strokes and text). It serializes the
layer to a self-contained SVG (its text and inline raster images included),
hands it to `CanvasRenderingContext2D.drawImage`
as a `data:image/svg+xml` URL, and NSH's image loader rasterizes it. The layer
is then composited once, which is the isolation Canvas specifies.

A rasterized layer is an image the host loads asynchronously: it is skipped
until it has loaded, and the host draws again when it has. A layer that
changes every frame — a group whose opacity isolates shapes while one of
them moves — would then flicker or disappear for those frames. So the scene
keeps opacity on the connector shapes themselves, which replays as one
`globalAlpha` and stays vector: only layers whose compositing must stay
inside them pay for a raster.

Stock NSH 0.4.0 refuses an SVG in a canvas (`… is an SVG image: canvases draw
bitmaps`), so those effects need a host with the changes below. Plain layers
stay vector, so on stock NSH the ordinary scene still draws as before; a layer
that needs rasterization is simply left out there.

## Host changes

1. **Build resvg with text and inline images.** The workspace's `resvg`
   dependency enables `text`, `system-fonts`, `memmap-fonts` and
   `raster-images`. A generated mask or blend group carries its own text and
   `data:` images.
2. **`nsh-core::svg` draws them.** Its options load the system font database
   once (mapped, not read whole on every lookup), point a generic family the
   system lacks at an installed text family, and resolve inline raster
   `data:` image hrefs (files, URLs and nested SVG documents still resolve to
   nothing). Text is capped at `MAX_TEXT_CHARS`, because usvg lays out every
   glyph while parsing; a decoded raster image's area is part of the layer
   budget (a GIF's first frame, not its logical screen), so a small document
   cannot allocate a huge bitmap.
3. **Every canvas image loader accepts a rasterized SVG.**
   `load_bitmap` already receives a `Picture` whose frame is the SVG's raster;
   it used to reject it as "not a bitmap". The change returns that frame on
   Windows, Linux, macOS, GPUI, iOS and Android. Views that draw SVGs
   themselves keep their vector path. A canvas raster's pixels are the
   loader's size (a bucket, not the SVG's intrinsic points), so the app draws
   every generated image into an explicit destination rectangle and crops a
   source rectangle into the SVG's viewBox instead of passing it through as
   canvas source coordinates.
4. **The SVG module's tests follow the policy:** an inline raster `data:`
   image draws, nested SVG documents, remote URLs and files draw nothing, an
   oversized raster's area is refused, a GIF is charged its frame, text
   beyond `MAX_TEXT_CHARS` is refused before layout, and text is drawn from a
   given font database without depending on the machine's fonts.

The changes were developed against an NSH checkout at 0.4.0. Build its CLI and
point the app's tools at it:

```sh
cargo build -p nsh-cli
PATH=/path/to/nsh/target/debug:$PATH bun run test:host
PATH=/path/to/nsh/target/debug:$PATH bun run test:100k
```

`nsh test --target windows` (or the host of this OS) builds the development
host from the patched source.

## What stays bounded

An SVG drawn by a canvas is still a finite document: `MAX_BYTES`,
`MAX_TEXT_CHARS`, `MAX_SIDE`, `MAX_PIXELS` and `MAX_LAYER_PIXELS` apply, the
parser and renderer panics are errors, and the resolver reads no resource
outside the document. Only inline raster `data:` images are decoded, and
their pixel area counts toward `MAX_LAYER_PIXELS`; a nested
`data:image/svg+xml` is refused rather than drawn, so its tree cannot hide
from the budget. Text uses the system fonts the platform's text engine uses,
and the cap applies before usvg lays it out. An image referenced by `asset:`, file or remote
URL inside a rasterized layer is not embedded; keep such images out of
compositing layers (see the adoption debt in [standards.md](standards.md)).
