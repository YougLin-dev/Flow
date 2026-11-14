/**
 * The one machine-readable map of the app's layers, areas and allowed imports.
 *
 * `boundaries.js` (the Oxlint plugin) and `scripts/structure.mjs` both read
 * this file, so the rule, the report and `docs/code-map.md` cannot drift.
 * It stays pure: no `vite-plus`, no filesystem, no imports.
 *
 * Vocabulary: a layer is `pages`, `components` or `flow`; an area is a
 * feature folder inside a layer (`flow/canvas`, `components/canvas`); a
 * segment is one of the reserved subfolders `geometry`, `model`,
 * `interaction`, `test`; any other subfolder is a part folder.
 *
 * Phase 0 runs the area rules in report-only mode. `ENFORCEMENT` is flipped
 * in Phase 5; the legacy flat files stay allow-listed only until their area
 * move lands.
 */

/** Which structure rules fail today. Phase 5 turns all of them on. */
export const ENFORCEMENT = {
  areas: false,
  nativeSeam: false,
  unclassified: false,
};

export const PAGE_AREA = "pages/flow";
export const SHELL_AREA = "shell";
export const STORE_AREA = "store";

/** The reserved segment folders; any other folder inside an area is a part. */
export const SEGMENTS = new Set(["geometry", "model", "interaction", "test"]);

/** Folder names that hide a grab bag instead of naming a job. */
export const FORBIDDEN_FOLDERS = new Set(["utils", "helpers", "common", "misc", "data", "types"]);

/** A direct-entry budget per area: report above the first, fail above the second. */
export const AREA_BUDGET = { report: 12, fail: 20 };

/** A documented budget exception: owner and expiry are both mandatory. */
export const STRUCTURE_EXCEPTIONS = [];

/**
 * The area matrix. `mayImport` lists area names; external packages are not
 * areas. `deepSameFeature` lists the sibling area in the other layer whose
 * internals this area may import directly instead of through its facade.
 * `pages/flow` is the composition root and may deep-import every area.
 */
export const AREAS = {
  "flow/shared": {
    layer: "foundation",
    feature: "shared",
    facade: "src/flow/shared/index.ts",
    mayImport: [],
    deepSameFeature: [],
  },
  "flow/nodes": {
    layer: "foundation",
    feature: "nodes",
    facade: "src/flow/nodes/index.ts",
    mayImport: ["flow/shared"],
    deepSameFeature: [],
  },
  "flow/minimap": {
    layer: "foundation",
    feature: "minimap",
    facade: "src/flow/minimap/index.ts",
    mayImport: ["flow/shared"],
    deepSameFeature: [],
  },
  "flow/canvas": {
    layer: "foundation",
    feature: "canvas",
    facade: "src/flow/canvas/index.ts",
    mayImport: ["flow/shared", "flow/nodes"],
    deepSameFeature: [],
  },
  "flow/execution": {
    layer: "foundation",
    feature: "execution",
    facade: "src/flow/execution/index.ts",
    mayImport: ["flow/shared", "flow/nodes"],
    deepSameFeature: [],
  },
  "flow/composer": {
    layer: "foundation",
    feature: "composer",
    facade: "src/flow/composer/index.ts",
    mayImport: ["flow/shared", "flow/nodes", "flow/canvas"],
    deepSameFeature: [],
  },
  "flow/document": {
    layer: "foundation",
    feature: "document",
    facade: "src/flow/document/index.ts",
    mayImport: ["flow/shared", "flow/nodes", "flow/canvas", "flow/execution"],
    deepSameFeature: [],
  },
  "components/primitives": {
    layer: "component",
    feature: "primitives",
    facade: "src/components/primitives/index.ts",
    mayImport: ["flow/shared"],
    deepSameFeature: [],
  },
  "components/app": {
    layer: "component",
    feature: "app",
    facade: "src/components/app/index.ts",
    mayImport: ["components/primitives", "flow/shared"],
    deepSameFeature: [],
  },
  "components/probes": {
    layer: "component",
    feature: "probes",
    facade: "src/components/probes/index.ts",
    mayImport: ["components/primitives", "flow/canvas"],
    deepSameFeature: [],
  },
  "components/canvas": {
    layer: "component",
    feature: "canvas",
    facade: "src/components/canvas/index.ts",
    mayImport: ["components/primitives", "flow/shared", "flow/nodes", "flow/canvas"],
    deepSameFeature: ["flow/canvas"],
  },
  "components/composer": {
    layer: "component",
    feature: "composer",
    facade: "src/components/composer/index.ts",
    mayImport: ["components/primitives", "flow/shared", "flow/nodes", "flow/composer"],
    deepSameFeature: ["flow/composer"],
  },
  "components/minimap": {
    layer: "component",
    feature: "minimap",
    facade: "src/components/minimap/index.ts",
    mayImport: ["components/primitives", "flow/shared", "flow/canvas", "flow/minimap"],
    deepSameFeature: ["flow/minimap"],
  },
  "components/search": {
    layer: "component",
    feature: "search",
    facade: "src/components/search/index.ts",
    mayImport: ["components/primitives", "flow/shared"],
    deepSameFeature: [],
  },
  "pages/flow": {
    layer: "page",
    feature: "flow",
    facade: "src/pages/flow/index.ts",
    mayImport: [],
    deepSameFeature: [],
    compositionRoot: true,
  },
  store: {
    layer: "store",
    feature: "store",
    facade: "src/store.ts",
    mayImport: ["flow/shared"],
    deepSameFeature: [],
  },
  shell: {
    layer: "shell",
    feature: "shell",
    facade: "src/App.tsx",
    mayImport: ["pages/flow", "components/app", "store"],
    deepSameFeature: [],
  },
};

