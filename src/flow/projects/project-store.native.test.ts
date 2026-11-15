import { expect, test } from "nsh/test";
import {
  PROJECT_ALREADY_OPEN,
  PROJECT_OPEN_ELSEWHERE,
  PROJECT_OPEN_HERE,
  errorMessage,
  openProjectStore,
  type ProjectStorePort,
} from "./index";

/**
 * A fixed real root per test, under the dev data directory. The test host
 * grants no `fs` capability, so cleanup goes through the store: every test
 * starts by listing and deleting whatever a previous run left. The empty
 * root (catalog + locks) itself is inert and reused.
 */
function testRoot(name: string): string {
  return `${process.dataDir ?? ".nsh"}/project-store-test-${name}`;
}

async function clearStore(store: ProjectStorePort): Promise<void> {
  const entries = await store.listProjects();
  await Promise.all(entries.map((entry) => store.deleteProject(entry.projectId)));
}

async function freshStore(name: string): Promise<ProjectStorePort> {
  const store = await openProjectStore(testRoot(name));
  await clearStore(store);
  return store;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error("expected the call to fail");
}

test("creates, lists, leases and releases projects", async () => {
  const store = await freshStore("create-list-lease");
  expect(await store.listProjects()).toEqual([]);
  const first = await store.createProject("First", null);
  expect(first.projectId.length).toBe(32);
  expect(first.title).toBe("First");
  expect(first.unreadable).toBe(false);
  const second = await store.createProject("Second", null);
  expect(second.projectId).not.toBe(first.projectId);

  let entries = await store.listProjects();
  expect(entries.length).toBe(2);
  expect(entries.every((entry) => !entry.openHere && !entry.openElsewhere)).toBe(true);

  const lease = await store.openProject(first.projectId);
  expect(lease.projectId).toBe(first.projectId);
  expect(lease.databasePath.endsWith("project.db")).toBe(true);
  expect(await rejection(store.openProject(first.projectId))).toBe(PROJECT_OPEN_HERE);
  expect(await rejection(store.openProject(second.projectId))).toBe(PROJECT_ALREADY_OPEN);

  entries = await store.listProjects();
  const active = entries.find((entry) => entry.projectId === first.projectId);
  expect(active?.openHere).toBe(true);
  expect(active?.openElsewhere).toBe(false);

  lease.release();
  lease.release();
  const next = await store.openProject(second.projectId);
  next.release();
  await clearStore(store);
});

test("a second store sees a held package as open elsewhere", async () => {
  const store = await freshStore("open-elsewhere");
  const other = await openProjectStore(testRoot("open-elsewhere"));
  const created = await store.createProject("Held", null);
  const lease = await store.openProject(created.projectId);
  try {
    expect(await rejection(other.openProject(created.projectId))).toBe(PROJECT_OPEN_ELSEWHERE);
    const entries = await other.listProjects();
    expect(entries.length).toBe(1);
    expect(entries[0]?.openHere).toBe(false);
    expect(entries[0]?.openElsewhere).toBe(true);
  } finally {
    lease.release();
  }
  const reopened = await other.openProject(created.projectId);
  reopened.release();
  await clearStore(store);
});

test("renames, refreshes, deletes and reports exact errors", async () => {
  const store = await freshStore("rename-refresh-delete");
  const created = await store.createProject("Before", null);
  const renamed = await store.renameProject(created.projectId, "After");
  expect(renamed.title).toBe("After");

  const refreshed = await store.refreshCatalog();
  expect(refreshed.length).toBe(1);
  expect(refreshed[0]?.title).toBe("After");

  await store.deleteProject(created.projectId);
  expect(await store.listProjects()).toEqual([]);

  expect(await rejection(store.openProject("../escape"))).toBe("the project id is invalid");
  const missing = await rejection(store.openProject(created.projectId));
  expect(missing.includes("has no Flow database")).toBe(true);
  const missingDelete = await rejection(store.deleteProject("0123456789abcdef0123456789abcdef"));
  expect(missingDelete.includes("has no Flow database")).toBe(true);
});
