#!/usr/bin/env bun
/**
 * Phase 0 structure report. It reads `lint/structure-map.js` and checks the
 * shape of `src/` without touching files.
 *
 * Fails today only on a new module at the components/flow/pages root and on
 * production code importing test support. Every other finding is reported;
 * Phase 5 flips `ENFORCEMENT` and makes the area rules fail too.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { resolveProjectImport } from "../lint/import-resolver.js";
import {
  AREAS,
  AREA_BUDGET,
  ENFORCEMENT,
  FORBIDDEN_FOLDERS,
  LEGACY_FLAT,
  STRUCTURE_EXCEPTIONS,
  areaOf,
  canImportArea,
  isFacadeOf,
  isProductionFile,
  isSameFeatureDeep,
  isTestFile,
  isTestSupportPath,
  isTestSupportTarget,
  layerOf,
  segmentOf,
} from "../lint/structure-map.js";

const SKIP_DIRS = new Set([".nsh", "node_modules", "target", "assets", "native"]);

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Every .ts/.tsx file under src/, excluding generated and Rust folders. */
export function collectSourceFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        files.push(toPosix(relative(root, full)));
      }
    }
  };
  const source = join(root, "src");
  if (statSync(source, { throwIfNoEntry: false })?.isDirectory()) walk(source);
  return files.toSorted((first, second) => first.localeCompare(second));
}

/** Strip comments before the type-only fallback; `://` in a URL survives. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The specifiers an app file imports or re-exports. Bun's scanner is exact
 * for value imports but erases type-only ones, so a comment-stripped fallback
 * adds `import type`/`export type ... from` specifiers.
 */
export function readImports(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const specifiers = new Set(
    new Bun.Transpiler({ loader }).scanImports(text).map((entry) => entry.path),
  );
  const typeOnly = /\b(?:import|export)\s+type\s+[^"'`]*?\bfrom\s+["']([^"']+)["']/g;
  for (const match of stripComments(text).matchAll(typeOnly)) specifiers.add(match[1]);
  return [...specifiers];
}

/** Resolve a relative import the way NSH's bundler does. */
export function resolveImport(root, fromFile, specifier) {
  return resolveProjectImport(root, join(root, fromFile), specifier);
}

function isDirectRootModule(file, rootDirectory) {
  const parts = file.split("/");
  return (
    parts.length === 3 && parts[1] === rootDirectory && !isTestFile(file) && !LEGACY_FLAT.has(file)
  );
}

/** A new app module directly under components/, flow/ or pages/. */
export function checkRootModules(files) {
  const failures = [];
  for (const file of files) {
    for (const directory of ["components", "flow", "pages"]) {
      if (isDirectRootModule(file, directory)) {
        failures.push(`new flat module at the ${directory}/ root: ${file}`);
      }
    }
  }
  return failures;
}

/** Every existing area directory has an index.ts facade. */
export function checkFacades(root, files) {
  const reports = [];
  for (const [area, rule] of Object.entries(AREAS)) {
    const directory = join(root, "src", area);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (!files.includes(rule.facade)) {
      reports.push(`area ${area} is missing its ${rule.facade} facade`);
    }
  }
  return reports;
}

/** Reserved folder names that hide a grab bag. */
export function checkForbiddenFolders(files) {
  const reports = [];
  for (const file of files) {
    if (!file.startsWith("src/") || isTestSupportPath(file)) continue;
    const parts = file.split("/").slice(1, -1);
    for (const part of parts) {
      if (FORBIDDEN_FOLDERS.has(part)) {
        reports.push(`forbidden folder "${part}" in ${file}`);
      }
    }
  }
  return reports;
}

function exceptionFor(area) {
  return STRUCTURE_EXCEPTIONS.find(
    (exception) =>
      exception.path === area ||
      area.startsWith(`${exception.path}/`) ||
      exception.path === `src/${area}`,
  );
}

/** Direct entries in each existing area; report above 12, fail above 20. */
export function checkBudget(root) {
  const reports = [];
  const failures = [];
  for (const area of Object.keys(AREAS)) {
    const directory = join(root, "src", area);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    const entries = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) =>
        entry.name !== "index.ts" &&
        entry.name !== "test" &&
        !(entry.isFile() && isTestFile(entry.name)),
    );
    if (entries.length <= AREA_BUDGET.report) continue;
    const exception = exceptionFor(area);
    if (exception && exception.owner && exception.expires) continue;
    const message = `area ${area} has ${entries.length} direct entries (report at ${AREA_BUDGET.report}, fail at ${AREA_BUDGET.fail})`;
    if (entries.length > AREA_BUDGET.fail) failures.push(message);
    else reports.push(message);
  }
  return { reports, failures };
}

/** Production code never imports test files or test support. */
export function checkTestSupportImports(root, files) {
  const failures = [];
  for (const file of files) {
    if (!isProductionFile(file)) continue;
    for (const specifier of readImports(root, file)) {
      const target = resolveImport(root, file, specifier);
      const matches =
        (target !== null && isTestSupportTarget(target)) ||
        /(?:^|\/)test-support(?:\/|$)/.test(specifier) ||
        /(?:^|\/)test(?:\/|$)/.test(specifier);
      if (matches) failures.push(`${file} imports test support (${specifier})`);
    }
  }
  return failures;
}

/** Legacy allow-list entries whose file is gone; the list must shrink. */
export function checkLegacyAllowList(files) {
  return [...LEGACY_FLAT]
    .filter((file) => !files.includes(file))
    .map((file) => `stale legacy allow-list entry: ${file}`);
}

