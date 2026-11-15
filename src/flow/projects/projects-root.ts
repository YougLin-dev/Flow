/**
 * The managed projects root for this launch.
 *
 * Projects live under the host's app data directory, beside the legacy
 * `flow.db` (which the dev path still opens). A host without a data
 * directory has no managed root: the UI must offer no project list rather
 * than invent a location.
 */
export function projectsRoot(dataDir: string | null): string | null {
  if (dataDir === null || dataDir === "") return null;
  return `${dataDir}/projects`;
}
