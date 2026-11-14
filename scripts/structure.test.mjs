import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkFacades,
  checkForbiddenFolders,
  checkRustLayout,
  checkTestSupportImports,
  checkUnclassified,
  collectSourceFiles,
  resolveImport,
  runStructureCheck,
} from "./structure.mjs";

/** Creates a temporary project tree and cleans it up after the callback. */
function withTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), "flow-structure-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const tree = {
  "src/.nsh/generated.ts": "",
  "src/native/src/db.rs": "",
  "src/flow/scene.ts": "",
  "src/flow/new.ts": "",
  "src/flow/utils/thing.ts": "",
  "src/flow/document/session/session.ts": 'import "../test/helper";',
  "src/flow/document/test/helper.ts": "",
  "src/components/canvas/index.ts": "",
  "src/components/canvas/helper.ts": "",
  "src/components/Widget.tsx": "",
  "src/pages/FlowPage.tsx": "",
};

test("collects app modules but skips generated and Rust folders", () => {
  withTree(tree, (root) => {
    const files = collectSourceFiles(root);
    expect(files).toContain("src/flow/scene.ts");
    expect(files).toContain("src/components/canvas/index.ts");
    expect(files).not.toContain("src/.nsh/generated.ts");
    expect(files).not.toContain("src/native/src/db.rs");
  });
});

test("resolves exact files, extensions and directory indexes", () => {
  withTree(tree, (root) => {
    expect(resolveImport(root, "src/components/Widget.tsx", "../flow/scene")).toBe(
      "src/flow/scene.ts",
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
    const files = collectSourceFiles(root);
    const result = runStructureCheck(root);
    expect(result.failures).toContain("new flat module at the flow/ root: src/flow/new.ts");
    expect(result.failures).toContain(
      "new flat module at the components/ root: src/components/Widget.tsx",
    );
    expect(checkFacades(root, files)).toContain(
      "area flow/document is missing its src/flow/document/index.ts facade",
    );
    expect(checkForbiddenFolders(files)).toContain(
      'forbidden folder "utils" in src/flow/utils/thing.ts',
    );
    expect(checkUnclassified(files)).toContain("unclassified module: src/flow/utils/thing.ts");
  });
});

test("fails a production import of test support and allows test code to import it", () => {
  withTree(tree, (root) => {
    const files = collectSourceFiles(root);
    expect(checkTestSupportImports(root, files)).toEqual([
      "src/flow/document/session/session.ts imports test support (../test/helper)",
    ]);
  });
});

test("keeps the legacy allow-list and the Rust report non-failing", () => {
  withTree(
    {
      ...tree,
      "src/native/src/extra.rs": "",
    },
    (root) => {
      const files = collectSourceFiles(root);
      expect(files).toContain("src/pages/FlowPage.tsx");
      expect(checkRustLayout(root)).toEqual([
        "Rust module at the crate root: src/native/src/extra.rs",
      ]);
      expect(checkUnclassified(files)).not.toContain("unclassified module: src/flow/scene.ts");
    },
  );
});
