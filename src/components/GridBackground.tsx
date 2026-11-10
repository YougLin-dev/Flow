/** The canvas' dot grid, as tiled static SVG images that cover the stage. */
import { colorScheme, Image, signal, token, View } from "nsh";
import type { CanvasCamera } from "../flow/camera";
import { gridLayout, wrappedGridOffset } from "../flow/grid";

export interface GridBackgroundProps {
  readonly camera: CanvasCamera;
}

// Screen-space grid: one 640-point tile with a dot every 32 points.
const TILE = 640;
const DOT_GAP = 32;
const DOTS = TILE / DOT_GAP;

export function GridBackground(props: GridBackgroundProps) {
  const size = signal({ width: 0, height: 0 });
  // The tile cache belongs to this view: one image per theme color.
  let cachedColor = "";
  let cachedSource = "";

  const tileSource = (color: string): string => {
    if (color === cachedColor) return cachedSource;
    let circles = "";
    for (let row = 0; row < DOTS; row += 1) {
      for (let column = 0; column < DOTS; column += 1) {
        circles += `<circle cx="${column * DOT_GAP + 1}" cy="${row * DOT_GAP + 1}" r="1" fill="${color}"/>`;
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}">${circles}</svg>`;
    cachedColor = color;
    cachedSource = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    return cachedSource;
  };

  const source = (): string => {
    // Read the scheme so a theme switch regenerates the tile.
    colorScheme();
    return tileSource(token("grid-dot"));
  };

  const tiles = () => {
    const { columns, rows } = gridLayout(size().width, size().height, TILE);
    return Array.from({ length: columns * rows }, (_, index) => ({
      column: index % columns,
      row: Math.floor(index / columns),
    }));
  };

  const wrap = (value: number): number => wrappedGridOffset(value, TILE) - TILE;

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
      onLayout={(event) => {
        const width = event.bounds.size.width;
        const height = event.bounds.size.height;
        if (size().width === width && size().height === height) return;
        size.set({ width, height });
      }}
    >
      {/* One moving container carries both camera offsets; the tiles below
          keep static positions and never read the camera themselves. */}
      <View
        style={{
          position: "absolute",
          left: wrap(props.camera.x),
          top: wrap(props.camera.y),
          width: 0,
          height: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        <Each of={tiles()} key={(tile) => `${tile.column}-${tile.row}`}>
          {(tile) => (
            <Image
              src={source()}
              style={{
                position: "absolute",
                left: tile().column * TILE,
                top: tile().row * TILE,
                width: TILE,
                height: TILE,
              }}
            />
          )}
        </Each>
      </View>
    </View>
  );
}
