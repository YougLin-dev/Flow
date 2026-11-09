import { expect, test } from "bun:test";
import { join } from "node:path";
import { canImport, layerOf, noUpwardImport } from "./boundaries";

/** Runs the rule on one import in a fake file and returns its reports. */
function reportsFor(relativeFile, source) {
  const cwd = process.cwd();
  const reports = [];
  const context = {
    cwd,
    filename: join(cwd, relativeFile),
    report: (report) => reports.push(report),
  };
  const visitors = noUpwardImport.create(context);
  visitors.ImportDeclaration({ source: { type: "Literal", value: source } });
  return reports;
}

test("classifies files and bare directory imports", () => {
  expect(layerOf("src/App.tsx")).toBe("shell");
  expect(layerOf("src/pages/FlowPage.tsx")).toBe("page");
  expect(layerOf("src/pages")).toBe("page");
  expect(layerOf("src/components/TitleBar.tsx")).toBe("component");
  expect(layerOf("src/components")).toBe("component");
  expect(layerOf("src/store.ts")).toBe("store");
  expect(layerOf("src/tool.ts")).toBe("type");
  expect(layerOf("src/flow/scene.ts")).toBe("foundation");
  expect(layerOf("src/lib/window-chrome.ts")).toBe("foundation");
  expect(layerOf("src/native")).toBe("foundation");
  expect(layerOf("src/native/src/db.rs")).toBe("foundation");
  expect(layerOf("src/assets/icon.png")).toBe("asset");
  expect(layerOf("src/unclassified/module.ts")).toBe("other");
});

test("allows only downward imports", () => {
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

test("reports an upward import and a bare directory target", () => {
  const reports = reportsFor("src/components/Card.tsx", "../pages/FlowPage");
  expect(reports).toHaveLength(1);
  expect(reports[0].messageId).toBe("upward");

  const bare = reportsFor("src/components/Card.tsx", "../pages");
  expect(bare).toHaveLength(1);
  expect(bare[0].messageId).toBe("upward");
});

test("fails closed on an unclassified target", () => {
  const reports = reportsFor("src/pages/FlowPage.tsx", "../unclassified/module");
  expect(reports).toHaveLength(1);
  expect(reports[0].messageId).toBe("unknown");
});

test("fails closed when the importing module is unclassified", () => {
  const reports = reportsFor("src/unclassified/module.ts", "../components/TitleBar");
  expect(reports).toHaveLength(1);
  expect(reports[0].messageId).toBe("unclassified");
});

test("does not report an allowed import", () => {
  expect(reportsFor("src/pages/FlowPage.tsx", "../components/TitleBar")).toEqual([]);
  expect(reportsFor("src/pages/FlowPage.tsx", "../components")).toEqual([]);
  expect(reportsFor("src/components/FlowCanvas.tsx", "../flow/selection")).toEqual([]);
});
