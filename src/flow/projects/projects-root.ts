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

/** The launch inputs that decide between managed projects and one document. */
export interface ProjectsRootSources {
  /** The host's app data directory; packaged desktop apps provide one. */
  readonly dataDir: string | null;
  /** A host launch parameter for development and tests. */
  readonly hostProjectsRoot: unknown;
  /** The legacy single-document overrides; either one keeps that path. */
  readonly hostDocumentPath: unknown;
  readonly envDocumentPath: string | undefined;
  /** A developer override for hosts without a data directory. */
  readonly envProjectsRoot: string | undefined;
}

/**
 * The managed root for this launch, or null to open the legacy single
 * document. The app starts on Projects by default; an explicit document
 * path (a test, a smoke run or an embedding host) keeps the old path,
 * because that caller asked for one specific database.
 */
export function projectsRootForLaunch(sources: ProjectsRootSources): string | null {
  if (nonEmpty(sources.hostDocumentPath) || nonEmpty(sources.envDocumentPath)) return null;
  return (
    nonEmpty(sources.hostProjectsRoot) ??
    nonEmpty(sources.envProjectsRoot) ??
    projectsRoot(sources.dataDir)
  );
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
