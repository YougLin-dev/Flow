import type { App } from "nsh/test";

/** The ids of the windows showing projects, in opening order. */
export function projectWindowIds(app: App): string[] {
  return app.windowIds().filter((id) => id.startsWith("project:"));
}

/** The id of the window showing a project, or null. */
export function projectWindowId(app: App): string | null {
  return projectWindowIds(app)[0] ?? null;
}

/** Waits for a project window and returns its id. */
export async function waitForProjectWindow(app: App): Promise<string> {
  await app.waitUntil(() => projectWindowId(app) !== null);
  const id = projectWindowId(app);
  if (id === null) throw new Error("no project window is open");
  return id;
}

/** Presses window `id`'s close button and waits until it is gone. */
export async function closeWindow(app: App, id: string): Promise<void> {
  await app.window(id).pressClose();
  await app.waitUntil(() => !app.windowIds().includes(id));
}

/** Presses the project window's close button and waits for Projects back. */
export async function closeProjectWindow(app: App): Promise<void> {
  const id = await waitForProjectWindow(app);
  await closeWindow(app, id);
  await app.waitUntil(() => app.shows("id:projects-page"));
}
