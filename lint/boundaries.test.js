import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { ENFORCEMENT, areaOf, canImport, isFacade, layerOf, segmentOf } from "./structure-map";

const cwd = process.cwd();

/** Runs one import through a rule in a fake file and returns its reports. */
function reportsForRule(rule, relativeFile, source, root = cwd) {
  const reports = [];
  const context = {
    cwd: root,
    filename: join(root, relativeFile),
    report: (report) => reports.push(report),
  };
  const visitors = rule.create(context);
  visitors.ImportDeclaration({ source: { type: "Literal", value: source } });
  return reports;
}

function reportsFor(relativeFile, source) {
  return reportsForRule(noUpwardImport, relativeFile, source);
}

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
  "src/flow/document/index.ts": "",
  "src/flow/document/session/session.ts": "",
  "src/flow/document/test/helper.ts": "",
  "src/flow/shared/index.ts": "",
  "src/flow/shared/native-types.ts": "",
  "src/components/canvas/index.ts": "",
  "src/components/canvas/world/Card.tsx": "",
  "src/components/search/SearchPalette.tsx": "",
  "src/pages/flow/FlowPage.tsx": "",
};

test("classifies layers, including test support", () => {
  expect(layerOf("src/App.tsx")).toBe("shell");
  expect(layerOf("src/pages/FlowPage.tsx")).toBe("page");
  expect(layerOf("src/pages")).toBe("page");
  expect(layerOf("src/components/TitleBar.tsx")).toBe("component");
  expect(layerOf("src/store.ts")).toBe("store");
  expect(layerOf("src/flow/scene.ts")).toBe("foundation");
  expect(layerOf("src/native/src/db.rs")).toBe("foundation");
  expect(layerOf("src/assets/icon.png")).toBe("asset");
  expect(layerOf("src/test-support/app.ts")).toBe("test");
  expect(layerOf("src/flow/document/test/helper.ts")).toBe("test");
  expect(layerOf("src/tool.ts")).toBe("other");
  expect(layerOf("src/unclassified/module.ts")).toBe("other");
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
  expect(areaOf("src/flow/scene.ts")).toBeNull();
  expect(areaOf("src/components/canvas/world/Card.tsx")).toBe("components/canvas");
  expect(areaOf("src/components/FlowCard.tsx")).toBeNull();
  expect(areaOf("src/pages/flow/FlowPage.tsx")).toBe("pages/flow");
  expect(areaOf("src/pages/FlowPage.tsx")).toBeNull();
  expect(segmentOf("src/flow/canvas/model/scene/scene.ts")).toBe("model");
  expect(segmentOf("src/flow/canvas/index.ts")).toBeNull();
  expect(isFacade("src/flow/canvas/index.ts")).toBe(true);
  expect(isFacade("src/flow/canvas/model/camera.ts")).toBe(false);
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

test("allows only downward layer imports", () => {
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
  expect(reportsFor("src/components/FlowCanvas.tsx", "../flow/selection")).toEqual([]);
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
        filename: join(cwd, "src/flow/scene.ts"),
        report: (report) => legacy.push(report),
      };
      const legacyVisitors = unclassifiedSource.create(legacyContext);
      legacyVisitors.Program?.({});
      expect(legacy).toEqual([]);
    }),
  );
});