/** Unclassified app modules outside the legacy allow-list. */
export function checkUnclassified(files) {
  const reports = [];
  for (const file of files) {
    if (!isProductionFile(file) || !file.startsWith("src/")) continue;
    if (file === "src/App.tsx" || file === "src/store.ts") continue;
    if (areaOf(file) !== null || LEGACY_FLAT.has(file)) continue;
    reports.push(`unclassified module: ${file}`);
  }
  return reports;
}

/** A reporting check: app modules at the Rust crate root. */
export function checkRustLayout(root) {
  const directory = join(root, "src", "native", "src");
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  const allowed = new Set([
    "lib.rs",
    "db.rs",
    "db",
    "mutation.rs",
    "mutation",
    "reads",
    "store",
    "document.rs",
    "history.rs",
    "asset.rs",
    "schema.rs",
    "edge_index.rs",
    "search.rs",
    "scene.rs",
    "viewport.rs",
    "detail.rs",
    "constants.rs",
    "clock.rs",
    "types.rs",
    "entity",
  ]);
  return readdirSync(directory)
    .filter((entry) => !allowed.has(entry))
    .map((entry) => `Rust module at the crate root: src/native/src/${entry}`);
}

/**
 * Import-level area findings for the report. The lint plugin enforces the
 * same rules; this walk keeps `check:structure` honest while the plugin's
 * area rules are report-only.
 */
export function checkAreaImports(root, files) {
  const areaReports = [];
  const nativeReports = [];
  for (const file of files) {
    if (!isProductionFile(file) || !file.startsWith("src/")) continue;
    const sourceArea = areaOf(file);
    const sourceSegment = segmentOf(file);
    for (const specifier of readImports(root, file)) {
      if (specifier === "@flow/native") {
        if (file !== "src/flow/shared/native-types.ts" && !file.startsWith("src/flow/document/")) {
          nativeReports.push(`${file} imports @flow/native outside the document seam`);
        }
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolveImport(root, file, specifier);
      if (target === null) continue;
      const targetArea = areaOf(target);
      const targetSegment = segmentOf(target);
      const targetLayer = layerOf(target);

      if (sourceArea && targetArea && sourceArea !== targetArea) {
        if (!canImportArea(sourceArea, targetArea)) {
          areaReports.push(`${file} may not import ${targetArea} (${specifier})`);
        } else if (
          !AREAS[sourceArea]?.compositionRoot &&
          !isSameFeatureDeep(sourceArea, targetArea) &&
          !isFacadeOf(targetArea, target)
        ) {
          areaReports.push(`${file} deep-imports ${targetArea} (${specifier})`);
        }
      }

      if (!sourceSegment || !sourceArea?.startsWith("flow/")) continue;
      // A forbidden area pair belongs to the area finding above; the lint rule
      // returns early for the same reason, so the report mirrors its output.
      if (
        targetArea !== null &&
        targetArea !== sourceArea &&
        !canImportArea(sourceArea, targetArea)
      ) {
        continue;
      }
      let violation = false;
      if (sourceSegment === "geometry") {
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
        areaReports.push(`${file} (${sourceSegment}) may not import ${target}`);
      }
    }
  }
  return { areaReports, nativeReports };
}

/** The whole Phase 0 report; Phase 5 moves the area findings into failures. */
export function runStructureCheck(root) {
  const files = collectSourceFiles(root);
  const budget = checkBudget(root);
  const facades = checkFacades(root, files);
  const forbidden = checkForbiddenFolders(files);
  const unclassified = checkUnclassified(files);
  const imports = checkAreaImports(root, files);
  const legacy = checkLegacyAllowList(files);
  const failures = [
    ...checkRootModules(files),
    ...checkTestSupportImports(root, files),
    ...(ENFORCEMENT.areas ? facades : []),
    ...(ENFORCEMENT.areas ? forbidden : []),
    ...(ENFORCEMENT.areas ? budget.failures : []),
    ...(ENFORCEMENT.areas ? imports.areaReports : []),
    ...(ENFORCEMENT.nativeSeam ? imports.nativeReports : []),
    ...(ENFORCEMENT.areas ? legacy : []),
    ...(ENFORCEMENT.unclassified ? unclassified : []),
  ];
  const reports = [
    ...(ENFORCEMENT.areas ? [] : facades),
    ...(ENFORCEMENT.areas ? [] : forbidden),
    ...budget.reports,
    ...(ENFORCEMENT.areas ? [] : budget.failures),
    ...(ENFORCEMENT.areas ? [] : imports.areaReports),
    ...(ENFORCEMENT.nativeSeam ? [] : imports.nativeReports),
    ...(ENFORCEMENT.areas ? [] : legacy),
    ...(ENFORCEMENT.unclassified ? [] : unclassified),
    ...checkRustLayout(root),
  ];
  return { files, failures, reports };
}

function main() {
  const root = resolve(process.cwd());
  const { files, failures, reports } = runStructureCheck(root);
  const legacy = files.filter((file) => LEGACY_FLAT.has(file)).length;
  console.log(
    `structure: ${files.length} source files, ${legacy} legacy flat modules, ${Object.keys(AREAS).length} areas`,
  );
  for (const report of reports) console.log(`report: ${report}`);
  for (const failure of failures) console.error(`fail: ${failure}`);
  if (failures.length > 0) {
    console.error(`structure failed: ${failures.length} violation(s)`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
