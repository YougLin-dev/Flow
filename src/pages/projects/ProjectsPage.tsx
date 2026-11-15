/**
 * The projects screen: the app's entry point into the managed projects root.
 * It lists projects newest-opened first, creates one, and asks the shell to
 * show one. Row status (open elsewhere, unreadable) is part of the list, so
 * the user sees it before pressing; an open that still fails reports back
 * here through the home's action error.
 */
import { ChevronRight, Plus } from "lucide";
import { List, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { projectDisplayTitle, projectStatusLabel, projectSubtitle } from "../../flow/projects";
import type { ProjectEntry } from "../../flow/shared";
import { Icon } from "../../components/primitives";
import { CreateProjectDialog } from "./CreateProjectDialog";
import type { ProjectsHome } from "./projects-home";

export interface ProjectsPageProps {
  readonly home: ProjectsHome;
}

const OUTLINE =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
const ROW =
  "w-full rounded-(--radius) border border-transparent bg-card px-4 py-3 hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

export function ProjectsPage(props: ProjectsPageProps) {
  const creating = signal(false);
  // A create that outlives its dismissed dialog still commits: its row joins
  // the list, but it must not open a project the user walked away from.
  let createDismissed = false;
  // Relative times are a snapshot per mount: the page remounts when the user
  // returns from a project, so the list's ages refresh then, not on a timer.
  const now = Date.now();

  const openProject = (project: ProjectEntry): void => {
    props.home.clearActionError();
    props.home.open(project);
  };

  const openCreate = (): void => {
    createDismissed = false;
    creating.set(true);
  };

  const closeCreate = (): void => {
    if (!creating()) return;
    createDismissed = true;
    creating.set(false);
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
        <View class="flex-row items-end justify-between gap-4">
          <View class="gap-1">
            <Text class="text-xl font-semibold text-foreground">Projects</Text>
            <Text class="text-sm text-muted-foreground">Choose a project to open its canvas.</Text>
          </View>
          <Button testID="new-project" onPress={openCreate} class={OUTLINE}>
            <View class="flex-row items-center gap-1.5">
              <Icon icon={Plus} size={15} tint={() => token("muted-foreground")} />
              <Text class="text-sm text-card-foreground">New project</Text>
            </View>
          </Button>
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
                  <Icon icon={ChevronRight} size={15} tint={() => token("muted-foreground")} />
                </View>
              </Button>
            )}
          </List>
        )}
      </View>

      <If when={creating()}>
        {() => (
          <CreateProjectDialog
            onCancel={closeCreate}
            onCreate={async (title) => {
              try {
                const project = await props.home.create(title);
                const dismissed = createDismissed;
                creating.set(false);
                if (!dismissed) props.home.open(project);
              } catch (cause) {
                // A dismissed dialog cannot show the reason; the list can.
                if (createDismissed) props.home.reportCreateError(cause);
                throw cause;
              }
            }}
          />
        )}
      </If>
    </View>
  );
}
