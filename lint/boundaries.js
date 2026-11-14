/**
 * Project boundary rules: dependencies flow down, and areas stay cohesive.
 *
 *   shell (src/App.tsx)  may use everything
 *   page                 may use pages, components, the store and foundations
 *   component            may use components, shared types and foundations
 *   store                may use shared types and foundations
 *   foundation           may use foundations only (flow/, lib/, tool.ts)
 *
 * The layer rule and every area rule (`deep-cross-feature`,
 * `forbidden-area`, `segment-direction`, `native-outside-seam`,
 * `unclassified-source`, `test-support-in-production`) are always on.
 *
 * Loaded by `vite.config.ts` (`lint.jsPlugins`).
 */
import { dirname, resolve } from "node:path";
import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import { resolveProjectImport, toProjectPath } from "./import-resolver.js";
import {
  AREAS,
  areaOf,
  canImport,
  canImportArea,
  isFacadeOf,
  isProductionFile,
  isSameFeatureDeep,
  isTestFile,
  isTestSupportTarget,
  layerOf,
  segmentOf,
} from "./structure-map.js";

export { canImport, layerOf } from "./structure-map.js";
export { resolveProjectImport } from "./import-resolver.js";

/** The literal source of an import/export node, or null. */
function sourceOf(node) {
  const source = node.source;
  if (!source || source.type !== "Literal" || typeof source.value !== "string") return null;
  return source.value;
}

/**
 * Visit each relative import/export with its resolved target. A target that
 * does not exist is passed through as null so the caller can still fail
 * closed on an unclassified source.
 */
export function forEachImport(context, visit) {
  const file = toProjectPath(context.cwd, context.filename);
  if (!file.startsWith("src/")) return {};
  const handler = (node) => {
    const specifier = sourceOf(node);
    if (specifier === null || !specifier.startsWith(".")) return;
    const target = resolveProjectImport(context.cwd, context.filename, specifier);
    visit({ node, specifier, target, file });
  };
  return {
    ImportDeclaration: handler,
    ExportNamedDeclaration: handler,
    ExportAllDeclaration: handler,
    ImportExpression: handler,
  };
}

/** A report helper shared by the rules. */
function report(context, node, messageId, data) {
  context.report({ node, messageId, data });
}

/** The area rules skip test files; tests may reach across areas on purpose. */
function isAreaChecked(file) {
  return isProductionFile(file);
}

const noUpwardImport = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep dependencies flowing down: pages may use components and the store, never the reverse.",
    },
    messages: {
      upward: "A {{section}} module may not import a {{target}} module ({{source}}).",
      unknown:
        "An import resolved to an unclassified module ({{source}}); classify it in LAYERS and layerOf before importing it.",
      unclassified:
        "This source module is not classified in LAYERS; it may not import {{source}} until it is.",
    },
  },
  create(context) {
    const file = toProjectPath(context.cwd, context.filename);
    if (isTestFile(file)) return {};
    if (!file.startsWith("src/")) return {};

    const section = layerOf(file);

    const check = (node) => {
      const specifier = sourceOf(node);
      if (specifier === null || !specifier.startsWith(".")) return;
      const target = toProjectPath(context.cwd, resolve(dirname(context.filename), specifier));
      const targetLayer = layerOf(target);
      if (targetLayer === "other") {
        report(context, node.source, "unknown", { source: specifier });
        return;
      }
      // A source module missing from LAYERS may import nothing; otherwise it
      // would be an unchecked hole in the direction rule.
      if (section === "other") {
        report(context, node.source, "unclassified", { source: specifier });
        return;
      }
      if (canImport(section, targetLayer)) return;
      report(context, node.source, "upward", {
        section,
        target: targetLayer,
        source: specifier,
      });
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
});

const deepCrossFeature = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Cross-area imports use the target area's facade." },
    messages: {
      deep: "{{source}} must import {{target}} through its index.ts, not {{specifier}}.",
    },
  },
  create(context) {
    return forEachImport(context, ({ node, specifier, target, file }) => {
      if (!isAreaChecked(file)) return;
      const sourceArea = areaOf(file);
      const targetArea = target ? areaOf(target) : null;
      if (!sourceArea || !targetArea || sourceArea === targetArea) return;
      if (AREAS[sourceArea]?.compositionRoot) return;
      if (!canImportArea(sourceArea, targetArea)) return;
      if (isSameFeatureDeep(sourceArea, targetArea)) return;
      if (isFacadeOf(targetArea, target)) return;
      report(context, node.source, "deep", { source: sourceArea, target: targetArea, specifier });
    });
  },
});

