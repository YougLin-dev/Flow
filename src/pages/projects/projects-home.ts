/**
 * The projects screen's state: the managed store, the list it loads, and the
 * project this window currently shows. The shell creates one home for the
 * app's lifetime; the canvas's lease and document stay owned by the flow
 * workspace, so this layer only decides which project the shell shows.
 *
 * The store opens once per launch (a retry after a failure reopens it). The
 * list is a snapshot of the derived catalog: it refreshes after an action
 * and when the user returns from a project, never on a timer.
 */
import { announce, signal } from "nsh";
import type { ProjectEntry } from "../../flow/shared";
import {
  errorMessage,
  isAnotherProjectOpen,
  isProjectOpenElsewhere,
  isProjectOpenHere,
  openProjectStore,
  projectControlName,
  sortProjects,
  type ProjectStorePort,
} from "../../flow/projects";

/** The project the shell shows in the canvas. */
export interface ActiveProject {
  readonly projectId: string;
  readonly title: string;
}

/** What the flow workspace needs to lease and open the project. */
export interface OpenProjectDescriptor extends ActiveProject {
  readonly store: ProjectStorePort;
}

/** A project action whose dialog can outlive a dismissal. */
export type ProjectAction = "create" | "rename" | "duplicate" | "delete" | "import";

/** The copy in front of a stored action error, inline and above the list. */
export const PROJECT_ACTION_FAILURE: Record<ProjectAction, string> = {
  create: "Couldn’t create the project.",
  rename: "Couldn’t rename the project.",
  duplicate: "Couldn’t duplicate the project.",
  delete: "Couldn’t delete the project.",
  import: "Couldn’t import the project.",
};

export interface ProjectsHomeOptions {
  /** Opens the FFI store; tests inject a fake. */
  readonly openStore?: (root: string) => Promise<ProjectStorePort>;
}

export interface ProjectsHome {
  /** The projects to list, in the frozen order. */
  projects(): ProjectEntry[];
  /** Whether the first load (or a retry) is in flight. */
  loading(): boolean;
  /** Why the list could not load; cleared by a retry. */
  loadError(): string | null;
  /** Why the last open or create could not start, shown above the list. */
  actionError(): string | null;
  /** The project the canvas should open, or null on the projects screen. */
  current(): OpenProjectDescriptor | null;
  /** Reloads the list; a failed store open is retried on the next call. */
  refresh(): Promise<void>;
  /** Shows a project, or explains why it cannot open. */
  open(project: ProjectEntry): void;
  /**
   * Creates a blank project and adds it to the list; the caller decides
   * whether to show it (a dismissed dialog must not open it). Rejects with
   * the store's message.
   */
  create(title: string): Promise<ProjectEntry>;
  /** Renames a closed project; resolves with its updated row. */
  rename(project: ProjectEntry, title: string): Promise<ProjectEntry>;
  /** Duplicates a closed project under a new identity and title. */
  duplicate(project: ProjectEntry, title: string): Promise<ProjectEntry>;
  /** Deletes a closed project's package. */
  remove(project: ProjectEntry): Promise<void>;
  /** Imports an unzipped package folder from outside the managed root. */
  importProject(source: string): Promise<ProjectEntry>;
  /** Returns from the canvas to the list; the workspace closed the project. */
  showProjects(): void;
  /** The workspace could not open the project; show the list with why. */
  reportOpenError(error: unknown): void;
  /** A dismissed dialog's action failed; show the list with why. */
  reportActionError(action: ProjectAction, error: unknown): void;
  /** Clears the action error (a dismiss or the start of another action). */
  clearActionError(): void;
  /** Stops late store results after the shell unmounts. */
  dispose(): void;
}

