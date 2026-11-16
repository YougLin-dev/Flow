/**
 * The projects screen: the app's entry point into the managed projects root.
 * It lists projects newest-opened first, creates, renames, duplicates,
 * deletes and imports them, and asks the shell to show one. Row status (open
 * elsewhere, unreadable) is part of the list, so the user sees it before
 * pressing; an open that still fails reports back here through the home's
 * action error.
 */
import { FolderInput, MoreHorizontal, Plus } from "lucide";
import { effect, lifecycle, List, signal, Text, token, View, wakeCount } from "nsh";
import { Button, Menu, MenuItem } from "nsh/base";
import {
  projectControlName,
  projectDisplayTitle,
  projectStatusLabel,
  projectSubtitle,
} from "../../flow/projects";
import type { ProjectEntry } from "../../flow/shared";
import { Icon } from "../../components/primitives";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { ImportProjectDialog } from "./ImportProjectDialog";
import { runProjectAction, type DialogRun, type DialogRuns } from "./project-action-run";
import { ProjectNameDialog } from "./ProjectNameDialog";
import { PROJECT_ACTION_FAILURE, type ProjectsHome } from "./projects-home";

export interface ProjectsPageProps {
  readonly home: ProjectsHome;
}

/** The dialog the page shows, at most one at a time. */
type ProjectDialog =
  | { readonly kind: "create" }
  | { readonly kind: "import" }
  | { readonly kind: "rename" | "duplicate" | "delete"; readonly project: ProjectEntry };

const OUTLINE =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
const ROW_BOX = "flex-row items-center gap-1 rounded-(--radius) bg-card pr-1 hover:bg-muted";
const ROW =
  "min-w-0 flex-1 rounded-(--radius) border border-transparent px-4 py-3 active:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
const ACTIONS =
  "size-8 items-center justify-center rounded-(--radius) text-muted-foreground hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
const MENU_POPUP = "min-w-40 rounded-(--radius) border border-border bg-popover p-1 shadow-lg";
const MENU_ITEM = "rounded-(--radius) px-2 py-1.5 hover:bg-muted focus:bg-accent active:bg-accent";