const forbiddenArea = defineRule({
  meta: {
    type: "problem",
    docs: { description: "An area may import only the areas its matrix row allows." },
    messages: {
      forbidden: "{{source}} may not import {{target}} ({{specifier}}).",
    },
  },
  create(context) {
    return forEachImport(context, ({ node, specifier, target, file }) => {
      if (!isAreaChecked(file)) return;
      const sourceArea = areaOf(file);
      const targetArea = target ? areaOf(target) : null;
      if (!sourceArea || !targetArea || sourceArea === targetArea) return;
      if (canImportArea(sourceArea, targetArea)) return;
      report(context, node.source, "forbidden", {
        source: sourceArea,
        target: targetArea,
        specifier,
      });
    });
  },
});

const segmentDirection = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "geometry stays pure, model stays view-free, interaction stays view-free.",
    },
    messages: {
      segment:
        "{{source}} ({{sourceSegment}}) may not import {{target}} ({{targetSegment}}/{{targetLayer}}).",
    },
  },
  create(context) {
    return forEachImport(context, ({ node, target, file }) => {
      if (!isAreaChecked(file)) return;
      const sourceArea = areaOf(file);
      if (!sourceArea || !sourceArea.startsWith("flow/")) return;
      const sourceSegment = segmentOf(file);
      if (sourceSegment === null) return;
      const targetArea = target ? areaOf(target) : null;
      const targetSegment = target ? segmentOf(target) : null;
      const targetLayer = target ? layerOf(target) : "other";
      // A forbidden area pair is reported by `forbidden-area`; do not double
      // report it here as a segment problem.
      if (targetArea !== sourceArea && !canImportArea(sourceArea, targetArea)) return;

      let violation = false;
      if (sourceSegment === "geometry") {
        // Geometry is pure math: same-area geometry or the shared kernel.
        violation =
          targetArea !== null &&
          !(
            targetArea === "flow/shared" ||
            (targetArea === sourceArea && targetSegment === "geometry")
          );
      } else if (sourceSegment === "model") {
        violation =
          (targetArea === sourceArea && targetSegment === "interaction") ||
          (targetArea !== sourceArea && targetArea === "flow/document") ||
          targetLayer === "component";
      } else if (sourceSegment === "interaction") {
        violation =
          targetLayer === "component" ||
          (targetArea !== sourceArea && targetArea === "flow/document");
      }

      if (violation) {
        report(context, node.source, "segment", {
          source: sourceArea,
          sourceSegment,
          target: targetArea ?? target ?? "unresolved",
          targetSegment: targetSegment ?? "none",
          targetLayer,
        });
      }
    });
  },
});

const testSupportInProduction = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Production code never imports test helpers or test files." },
    messages: {
      testSupport: "Production code may not import test support ({{specifier}}).",
    },
  },
  create(context) {
    return forEachImport(context, ({ node, specifier, target, file }) => {
      if (!isProductionFile(file)) return;
      const targetIsTest =
        (target !== null && isTestSupportTarget(target)) ||
        /(?:^|\/)test-support(?:\/|$)/.test(specifier) ||
        /(?:^|\/)test(?:\/|$)/.test(specifier);
      if (!targetIsTest) return;
      report(context, node.source, "testSupport", { specifier });
    });
  },
});

const nativeOutsideSeam = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "The native module is called only by flow/document; types use the seam.",
    },
    messages: {
      native:
        "`@flow/native` is document-only at runtime; import types from flow/shared/native-types.",
    },
  },
  create(context) {
    const check = (node) => {
      const specifier = sourceOf(node);
      if (specifier !== "@flow/native") return;
      const file = toProjectPath(context.cwd, context.filename);
      if (!isProductionFile(file)) return;
      if (file === "src/flow/shared/native-types.ts" || file.startsWith("src/flow/document/")) {
        return;
      }
      report(context, node.source, "native", {});
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
});

const unclassifiedSource = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Every app module is classified as an area.",
    },
    messages: {
      unclassified: "{{file}} is not an area; move it into one.",
    },
  },
  create(context) {
    const file = toProjectPath(context.cwd, context.filename);
    if (!file.startsWith("src/") || !isAreaChecked(file)) return {};
    if (areaOf(file) !== null) return {};
    if (layerOf(file) === "asset") return {};
    if (file === "src/App.tsx" || file === "src/store.ts") return {};
    return {
      Program(node) {
        report(context, node, "unclassified", { file });
      },
    };
  },
});

export {
  deepCrossFeature,
  forbiddenArea,
  nativeOutsideSeam,
  noUpwardImport,
  segmentDirection,
  testSupportInProduction,
  unclassifiedSource,
};

export default definePlugin({
  meta: { name: "boundaries" },
  rules: {
    "no-upward-import": noUpwardImport,
    "deep-cross-feature": deepCrossFeature,
    "forbidden-area": forbiddenArea,
    "segment-direction": segmentDirection,
    "test-support-in-production": testSupportInProduction,
    "native-outside-seam": nativeOutsideSeam,
    "unclassified-source": unclassifiedSource,
  },
});
