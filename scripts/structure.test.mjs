import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AREAS, ENFORCEMENT, LEGACY_FLAT, STRUCTURE_EXCEPTIONS } from "../lint/structure-map.js";
import { withTree } from "../lint/test-tree.js";
import {
  checkBudget,
  checkLegacyAllowList,
  checkRustLayout,
  checkTestSupportImports,
  checkUnclassified,
  collectSourceFiles,
  readImports,
  resolveImport,
  runStructureCheck,
} from "./structure.mjs";

const tree = {
  "src/.nsh/generated.ts": "",
  "src/native/src/db.rs": "",
  "src/assets/icon.ts": "",
  "src/flow/document/assets/previews.ts": "",
  "src/flow/page-chrome.ts":
    '// import x from "./test/helper"\nimport "./fixtures/a";\nexport { x } from "./fixtures/b";\nexport const later = () => import("./fixtures/c");\nimport type { A } from "./fixtures/type-a";\nexport type { B } from "./fixtures/type-b";',
  "src/flow/fixtures/a.ts": "",
  "src/flow/fixtures/b.ts": "",
  "src/flow/fixtures/c.ts": "",
  "src/flow/fixtures/type-a.ts": "",
  "src/flow/fixtures/type-b.ts": "",
  "src/flow/fixtures/duplicate.ts": 'import "./a";\nimport "./a";',
  "src/flow/new.ts": "",
  "src/flow/index.ts": "",
  "src/components/index.tsx": "",
  "src/pages/index.ts": "",
  // A flat fixture module: with the legacy allow-list empty, the classifier
  // treats it as unclassified by path alone.
  "src/flow/bindings.ts": 'import "./canvas";',
  "src/flow/utils/thing.ts": "",
  "src/flow/canvas/index.ts": "",
  "src/flow/canvas/model/camera.ts": "",
  "src/flow/canvas/geometry/point.ts": 'import "../model/camera";\nimport "../../execution/index";',
  "src/flow/execution/index.ts": "",
  "src/components/search/SearchPalette.tsx": 'import "../../flow/canvas";',
  "src/flow/document/session/session.ts": 'import "../test/helper";',
  "src/flow/document/session/type-only.ts": 'import type { Helper } from "../test/helper";',
  "src/flow/document/session/deep.ts": 'import "../../canvas/model/camera";',
  "src/flow/document/session/y.ts": "",
  "src/flow/document/interaction/controller.ts": 'import "../session/y";',
  "src/flow/document/model/x.ts": 'import "../session/y";',
  "src/flow/document/test/helper.ts": "",
  "src/components/canvas/index.ts": "",
  "src/components/canvas/helper.ts": 'import "@flow/native";',
  "src/components/canvas/type-only.ts": 'import type { NodeSummary } from "@flow/native";',
  "src/components/Widget.tsx": "",
  "src/pages/FlowPage.tsx": "",
};

test("code map mirrors the manifest areas and facades", () => {
  const map = readFileSync(new URL("../docs/code-map.md", import.meta.url), "utf8");
  for (const [area, rule] of Object.entries(AREAS)) {
    expect(map).toContain(`\`${area}\``);
    expect(map).toContain(`\`${rule.facade}\``);
  }
  expect(map).not.toContain("src/tool.ts");
});

test("collects app modules but skips generated and Rust folders", () => {
  withTree(tree, (root) => {
    const files = collectSourceFiles(root);
    expect(files).toContain("src/flow/page-chrome.ts");
    expect(files).toContain("src/components/canvas/index.ts");
    expect(files).not.toContain("src/.nsh/generated.ts");
    expect(files).not.toContain("src/native/src/db.rs");
    expect(files).not.toContain("src/assets/icon.ts");
    expect(files).toContain("src/flow/document/assets/previews.ts");
  });
});