export function ProjectsPage(props: ProjectsPageProps) {
  const dialog = signal<ProjectDialog | null>(null);
  // The open row menu, keyed by project id: a `List` cell keeps no state.
  const menuFor = signal<string | null>(null);
  let dialogRun: DialogRun | null = null;
  // Relative times are a snapshot per mount: the page remounts when the user
  // returns from a project, so the list's ages refresh then, not on a timer.
  const now = Date.now();

  // The list is a snapshot of the catalog. Re-read it quietly when the app
  // returns to the foreground, or wakes while visible; there is no watcher
  // and no timer. The home's own first load covers the initial mount.
  let wasActive = lifecycle() === "active";
  let lastWake = wakeCount();
  effect(() => {
    const active = lifecycle() === "active";
    const wake = wakeCount();
    const returned = active && !wasActive;
    const woke = active && wake !== lastWake;
    wasActive = active;
    lastWake = wake;
    if (returned || woke) void props.home.revalidate();
  });

  const openProject = (project: ProjectEntry): void => {
    props.home.clearActionError();
    props.home.open(project);
  };

  const openDialog = (next: ProjectDialog): void => {
    dialogRun = { dismissed: false };
    menuFor.set(null);
    dialog.set(next);
  };

  /**
   * Opens the identity-reading actions. A menu built before a deep re-read
   * found the package unreadable still offers them; re-check the live entry
   * so a stale menu cannot start a write the store must refuse.
   */
  const beginEdit = (kind: "rename" | "duplicate", project: ProjectEntry): void => {
    if (project.unreadable) {
      menuFor.set(null);
      props.home.reportActionError(
        kind,
        new Error("the project can’t be read; its files may be damaged"),
      );
      return;
    }
    openDialog({ kind, project });
  };

  /** Closes the dialog of this run; another run's dialog stays. */
  const finishDialog = (run: DialogRun): void => {
    if (run !== dialogRun) return;
    dialogRun = null;
    dialog.set(null);
  };

  const dismissDialog = (): void => {
    if (dialogRun !== null) dialogRun.dismissed = true;
    dialogRun = null;
    dialog.set(null);
  };

  const runs: DialogRuns = {
    current: () => dialogRun,
    finish: (run) => finishDialog(run),
    reportLateError: (action, cause) => props.home.reportActionError(action, cause),
  };

  const submitCreate = async (title: string): Promise<void> => {
    await runProjectAction(
      runs,
      "create",
      () => props.home.create(title),
      (project) => props.home.open(project),
    );
  };

  const submitRename = async (project: ProjectEntry, title: string): Promise<void> => {
    await runProjectAction(
      runs,
      "rename",
      () => props.home.rename(project, title),
      () => {},
    );
  };

  const submitDuplicate = async (project: ProjectEntry, title: string): Promise<void> => {
    await runProjectAction(
      runs,
      "duplicate",
      () => props.home.duplicate(project, title),
      () => {},
    );
  };

  const submitDelete = async (project: ProjectEntry): Promise<void> => {
    await runProjectAction(
      runs,
      "delete",
      () => props.home.remove(project),
      () => {},
    );
  };

  const submitImport = async (source: string): Promise<void> => {
    await runProjectAction(
      runs,
      "import",
      () => props.home.importProject(source),
      () => {},
    );
  };

  const currentTarget = (kind: ProjectDialog["kind"]): ProjectEntry | null => {
    const current = dialog();
    return current !== null && current.kind === kind && "project" in current
      ? current.project
      : null;
  };

  // The row's name carries what it shows: a button's explicit label wins
  // over its children, so the subtitle and status would otherwise be lost
  // to a screen reader.
  const rowLabel = (project: ProjectEntry): string =>
    [projectDisplayTitle(project), projectSubtitle(project, now), projectStatusLabel(project)]
      .filter((part) => part !== "")
      .join(", ");

  return (
    <View testID="projects-page" class="min-h-0 flex-1 bg-background">
      <View class="mx-auto w-full min-h-0 max-w-3xl flex-1 gap-6 px-8 py-10">
        <View class="flex-row flex-wrap items-end justify-between gap-3">
          <View class="min-w-40 flex-1 gap-1">
            <Text class="text-xl font-semibold text-foreground">Projects</Text>
            <Text class="text-sm text-muted-foreground">Choose a project to open its canvas.</Text>
          </View>
          <View class="ml-auto shrink-0 flex-row items-center gap-2">
            <Button
              testID="import-project"
              onPress={() => openDialog({ kind: "import" })}
              class={OUTLINE}
            >
              <View class="flex-row items-center gap-1.5">
                <Icon icon={FolderInput} size={15} tint={() => token("muted-foreground")} />
                <Text class="text-sm text-card-foreground">Import project…</Text>
              </View>
            </Button>
            <Button
              testID="new-project"
              onPress={() => openDialog({ kind: "create" })}
              class={OUTLINE}
            >
              <View class="flex-row items-center gap-1.5">
                <Icon icon={Plus} size={15} tint={() => token("muted-foreground")} />
                <Text class="text-sm text-card-foreground">New project</Text>
              </View>
            </Button>
          </View>
        </View>

        {props.home.actionError() ? (
          <View
            testID="project-action-error"
            class="flex-row items-start justify-between gap-3 rounded-(--radius) border border-border bg-card px-4 py-3"
          >
            <Text class="min-w-0 flex-1 text-sm text-destructive">{props.home.actionError()}</Text>
            <Button
              testID="dismiss-project-error"
              onPress={() => props.home.clearActionError()}
              class="rounded-(--radius) px-2 py-1 text-xs text-muted-foreground hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Text class="text-xs text-muted-foreground">Dismiss</Text>
            </Button>
          </View>
        ) : null}

        {props.home.loadError() ? (
          <View
            testID="projects-load-error"
            class="gap-3 rounded-(--radius) border border-border bg-card p-4"
          >
            <View class="gap-1">
              <Text class="text-sm font-medium text-foreground">Couldn’t load projects</Text>
              <Text class="text-sm text-muted-foreground">{props.home.loadError()}</Text>
            </View>
            <View>
              <Button
                testID="retry-projects"
                onPress={() => void props.home.refresh()}
                class={OUTLINE}
              >
                <Text class="text-sm text-card-foreground">Retry</Text>
              </Button>
            </View>
          </View>
        ) : props.home.loading() ? (
          <View class="items-center py-16">
            <Text class="text-sm text-muted-foreground">Loading projects…</Text>
          </View>
        ) : (
          <List
            testID="project-list"
            each={props.home.projects()}
            keyExtractor={(project) => project.projectId}
            estimatedItemSize={68}
            class="min-h-0 flex-1"
            contentClass="gap-1"
            // A menu that scrolls away closes; its cell may be recycled, and
            // a stale open flag would reopen the menu when the row returned.
            onScroll={() => menuFor.set(null)}
            empty={
              <View class="items-center gap-1 px-6 py-16">
                <Text class="text-sm font-medium text-foreground">No projects yet</Text>
                <Text class="text-sm text-muted-foreground">
                  Create a project to start a canvas.
                </Text>
              </View>
            }
          >
            {(project) => (
              <View class={ROW_BOX}>
                <Button
                  testID={`project-row-${project().projectId}`}
                  accessibilityLabel={rowLabel(project())}
                  onPress={() => openProject(project())}
                  class={ROW}
                >
                  <View class="flex-row items-center gap-3">
                    <View class="min-w-0 flex-1 gap-0.5">
                      <Text
                        class="text-sm font-medium text-card-foreground"
                        style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                      >
                        {projectDisplayTitle(project())}
                      </Text>
                      <Text
                        class="text-xs text-muted-foreground"
                        style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                      >
                        {projectSubtitle(project(), now)}
                      </Text>
                    </View>
                    {projectStatusLabel(project()) ? (
                      <Text class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {projectStatusLabel(project())}
                      </Text>
                    ) : null}
                  </View>
                </Button>
                <Menu
                  open={menuFor() === project().projectId}
                  onOpenChange={(event) => menuFor.set(event.open ? project().projectId : null)}
                  placement="bottom"
                  align="end"
                  popupClass={MENU_POPUP}
                  trigger={
                    <Button
                      testID={`project-actions-${project().projectId}`}
                      accessibilityLabel={`Actions for ${projectControlName(project())}`}
                      class={ACTIONS}
                    >
                      <Icon
                        icon={MoreHorizontal}
                        size={16}
                        tint={() => token("muted-foreground")}
                      />
                    </Button>
                  }
                >
                  {/* Rename and duplicate read the package identity, which a
                      fallback row does not have; delete deliberately does
                      not, so a damaged package stays removable. */}
                  {project().unreadable ? null : (
                    <MenuItem class={MENU_ITEM} onSelect={() => beginEdit("rename", project())}>
                      <Text class="text-sm text-popover-foreground">Rename…</Text>
                    </MenuItem>
                  )}
                  {project().unreadable ? null : (
                    <MenuItem class={MENU_ITEM} onSelect={() => beginEdit("duplicate", project())}>
                      <Text class="text-sm text-popover-foreground">Duplicate…</Text>
                    </MenuItem>
                  )}
                  <MenuItem
                    class={MENU_ITEM}
                    onSelect={() => openDialog({ kind: "delete", project: project() })}
                  >
                    <Text class="text-sm text-destructive">Delete…</Text>
                  </MenuItem>
                </Menu>
              </View>
            )}
          </List>
        )}
      </View>

      <If when={dialog()?.kind === "create"}>
        {() => (
          <ProjectNameDialog
            idPrefix="project"
            heading="New project"
            description="A new project starts with an empty canvas."
            submitLabel="Create"
            initialTitle=""
            failurePrefix={PROJECT_ACTION_FAILURE.create}
            onCancel={dismissDialog}
            onSubmit={submitCreate}
          />
        )}
      </If>

      <If when={currentTarget("rename")}>
        {(target) => (
          <ProjectNameDialog
            idPrefix="project-rename"
            heading="Rename project"
            description="The canvas and its files stay as they are."
            submitLabel="Rename"
            initialTitle={target().title}
            failurePrefix={PROJECT_ACTION_FAILURE.rename}
            onCancel={dismissDialog}
            onSubmit={(title) => submitRename(target(), title)}
          />
        )}
      </If>

      <If when={currentTarget("duplicate")}>
        {(target) => (
          <ProjectNameDialog
            idPrefix="project-duplicate"
            heading="Duplicate project"
            description="The copy gets its own identity; the original stays as it is."
            submitLabel="Duplicate"
            initialTitle={`${target().title} copy`}
            failurePrefix={PROJECT_ACTION_FAILURE.duplicate}
            onCancel={dismissDialog}
            onSubmit={(title) => submitDuplicate(target(), title)}
          />
        )}
      </If>

      <If when={currentTarget("delete")}>
        {(target) => (
          <DeleteProjectDialog
            project={target()}
            failurePrefix={PROJECT_ACTION_FAILURE.delete}
            onCancel={dismissDialog}
            onDelete={() => submitDelete(target())}
          />
        )}
      </If>

      <If when={dialog()?.kind === "import"}>
        {() => (
          <ImportProjectDialog
            failurePrefix={PROJECT_ACTION_FAILURE.import}
            onCancel={dismissDialog}
            onImport={submitImport}
          />
        )}
      </If>
    </View>
  );
}
