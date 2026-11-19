import { signal } from "nsh";
import { Window } from "nsh/desktop";
import type { ProjectStorePort } from "./flow/projects";

/**
 * The app-level state behind the window registry: settings, the last
 * project's session, which windows are open and which project window each
 * one is. Signals stay private; `App.tsx` and the pages use the readers and
 * actions here. Per-window state (a project's document, canvas, selection
 * and zoom) lives in its `FlowPage`.
 */

export type StartupMode = "projects" | "lastProject";

/** What the Settings window changes. */
export interface FlowSettings {
  readonly startup: StartupMode;
}

/** The last project session, for `startup: "lastProject"` and crash recovery. */
export interface FlowSession {
  readonly projectId: string;
  readonly title: string;
  /** False while the app runs and after a crash; true once it closed cleanly. */
  readonly clean: boolean;
}

/** A project open in a window of its own. */
export interface OpenProject {
  readonly projectId: string;
  readonly title: string;
  readonly store: ProjectStorePort;
}

export interface ProjectShutdown {
  /** Saves and closes the project, releasing its lease when it can. */
  readonly shutdown: () => Promise<{ readonly closed: boolean }>;
}

export const PROJECTS_WINDOW = "projects";
export const SETTINGS_WINDOW = "settings";
export const DOCUMENT_WINDOW = "document";

export function projectWindowId(projectId: string): string {
  return `project:${projectId}`;
}

const settings = signal<FlowSettings>({ startup: "projects" });
const session = signal<FlowSession | null>(null);
const ready = signal(false);
const projectsOpen = signal(true);
const settingsOpen = signal(false);
const newProject = signal(false);
const projectWindows = signal<OpenProject[]>([]);
let quitting = false;
/** The saved-and-closed callback of each project window, by project id. */
const shutdowns = new Map<string, ProjectShutdown>();

export const appSettings = (): FlowSettings => settings();
export const appSession = (): FlowSession | null => session();
/** Whether the app read its settings and session from Storage. */
export const appReady = (): boolean => ready();
export const projectsWindowOpen = (): boolean => projectsOpen();
export const settingsWindowOpen = (): boolean => settingsOpen();
/** The app-level New shortcut asked for the create dialog. */
export const newProjectRequested = (): boolean => newProject();
export const openProjectWindows = (): OpenProject[] => projectWindows();
export const isQuitting = (): boolean => quitting;

export function setAppSettings(next: FlowSettings): void {
  settings.set(next);
}

export function setAppSession(next: FlowSession | null): void {
  session.set(next);
}

export function renameProjectWindow(projectId: string, title: string): void {
  projectWindows.update((open) =>
    open.map((project) => (project.projectId === projectId ? { ...project, title } : project)),
  );
  const current = session();
  if (current !== null && current.projectId === projectId) {
    setAppSession({ ...current, title });
  }
}

export function setAppReady(): void {
  ready.set(true);
}

export function showProjectsWindow(): void {
  projectsOpen.set(true);
  Window.get(PROJECTS_WINDOW)?.focus();
}

export function hideProjectsWindow(): void {
  projectsOpen.set(false);
}

export function showSettingsWindow(): void {
  settingsOpen.set(true);
  Window.get(SETTINGS_WINDOW)?.focus();
}

/** Shows Projects and asks it for the create dialog (the app's New). */
export function requestNewProject(): void {
  showProjectsWindow();
  newProject.set(true);
}

export function clearNewProjectRequest(): void {
  newProject.set(false);
}

export function hideSettingsWindow(): void {
  settingsOpen.set(false);
}

/**
 * Opens `project` in its window, closing the Projects window. A project
 * already open comes forward instead, and Projects stays as it is: the row
 * is a way back to work that is already on screen.
 */
export function openProjectWindow(project: OpenProject): void {
  // A quit in flight owns every window it found; one opened now would escape
  // its shutdown pass.
  if (quitting) return;
  if (projectWindows().some((open) => open.projectId === project.projectId)) {
    focusProjectWindow(project.projectId);
    return;
  }
  projectWindows.update((open) => [...open, project]);
  hideProjectsWindow();
  setAppSession({ projectId: project.projectId, title: project.title, clean: false });
}

export function focusProjectWindow(projectId: string): void {
  Window.get(projectWindowId(projectId))?.focus();
}

/**
 * Forgets a project window; the last one opens the Projects window again.
 * `clean` says the workspace saved and closed its package, which is what
 * makes `startup: "lastProject"` open this project next time.
 */
export function closeProjectWindow(projectId: string, clean = false): void {
  const closing = projectWindows().find((project) => project.projectId === projectId);
  shutdowns.delete(projectId);
  let last = false;
  projectWindows.update((open) => {
    const next = open.filter((project) => project.projectId !== projectId);
    last = next.length === 0;
    return next;
  });
  // The last project closed is the session's, and a run with no window left
  // is clean only when that window's document saved and released. While
  // another project window stays open, the session follows an open window
  // and stays unclean: a crash must offer the project that was still open,
  // not one this run already closed.
  if (last) {
    if (closing !== undefined) {
      setAppSession({
        projectId: closing.projectId,
        title: closing.title,
        clean,
      });
    }
  } else {
    const open = projectWindows().at(-1);
    if (open !== undefined) {
      setAppSession({ projectId: open.projectId, title: open.title, clean: false });
    }
  }
  if (last && !quitting) showProjectsWindow();
}

/** A project window's workspace, for the app-level quit coordinator. */
export function registerProjectShutdown(projectId: string, shutdown: ProjectShutdown): void {
  shutdowns.set(projectId, shutdown);
}

export function unregisterProjectShutdown(projectId: string): void {
  shutdowns.delete(projectId);
}

export function setQuitting(value = true): void {
  quitting = value;
}

/**
 * Saves and closes every open project; the app quits once they settled.
 * `clean` is false if any close failed; `project` is the project window the
 * session keeps (the last one open when the quit began), so a run with
 * several windows records the right project.
 */
export async function shutdownAllProjects(): Promise<{
  readonly clean: boolean;
  readonly project: { readonly projectId: string; readonly title: string } | null;
}> {
  const open = projectWindows();
  const sessions = [...shutdowns.values()];
  // A failed close must not skip the others: every window gets its save
  // attempt before the app quits.
  const results = await Promise.allSettled(sessions.map((project) => project.shutdown()));
  const last = open.at(-1) ?? null;
  return {
    clean: results.every((result) => result.status === "fulfilled" && result.value.closed),
    project: last === null ? null : { projectId: last.projectId, title: last.title },
  };
}