test("resolves exact files, extensions and directory indexes", () => {
  withTree(tree, (root) => {
    expect(resolveImport(root, "src/components/Widget.tsx", "../flow/page-chrome")).toBe(
      "src/flow/page-chrome.ts",
    );
    expect(resolveImport(root, "src/components/Widget.tsx", "../flow/new")).toBe("src/flow/new.ts");
    expect(resolveImport(root, "src/components/Widget.tsx", "../components/canvas")).toBe(
      "src/components/canvas/index.ts",
    );
    expect(resolveImport(root, "src/components/Widget.tsx", "../flow/missing")).toBeNull();
  });
});

test("reports a new flat module, a missing facade and a forbidden folder", () => {
  withTree(tree, (root) => {
    const result = runStructureCheck(root);
    expect(result.failures.toSorted()).toEqual(
      [
        "new flat module at the flow/ root: src/flow/bindings.ts",
        "new flat module at the flow/ root: src/flow/index.ts",
        "new flat module at the flow/ root: src/flow/new.ts",
        "new flat module at the flow/ root: src/flow/page-chrome.ts",
        "new flat module at the pages/ root: src/pages/FlowPage.tsx",
        "new flat module at the components/ root: src/components/Widget.tsx",
        "new flat module at the components/ root: src/components/index.tsx",
        "new flat module at the pages/ root: src/pages/index.ts",
        "src/flow/document/session/session.ts imports test support (../test/helper)",
        "src/flow/document/session/type-only.ts imports test support (../test/helper)",
      ].toSorted(),
    );
    expect(result.reports).toContain(
      "area flow/document is missing its src/flow/document/index.ts facade",
    );
    expect(result.reports).toContain('forbidden folder "utils" in src/flow/utils/thing.ts');
    expect(result.reports).toContain("unclassified module: src/flow/utils/thing.ts");
    expect(result.reports).toContain(
      "src/flow/document/session/deep.ts deep-imports flow/canvas (../../canvas/model/camera)",
    );
    expect(result.reports).toContain(
      "src/components/search/SearchPalette.tsx may not import flow/canvas (../../flow/canvas)",
    );
    expect(result.reports).toContain(
      "src/flow/canvas/geometry/point.ts (geometry) may not import src/flow/canvas/model/camera.ts",
    );
    expect(result.reports).toContain(
      "src/flow/canvas/geometry/point.ts may not import flow/execution (../../execution/index)",
    );
    expect(result.reports).not.toContain(
      "src/flow/canvas/geometry/point.ts (geometry) may not import src/flow/execution/index.ts",
    );
    expect(result.reports).toContain(
      "src/components/canvas/helper.ts imports @flow/native outside the document seam",
    );
    expect(result.reports).toContain(
      "src/components/canvas/type-only.ts imports @flow/native outside the document seam",
    );
    expect(result.reports).not.toContain(
      "src/flow/document/model/x.ts (model) may not import src/flow/document/session/y.ts",
    );
    expect(result.reports).not.toContain(
      "src/flow/document/interaction/controller.ts (interaction) may not import src/flow/document/session/y.ts",
    );
    expect(result.reports).not.toContain(
      "src/flow/bindings.ts may not import flow/canvas (./canvas)",
    );
  });
});

test("reads static, re-export, dynamic and type-only imports but not comments", () => {
  withTree(tree, (root) => {
    const imports = readImports(root, "src/flow/page-chrome.ts");
    expect(imports).toEqual(
      expect.arrayContaining([
        "./fixtures/a",
        "./fixtures/b",
        "./fixtures/c",
        "./fixtures/type-a",
        "./fixtures/type-b",
      ]),
    );
    expect(imports).not.toContain("./test/helper");
    const duplicated = readImports(root, "src/flow/fixtures/duplicate.ts");
    expect(duplicated.filter((specifier) => specifier === "./a")).toHaveLength(1);
  });
});

test("fails a production import of test support and allows test code to import it", () => {
  withTree(tree, (root) => {
    const files = collectSourceFiles(root);
    expect(checkTestSupportImports(root, files)).toEqual([
      "src/flow/document/session/session.ts imports test support (../test/helper)",
      "src/flow/document/session/type-only.ts imports test support (../test/helper)",
    ]);
  });
});