export function createProjectsHome(root: string, options: ProjectsHomeOptions = {}): ProjectsHome {
  const openStore = options.openStore ?? openProjectStore;
  const projects = signal<ProjectEntry[]>([]);
  const loading = signal(true);
  const loadError = signal<string | null>(null);
  const actionError = signal<string | null>(null);
  const active = signal<ActiveProject | null>(null);
  const opened = signal<ProjectStorePort | null>(null);

  let storeTask: Promise<ProjectStorePort> | null = null;
  let loadGeneration = 0;
  // The generation of the deep status read in flight, if any: a list action
  // that supersedes it starts it again, because its whole point is the row
  // that changed out of band.
  let deepReadGeneration: number | null = null;
  let disposed = false;

  const ensureStore = (): Promise<ProjectStorePort> => {
    if (storeTask === null) {
      storeTask = openStore(root).then(
        (value) => {
          if (!disposed) opened.set(value);
          return value;
        },
        (error) => {
          // A later refresh may reopen; only the open itself was refused.
          storeTask = null;
          throw error;
        },
      );
    }
    return storeTask;
  };

  const load = async (quiet: boolean, deep = false): Promise<void> => {
    const generation = ++loadGeneration;
    if (deep) {
      deepReadGeneration = generation;
    } else if (deepReadGeneration !== null) {
      // A shallow snapshot trusts cached rows, so it would hide the package
      // the deep read is checking. Keep a deep read as the one that lands.
      void load(true, true);
    }
    if (!quiet) {
      loading.set(true);
      loadError.set(null);
    }
    try {
      const store = await ensureStore();
      // A deep read reopens every package; a shallow one trusts cached
      // readable rows, so it cannot learn that a cached package broke.
      const entries = deep ? await store.refreshCatalog() : await store.listProjects();
      if (disposed || generation !== loadGeneration) return;
      projects.set(sortProjects(entries));
      loading.set(false);
    } catch (error) {
      if (disposed || generation !== loadGeneration) return;
      loading.set(false);
      if (quiet) {
        // The visible list is still usable; the action error already tells
        // the user what failed. A quiet reload never replaces it.
        console.error("Flow could not refresh its projects", error);
      } else {
        loadError.set(errorMessage(error));
      }
    } finally {
      if (deepReadGeneration === generation) deepReadGeneration = null;
    }
  };

  const refresh = (): Promise<void> => load(false);

  /**
   * Re-reads statuses after a refusal without flashing the loading state. A
   * deep re-read is for a package that changed after it was cached.
   */
  const refreshQuietly = (deep = false): void => {
    void load(true, deep);
  };

  const fail = (message: string): void => {
    actionError.set(message);
    announce(message);
  };

  const open = (project: ProjectEntry): void => {
    if (project.unreadable) {
      fail("This project can’t be opened. Its files may be damaged.");
      refreshQuietly();
      return;
    }
    if (project.openElsewhere) {
      fail(`“${project.title}” is open in another window.`);
      refreshQuietly();
      return;
    }
    if (project.openHere) {
      fail(`“${project.title}” is already open in this window.`);
      refreshQuietly();
      return;
    }
    actionError.set(null);
    active.set({ projectId: project.projectId, title: project.title });
  };

  /** Applies an action's result to the visible list. */
  const commit = (change: (list: ProjectEntry[]) => ProjectEntry[]): void => {
    // Invalidate a list read that started before this action; its snapshot
    // would drop a new row, keep a renamed one, or resurrect a deleted one.
    loadGeneration += 1;
    // A deep status read has no snapshot this action supersedes: its job is
    // the package that changed out of band, so start it again rather than
    // dropping it with the other reads.
    if (deepReadGeneration !== null) {
      deepReadGeneration = null;
      refreshQuietly(true);
    }
    loading.set(false);
    loadError.set(null);
    projects.update((list) => sortProjects(change(list)));
    actionError.set(null);
  };

  /** Replaces the row with the same identity, which also keeps a repeated
   * action from duplicating it. */
  const withEntry = (list: ProjectEntry[], entry: ProjectEntry): ProjectEntry[] => [
    ...list.filter((project) => project.projectId !== entry.projectId),
    entry,
  ];

  /**
   * Runs a store action and applies its result. A failure re-reads the
   * statuses (another window may have taken the package) and rethrows for
   * the dialog; whether the result still matters after a dismissal is the
   * caller's concern. A deep read is for actions that read the package
   * identity, whose refusal may mean the package no longer opens.
   */
  const act = async <T>(
    work: () => Promise<T>,
    applied: (value: T) => void,
    deep = false,
  ): Promise<T> => {
    try {
      const value = await work();
      if (!disposed) applied(value);
      return value;
    } catch (error) {
      if (!disposed) refreshQuietly(deep);
      throw error;
    }
  };

  const requireTitle = (rawTitle: string): string => {
    const title = rawTitle.trim();
    if (title === "") throw new Error("the project title is empty");
    return title;
  };

  const create = async (rawTitle: string): Promise<ProjectEntry> => {
    const title = requireTitle(rawTitle);
    return act(
      async () => (await ensureStore()).createProject(title, null),
      (entry) => commit((list) => withEntry(list, entry)),
    );
  };

  const rename = async (project: ProjectEntry, rawTitle: string): Promise<ProjectEntry> => {
    const title = requireTitle(rawTitle);
    return act(
      async () => (await ensureStore()).renameProject(project.projectId, title),
      (entry) => {
        commit((list) => withEntry(list, entry));
        announce(`Renamed to “${entry.title}”.`);
      },
      // The store reads the package identity; a refusal can mean it broke.
      true,
    );
  };

  const duplicate = async (project: ProjectEntry, rawTitle: string): Promise<ProjectEntry> => {
    const title = requireTitle(rawTitle);
    return act(
      async () => (await ensureStore()).duplicateProject(project.projectId, title),
      (entry) => {
        commit((list) => withEntry(list, entry));
        announce(`Duplicated as “${entry.title}”.`);
      },
      true,
    );
  };

  const remove = async (project: ProjectEntry): Promise<void> => {
    await act(
      async () => (await ensureStore()).deleteProject(project.projectId),
      () => {
        commit((list) => list.filter((candidate) => candidate.projectId !== project.projectId));
        announce(`Deleted “${projectControlName(project)}”.`);
      },
    );
  };

  /**
   * Explorer's "Copy as path" wraps a path in double quotes, which a Windows
   * path can never hold; accept the copied form rather than failing with a
   * missing-database error.
   */
  const cleanSource = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  };

  const importProject = async (rawSource: string): Promise<ProjectEntry> => {
    const source = cleanSource(rawSource);
    if (source === "") throw new Error("the project folder is empty");
    return act(
      async () => (await ensureStore()).importProject(source),
      (entry) => {
        commit((list) => withEntry(list, entry));
        announce(`Imported “${entry.title}”.`);
      },
    );
  };

  const showProjects = (): void => {
    active.set(null);
  };

  const reportOpenError = (error: unknown): void => {
    if (isProjectOpenElsewhere(error)) {
      fail("The project is open in another window.");
    } else if (isAnotherProjectOpen(error)) {
      fail("Another project is already open in this window.");
    } else if (isProjectOpenHere(error)) {
      fail("The project is already open in this window.");
    } else {
      fail(`Couldn’t open the project. ${errorMessage(error)}`);
    }
    active.set(null);
    // The row that failed was read before the other window took the lock (or
    // before the package changed). A shallow read trusts the cached row, so
    // reopen every package: a package that broke after it was cached must
    // come back as unreadable, not as a healthy row that fails every open.
    refreshQuietly(true);
  };

  const reportActionError = (action: ProjectAction, error: unknown): void => {
    fail(`${PROJECT_ACTION_FAILURE[action]} ${errorMessage(error)}`);
  };

  const current = (): OpenProjectDescriptor | null => {
    const project = active();
    const store = opened();
    if (project === null || store === null) return null;
    return { store, projectId: project.projectId, title: project.title };
  };

  const dispose = (): void => {
    disposed = true;
  };

  void refresh();

  return {
    projects,
    loading,
    loadError,
    actionError,
    current,
    refresh,
    open,
    create,
    rename,
    duplicate,
    remove,
    importProject,
    showProjects,
    reportOpenError,
    reportActionError,
    clearActionError: () => actionError.set(null),
    dispose,
  };
}
