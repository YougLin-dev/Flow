import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  deepCrossFeature,
  forbiddenArea,
  nativeOutsideSeam,
  noUpwardImport,
  resolveProjectImport,
  segmentDirection,
  testSupportInProduction,
  unclassifiedSource,
} from "./boundaries";
import {
  ENFORCEMENT,
  LEGACY_FLAT,
  areaOf,
  canImport,
  isFacade,
  layerOf,
  segmentOf,
} from "./structure-map";
import { withTree } from "./test-tree";

const cwd = process.cwd();

/** Runs one import through a rule in a fake file and returns its reports. */
function reportsForRule(rule, relativeFile, source, root = cwd, visitor = "ImportDeclaration") {
  const reports = [];
  const context = {
    cwd: root,
    filename: join(root, relativeFile),
    report: (report) => reports.push(report),
  };
  const visitors = rule.create(context);
  visitors[visitor]?.({ source: { type: "Literal", value: source } });
  return reports;
}

function reportsFor(relativeFile, source) {
  return reportsForRule(noUpwardImport, relativeFile, source);
}

/** Turns the Phase 5 area rules on only for one test. */
function withAreas(run) {
  const previous = { ...ENFORCEMENT };
  ENFORCEMENT.areas = true;
  ENFORCEMENT.nativeSeam = true;
  ENFORCEMENT.unclassified = true;
  try {
    return run();
  } finally {
    Object.assign(ENFORCEMENT, previous);
  }
}

const areaTree = {
  "src/flow/canvas/index.ts": "",
  "src/flow/canvas/model/camera.ts": "",
  "src/flow/canvas/model/scene/scene.ts": "",
  "src/flow/canvas/interaction/canvas-controller.ts": "",
  "src/flow/canvas/geometry/connection.ts": "",
  "src/flow/canvas/geometry/edge-clip.ts": "",
  "src/flow/canvas/port-visuals.ts": "",
  "src/flow/document/index.ts": "",
  "src/flow/document/session/session.ts": "",
  "src/flow/document/session/harness.ts": "",
  "src/flow/document/session/y.ts": "",
  "src/flow/document/model/x.ts": "",
  "src/flow/document/interaction/controller.ts": "",
  "src/flow/document/test/helper.ts": "",
  "src/test-support/app.ts": "",
  "src/flow/nodes/index.ts": "",
  "src/flow/nodes/node-kinds.ts": "",
  "src/flow/shared/index.ts": "",
  "src/flow/shared/native-types.ts": "",
  "src/components/canvas/index.ts": "",
  "src/components/canvas/world/Card.tsx": "",
  "src/components/search/index.ts": "",
  "src/components/search/SearchPalette.tsx": "",
  "src/pages/flow/index.ts": "",
  "src/pages/flow/FlowPage.tsx": "",
  "src/App.tsx": "",
};

test("classifies layers, including test support", () => {
  expect(layerOf("src/App.tsx")).toBe("shell");
  expect(layerOf("src/pages/FlowPage.tsx")).toBe("page");
  expect(layerOf("src/pages")).toBe("page");
  expect(layerOf("src/components/TitleBar.tsx")).toBe("component");
  expect(layerOf("src/store.ts")).toBe("store");
  expect(layerOf("src/flow/page-chrome.ts")).toBe("foundation");
  expect(layerOf("src/native/src/db.rs")).toBe("foundation");
  expect(layerOf("src/assets/icon.png")).toBe("asset");
  expect(layerOf("src/test-support/app.ts")).toBe("test");
  expect(layerOf("src/flow/document/test/helper.ts")).toBe("test");
  expect(layerOf("src/tool.ts")).toBe("other");
  expect(layerOf("src/unclassified/module.ts")).toBe("other");
});

test("resolves .tsx, .js, .jsx and both index spellings", () => {
  withTree(
    {
      "src/a/index.tsx": "",
      "src/a/b.js": "",
      "src/a/c.jsx": "",
      "src/a/d.tsx": "",
      "src/a/e/f.ts": "",
    },
    (root) => {
      const from = join(root, "src/a/d.tsx");
      expect(resolveProjectImport(root, from, ".")).toBe("src/a/index.tsx");
      expect(resolveProjectImport(root, from, "./b")).toBe("src/a/b.js");
      expect(resolveProjectImport(root, from, "./c")).toBe("src/a/c.jsx");
      expect(resolveProjectImport(root, from, "./e/f")).toBe("src/a/e/f.ts");
      expect(resolveProjectImport(root, from, "./e")).toBeNull();
    },
  );
});

test("allows only downward layer imports", () => {
  expect(canImport("shell", "page")).toBe(true);
  expect(canImport("page", "component")).toBe(true);
  expect(canImport("page", "store")).toBe(true);
  expect(canImport("component", "page")).toBe(false);
  expect(canImport("component", "store")).toBe(false);
  expect(canImport("component", "foundation")).toBe(true);
  expect(canImport("store", "component")).toBe(false);
  expect(canImport("foundation", "store")).toBe(false);
  expect(canImport("foundation", "page")).toBe(false);
  expect(canImport("other", "page")).toBe(false);
});

