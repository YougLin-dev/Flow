import { expect, test } from "nsh/test";
import { fakeProjectStore, listedProject } from "../../test-support/fake-project-store";
import { createProjectsHome } from "./projects-home";

const LISTED = listedProject("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

/** Lets the home's quiet re-reads and pending loads finish. */
async function settle(depth = 20): Promise<void> {
  if (depth === 0) return;
  await Promise.resolve();
  return settle(depth - 1);
}

test("a foreground revalidation keeps the visible list on failure", async () => {
  let calls = 0;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        listProjects: async () => {
          calls += 1;
          // The home's constructor starts one load; the explicit refresh is
          // the second. Only the revalidation that follows fails.
          if (calls > 2) throw new Error("the projects directory could not be read");
          return [LISTED];
        },
      }),
  });
  await home.refresh();
  expect(home.projects().map((project) => project.title)).toEqual(["Listed"]);

  await home.revalidate();
  expect(calls).toBe(3);
  expect(home.loading()).toBe(false);
  expect(home.loadError()).toBe(null);
  expect(home.projects().map((project) => project.title)).toEqual(["Listed"]);
  home.dispose();
});

test("a foreground revalidation recovers a list whose load failed", async () => {
  let available = false;
  const home = createProjectsHome("/projects", {
    openStore: async () => {
      if (!available) throw new Error("the projects directory could not be read");
      return fakeProjectStore({ listProjects: async () => [LISTED] });
    },
  });
  await home.refresh();
  expect(home.loadError()).toBe("the projects directory could not be read");

  available = true;
  await home.revalidate();
  expect(home.loadError()).toBe(null);
  expect(home.projects().map((project) => project.title)).toEqual(["Listed"]);
  home.dispose();
});

test("a foreground revalidation does not supersede an in-flight load", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        listProjects: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return [LISTED];
        },
      }),
  });
  await home.revalidate();
  await settle();
  expect(calls).toBe(1);
  expect(home.loading()).toBe(true);

  release();
  await settle();
  expect(home.projects().map((project) => project.title)).toEqual(["Listed"]);
  home.dispose();
});