/** Test-only modules: classified, exempt from the matrix, never production imports. */
export const TEST_SUPPORT_FILES = new Set([
  "src/flow/node-session-harness.ts",
  "src/flow/document/test/node-session-harness.ts",
  "src/test-support/app.ts",
]);

/**
 * Today's flat modules at the components/flow/pages roots. They are the only
 * root modules allowed during the migration; any other root file fails. The
 * list shrinks with every move PR and disappears in Phase 5.
 */
export const LEGACY_FLAT = new Set([
  "src/components/BrandCard.tsx",
  "src/components/CanvasContextMenu.tsx",
  "src/components/CanvasMenuLayer.tsx",
  "src/components/CanvasProbe.tsx",
  "src/components/ComposerInputTile.tsx",
  "src/components/ComposerModelSelect.tsx",
  "src/components/FlowCanvas.tsx",
  "src/components/FlowCard.tsx",
  "src/components/FlowEdges.tsx",
  "src/components/FlowPreviews.tsx",
  "src/components/FrameRate.tsx",
  "src/components/GridBackground.tsx",
  "src/components/InlineTextEditor.tsx",
  "src/components/MiniMap.tsx",
  "src/components/MinimapDragOverlay.tsx",
  "src/components/NodeToolbar.tsx",
  "src/components/Port.tsx",
  "src/components/PortTooltip.tsx",
  "src/components/SearchButton.tsx",
  "src/components/SearchPalette.tsx",
  "src/components/SelectionFrame.tsx",
  "src/components/SelectionOverlay.tsx",
  "src/components/SelectionPorts.tsx",
  "src/components/TitleBar.tsx",
  "src/components/UploadButton.tsx",
  "src/components/ZoomControls.tsx",
  "src/flow/asset-urls.ts",
  "src/flow/bindings.ts",
  "src/flow/composer-detail.ts",
  "src/flow/data.ts",
  "src/flow/database-path.ts",
  "src/flow/document-session.ts",
  "src/flow/inline-editor.ts",
  "src/flow/minimap-loader.ts",
  "src/flow/node-commands.ts",
  "src/flow/node-session-harness.ts",
  "src/flow/node-session.ts",
  "src/flow/page-chrome.ts",
  "src/flow/preview-loader.ts",
  "src/flow/previews.ts",
  "src/flow/search-filters.ts",
  "src/flow/search-navigation.ts",
  "src/flow/upload-source.ts",
  "src/flow/viewport-controller.ts",
  "src/pages/FlowPage.tsx",
]);

/** The layer graph `no-upward-import` enforces. Tests may reach everywhere. */
export const LAYERS = {
  shell: new Set(["shell", "page", "component", "store", "foundation", "asset"]),
  page: new Set(["page", "component", "store", "foundation", "asset"]),
  component: new Set(["component", "foundation", "asset"]),
  store: new Set(["store", "foundation", "asset"]),
  foundation: new Set(["foundation", "asset"]),
  test: new Set(["shell", "page", "component", "store", "foundation", "test", "asset"]),
  asset: new Set(),
};