test("classifies files and bare directory imports", () => {
  expect(noUpwardImport).toBeDefined();
  expect(areaOf("src/flow/canvas/model/scene/scene.ts")).toBe("flow/canvas");
  expect(areaOf("src/flow/canvas")).toBe("flow/canvas");
  expect(areaOf("src/flow/page-chrome.ts")).toBeNull();
  expect(areaOf("src/flow/search-filters.ts")).toBeNull();
  expect(areaOf("src/flow/execution/index.ts")).toBe("flow/execution");
  expect(areaOf("src/flow/minimap/index.ts")).toBe("flow/minimap");
  expect(areaOf("src/components/canvas/world/Card.tsx")).toBe("components/canvas");
  expect(areaOf("src/components/FlowCard.tsx")).toBeNull();
  expect(areaOf("src/pages/flow/FlowPage.tsx")).toBe("pages/flow");
  expect(areaOf("src/pages/FlowPage.tsx")).toBeNull();
  expect(areaOf("src/App.tsx")).toBe("shell");
  expect(segmentOf("src/flow/canvas/model/scene/scene.ts")).toBe("model");
  expect(segmentOf("src/flow/canvas/index.ts")).toBeNull();
  expect(isFacade("src/flow/canvas/index.ts")).toBe(true);
  expect(isFacade("src/flow/canvas/model/camera.ts")).toBe(false);
  expect(isFacade("src/store.ts")).toBe(true);
  expect(isFacade("src/App.tsx")).toBe(true);
});

test("keeps a legacy path unclassified even when it shares an area name", () => {
  // No real module collides with an area after the Phase 2 moves; insert one
  // for the duration of the check so the allow-list precedence stays covered.
  const path = "src/flow/canvas.ts";
  LEGACY_FLAT.add(path);
  try {
    expect(areaOf(path)).toBeNull();
  } finally {
    LEGACY_FLAT.delete(path);
  }
});

test("resolves exact files, extensions and directory indexes", () => {
  withTree(areaTree, (root) => {
    const from = join(root, "src/components/canvas/world/Card.tsx");
    expect(resolveProjectImport(root, from, "../../../flow/canvas")).toBe(
      "src/flow/canvas/index.ts",
    );
    expect(resolveProjectImport(root, from, "../../../flow/canvas/model/camera")).toBe(
      "src/flow/canvas/model/camera.ts",
    );
    expect(resolveProjectImport(root, from, "../../../flow/missing")).toBeNull();
  });
});

test("reports upward, unknown and unclassified imports", () => {
  expect(reportsFor("src/components/Card.tsx", "../pages/FlowPage")).toHaveLength(1);
  expect(reportsFor("src/components/Card.tsx", "../pages/FlowPage")[0].messageId).toBe("upward");
  expect(reportsFor("src/components/Card.tsx", "../pages")).toHaveLength(1);
  expect(reportsFor("src/pages/FlowPage.tsx", "../unclassified/module")[0].messageId).toBe(
    "unknown",
  );
  expect(reportsFor("src/unclassified/module.ts", "../components/TitleBar")[0].messageId).toBe(
    "unclassified",
  );
  expect(reportsFor("src/pages/FlowPage.tsx", "../components/TitleBar")).toEqual([]);
  expect(reportsFor("src/components/FlowCanvas.tsx", "../flow/canvas/geometry/selection")).toEqual(
    [],
  );
});

test("reports a deep cross-area import but allows facades and same-feature deep imports", () => {
  withTree(areaTree, (root) =>
    withAreas(() => {
      const deep = reportsForRule(
        deepCrossFeature,
        "src/flow/document/session/session.ts",
        "../../canvas/model/camera",
        root,
      );
      expect(deep.map((report) => report.messageId)).toEqual(["deep"]);

      const facade = reportsForRule(
        deepCrossFeature,
        "src/flow/document/session/session.ts",
        "../../canvas",
        root,
      );
      expect(facade).toEqual([]);

      const sameFeature = reportsForRule(
        deepCrossFeature,
        "src/components/canvas/world/Card.tsx",
        "../../../flow/canvas/model/camera",
        root,
      );
      expect(sameFeature).toEqual([]);

      const page = reportsForRule(
        deepCrossFeature,
        "src/pages/flow/FlowPage.tsx",
        "../../flow/canvas/model/camera",
        root,
      );
      expect(page).toEqual([]);
    }),
  );
});

test("reports an area pair missing from the matrix", () => {
  withTree(areaTree, (root) =>
    withAreas(() => {
      const reports = reportsForRule(
        forbiddenArea,
        "src/components/search/SearchPalette.tsx",
        "../../flow/canvas",
        root,
      );
      expect(reports.map((report) => report.messageId)).toEqual(["forbidden"]);
    }),
  );
});

