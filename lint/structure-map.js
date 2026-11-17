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
 * Every rule is enforced: a module outside an area, a root module, a
 * forbidden folder, a cross-area import that skips a facade or a native
 * import outside the seam fails the gate.
 */

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
  "flow/projects": {
    layer: "foundation",
    feature: "projects",
    facade: "src/flow/projects/index.ts",
    mayImport: ["flow/shared", "flow/document"],
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
  "pages/projects": {
    layer: "page",
    feature: "projects",
    facade: "src/pages/projects/index.ts",
    mayImport: [],
    deepSameFeature: [],
    compositionRoot: true,
  },
  "pages/settings": {
    layer: "page",
    feature: "settings",
    facade: "src/pages/settings/index.ts",
    mayImport: [],
    deepSameFeature: [],
    compositionRoot: true,
  },
  store: {
    layer: "store",
    feature: "store",
    facade: "src/store.ts",
    mayImport: ["flow/shared", "flow/projects"],
    deepSameFeature: [],
  },
  startup: {
    layer: "store",
    feature: "startup",
    facade: "src/startup.ts",
    mayImport: ["store", "flow/shared"],
    deepSameFeature: [],
  },
  shell: {
    layer: "shell",
    feature: "shell",
    facade: "src/App.tsx",
    mayImport: [
      "pages/flow",
      "pages/projects",
      "pages/settings",
      "components/app",
      "flow/projects",
      "store",
      "startup",
    ],
    deepSameFeature: [],
  },
};

/** Test-only modules: classified, exempt from the matrix, never production imports. */
export const TEST_SUPPORT_FILES = new Set([
  "src/flow/document/test/node-session-harness.ts",
  "src/test-support/app.ts",
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

/**
 * Whether a production file may import the generated `@flow/native` runtime.
 * The type seam file re-exports generated types; `flow/document` and
 * `flow/projects` are the two runtime areas.
 */
export function mayImportNative(file) {
  return (
    file === "src/flow/shared/native-types.ts" ||
    file.startsWith("src/flow/document/") ||
    file.startsWith("src/flow/projects/")
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
  if (stem === "store" || stem === "startup") return "store";
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

/** The area a file belongs to, or null for an unclassified file. */
export function areaOf(file) {
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
