/**
 * A test entry that mounts the projects page over a fake home whose list
 * read is counted. The count is on screen so a test can see the page's
 * foreground revalidation without a real projects root or filesystem grant.
 */
import { mount, signal, Text, View } from "nsh";
import { createProjectsHome, ProjectsPage } from "../pages/projects";
import { fakeProjectStore, listedProject } from "./fake-project-store";

const LISTED = listedProject("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

export function ProjectsForegroundProbe() {
  const reads = signal(0);
  const store = fakeProjectStore({
    listProjects: async () => {
      reads.update((count) => count + 1);
      return [LISTED];
    },
  });
  const home = createProjectsHome("/projects", { openStore: async () => store });

  return (
    <View class="flex-1">
      <Text testID="list-reads">{`reads:${reads()}`}</Text>
      <ProjectsPage home={home} />
    </View>
  );
}

mount(ProjectsForegroundProbe);