test("enforces the shell and allowed-area rows", () => {
  withTree(areaTree, (root) =>
    withAreas(() => {
      expect(
        reportsForRule(forbiddenArea, "src/App.tsx", "./components/search", root).map(
          (report) => report.messageId,
        ),
      ).toEqual(["forbidden"]);
      expect(reportsForRule(forbiddenArea, "src/App.tsx", "./pages/flow", root)).toEqual([]);
      expect(
        reportsForRule(
          forbiddenArea,
          "src/components/canvas/world/Card.tsx",
          "../../../flow/canvas",
          root,
        ),
      ).toEqual([]);
    }),
  );
});

test("keeps geometry pure and model/interaction view-free", () => {
  withTree(areaTree, (root) =>
    withAreas(() => {
      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/canvas/geometry/connection.ts",
          "../model/camera",
          root,
        ).map((report) => report.messageId),
      ).toEqual(["segment"]);

      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/canvas/model/scene/scene.ts",
          "../../interaction/canvas-controller",
          root,
        ).map((report) => report.messageId),
      ).toEqual(["segment"]);

      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/canvas/model/scene/scene.ts",
          "../../../shared",
          root,
        ),
      ).toEqual([]);

      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/canvas/geometry/connection.ts",
          "../../nodes/node-kinds",
          root,
        ).map((report) => report.messageId),
      ).toEqual(["segment"]);

      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/canvas/geometry/connection.ts",
          "../port-visuals",
          root,
        ).map((report) => report.messageId),
      ).toEqual(["segment"]);

      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/canvas/geometry/connection.ts",
          "./edge-clip",
          root,
        ),
      ).toEqual([]);

      expect(
        reportsForRule(
          forbiddenArea,
          "src/flow/canvas/interaction/canvas-controller.ts",
          "../../document",
          root,
        ).map((report) => report.messageId),
      ).toEqual(["forbidden"]);

      expect(
        reportsForRule(segmentDirection, "src/flow/document/model/x.ts", "../session/y", root),
      ).toEqual([]);

      expect(
        reportsForRule(
          segmentDirection,
          "src/flow/document/interaction/controller.ts",
          "../session/y",
          root,
        ),
      ).toEqual([]);
    }),
  );
});

test("reports production imports of test support", () => {
  withTree(areaTree, (root) => {
    expect(
      reportsForRule(
        testSupportInProduction,
        "src/flow/document/session/session.ts",
        "../test/helper",
        root,
      ).map((report) => report.messageId),
    ).toEqual(["testSupport"]);

    expect(
      reportsForRule(
        testSupportInProduction,
        "src/flow/document/test/helper.ts",
        "../session/session",
        root,
      ),
    ).toEqual([]);

    expect(
      reportsForRule(
        testSupportInProduction,
        "src/flow/document/session/harness.ts",
        "../../../test-support/app",
        root,
      ).map((report) => report.messageId),
    ).toEqual(["testSupport"]);
  });
});

test("confines the native module to flow/document and the type seam", () => {
  withTree(areaTree, (root) =>
    withAreas(() => {
      expect(
        reportsForRule(nativeOutsideSeam, "src/components/FlowCard.tsx", "@flow/native", root),
      ).toHaveLength(1);
      expect(
        reportsForRule(
          nativeOutsideSeam,
          "src/components/FlowCard.tsx",
          "@flow/native",
          root,
          "ExportNamedDeclaration",
        ),
      ).toHaveLength(1);
      expect(
        reportsForRule(
          nativeOutsideSeam,
          "src/components/FlowCard.tsx",
          "@flow/native",
          root,
          "ImportExpression",
        ),
      ).toHaveLength(1);
      expect(
        reportsForRule(
          nativeOutsideSeam,
          "src/flow/document/session/session.ts",
          "@flow/native",
          root,
        ),
      ).toEqual([]);
      expect(
        reportsForRule(nativeOutsideSeam, "src/flow/shared/native-types.ts", "@flow/native", root),
      ).toEqual([]);
    }),
  );
});

test("reports an unclassified source module but keeps the legacy allow-list", () => {
  withTree(areaTree, (root) =>
    withAreas(() => {
      const reports = [];
      const context = {
        cwd: root,
        filename: join(root, "src/widgets/Widget.ts"),
        report: (report) => reports.push(report),
      };
      const visitors = unclassifiedSource.create(context);
      visitors.Program({});
      expect(reports.map((report) => report.messageId)).toEqual(["unclassified"]);

      const legacy = [];
      const legacyContext = {
        cwd,
        filename: join(cwd, "src/flow/page-chrome.ts"),
        report: (report) => legacy.push(report),
      };
      const legacyVisitors = unclassifiedSource.create(legacyContext);
      legacyVisitors.Program?.({});
      expect(legacy).toEqual([]);

      const rootIndex = [];
      const rootIndexContext = {
        cwd: root,
        filename: join(root, "src/components/index.ts"),
        report: (report) => rootIndex.push(report),
      };
      unclassifiedSource.create(rootIndexContext).Program({});
      expect(rootIndex.map((report) => report.messageId)).toEqual(["unclassified"]);
    }),
  );
});