test("reports the direct-entry budget and fails above the hard cap", () => {
  withTree({ "src/flow/canvas/index.ts": "" }, (root) => {
    for (let index = 0; index < 21; index += 1) {
      writeFileSync(join(root, `src/flow/canvas/part-${index}.ts`), "");
      if (index === 12) {
        const budget = checkBudget(root);
        expect(budget.reports).toContain(
          "area flow/canvas has 13 direct entries (report at 12, fail at 20)",
        );
        expect(budget.failures).toEqual([]);
      }
    }
    expect(checkBudget(root).failures).toContain(
      "area flow/canvas has 21 direct entries (report at 12, fail at 20)",
    );
    STRUCTURE_EXCEPTIONS.push({
      path: "flow/canvas",
      owner: "@test",
      expires: "2026-12-31",
      reason: "fixture",
    });
    try {
      expect(checkBudget(root).failures).toEqual([]);
    } finally {
      STRUCTURE_EXCEPTIONS.pop();
    }
  });
});

test("Phase 5 turns the area findings into failures", () => {
  withTree(tree, (root) => {
    const previous = { ...ENFORCEMENT };
    ENFORCEMENT.areas = true;
    ENFORCEMENT.nativeSeam = true;
    ENFORCEMENT.unclassified = true;
    try {
      const result = runStructureCheck(root);
      expect(result.failures).toContain(
        "area flow/document is missing its src/flow/document/index.ts facade",
      );
      expect(result.failures).toContain('forbidden folder "utils" in src/flow/utils/thing.ts');
      expect(result.failures).toContain("unclassified module: src/flow/utils/thing.ts");
      expect(result.failures).toContain("unclassified module: src/flow/index.ts");
      expect(result.failures).not.toContain(
        "src/flow/document/interaction/controller.ts (interaction) may not import src/flow/document/session/y.ts",
      );
      expect(result.failures).not.toContain(
        "src/flow/bindings.ts may not import flow/canvas (./canvas)",
      );
      expect(result.failures).toContain(
        "src/flow/document/session/deep.ts deep-imports flow/canvas (../../canvas/model/camera)",
      );
      expect(result.failures).toContain(
        "src/components/search/SearchPalette.tsx may not import flow/canvas (../../flow/canvas)",
      );
      expect(result.failures).toContain(
        "src/flow/canvas/geometry/point.ts (geometry) may not import src/flow/canvas/model/camera.ts",
      );
      expect(result.failures).toContain(
        "src/components/canvas/helper.ts imports @flow/native outside the document seam",
      );
      expect(result.failures).toContain(
        "src/components/canvas/type-only.ts imports @flow/native outside the document seam",
      );
    } finally {
      Object.assign(ENFORCEMENT, previous);
    }
  });
});

test("reports stale legacy allow-list entries so the list shrinks", () => {
  // The list is empty after the page move; synthetic entries keep both
  // branches of the report covered.
  const present = "src/components/kept.tsx";
  const absent = "src/components/gone.tsx";
  LEGACY_FLAT.add(present);
  LEGACY_FLAT.add(absent);
  try {
    expect(checkLegacyAllowList([present])).toEqual([`stale legacy allow-list entry: ${absent}`]);
  } finally {
    LEGACY_FLAT.delete(present);
    LEGACY_FLAT.delete(absent);
  }
});

test("keeps the legacy allow-list and the Rust report non-failing", () => {
  // The list is empty after the page move; the fixture restores its semantics.
  LEGACY_FLAT.add("src/flow/page-chrome.ts");
  try {
    withTree(
      {
        ...tree,
        "src/native/src/extra.rs": "",
      },
      (root) => {
        const files = collectSourceFiles(root);
        expect(files).toContain("src/pages/FlowPage.tsx");
        expect(files).toContain("src/flow/page-chrome.ts");
        expect(checkRustLayout(root)).toEqual([
          "Rust module at the crate root: src/native/src/extra.rs",
        ]);
        expect(checkUnclassified(files)).not.toContain(
          "unclassified module: src/flow/page-chrome.ts",
        );
      },
    );
  } finally {
    LEGACY_FLAT.delete("src/flow/page-chrome.ts");
  }
});