/** A project path without the `src/` prefix and without a TS extension. */
export function projectPath(file) {
  let path = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.startsWith("src/")) path = path.slice("src/".length);
  return path.replace(/\.(?:tsx?|jsx?|mjs)$/, "");
}

export function isTestFile(file) {
  return /\.test\.(?:tsx?|jsx?)$/.test(file.replace(/\\/g, "/"));
}

export function isTestSupportPath(file) {
  const path = file.replace(/\\/g, "/");
  return (
    path.startsWith("src/test-support/") || path.includes("/test/") || TEST_SUPPORT_FILES.has(path)
  );
}

/** Whether a source file is production code (not a test or a test helper). */
export function isProductionFile(file) {
  return !isTestFile(file) && !isTestSupportPath(file);
}

/** Whether a resolved target is test-only (a test file or a test helper). */
export function isTestSupportTarget(file) {
  return isTestFile(file) || isTestSupportPath(file);
}

/** The layer of a project file, from its path relative to the repository. */
export function layerOf(file) {
  if (isTestFile(file) || isTestSupportPath(file)) return "test";
  const stem = projectPath(file);
  if (stem === "App") return "shell";
  if (stem === "store") return "store";
  if (stem === "pages" || stem.startsWith("pages/")) return "page";
  if (stem === "components" || stem.startsWith("components/")) return "component";
  if (
    stem === "flow" ||
    stem.startsWith("flow/") ||
    stem === "native" ||
    stem.startsWith("native/")
  ) {
    return "foundation";
  }
  if (stem === "assets" || stem.startsWith("assets/")) return "asset";
  return "other";
}

/** Whether a module in `section` may import a module in `targetLayer`. */
export function canImport(section, targetLayer) {
  const allowed = LAYERS[section];
  return Boolean(allowed && allowed.has(targetLayer));
}

const AREA_NAMES = Object.keys(AREAS).toSorted((first, second) => second.length - first.length);

/** The area a file belongs to, or null for a legacy/unclassified file. */
export function areaOf(file) {
  // A legacy flat module stays unclassified until its own move lands, even
  // when an area of a related name already exists.
  if (LEGACY_FLAT.has(file.replace(/\\/g, "/").replace(/^\.\//, ""))) return null;
  const path = projectPath(file);
  if (path === "App") return "shell";
  for (const area of AREA_NAMES) {
    if (path === area || path.startsWith(`${area}/`)) return area;
  }
  return null;
}

/** The reserved segment a file sits in, or null for the facade/part folders. */
export function segmentOf(file) {
  const area = areaOf(file);
  if (!area) return null;
  const path = projectPath(file);
  if (path === area) return null;
  const first = path.slice(area.length + 1).split("/")[0];
  return SEGMENTS.has(first) ? first : null;
}

/** The feature shared by an area and its sibling in the other layer. */
export function featureOf(area) {
  return area.split("/")[1] ?? area;
}

/** Whether a file is the public entry of its area. */
export function isFacade(file) {
  const area = areaOf(file);
  if (!area) return false;
  return projectPath(file) === projectPath(AREAS[area].facade);
}

/** Whether `target` is the facade for `area`, from the caller's path. */
export function isFacadeOf(area, target) {
  return Boolean(AREAS[area]) && isFacade(target) && areaOf(target) === area;
}

/** The rule entry for an area, or null. */
export function areaRule(area) {
  return AREAS[area] ?? null;
}

/** Whether importing `targetArea` from `sourceArea` is allowed at all. */
export function canImportArea(sourceArea, targetArea) {
  if (!sourceArea || !targetArea) return true;
  const rule = AREAS[sourceArea];
  if (!rule) return true;
  if (rule.compositionRoot) return true;
  return rule.mayImport.includes(targetArea);
}

/** Whether a deep import is allowed because the areas are one feature. */
export function isSameFeatureDeep(sourceArea, targetArea) {
  const rule = AREAS[sourceArea];
  return Boolean(rule && rule.deepSameFeature.includes(targetArea));
}
