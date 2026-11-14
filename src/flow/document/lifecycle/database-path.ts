/** The inputs that choose the open document's database. */
export interface DatabasePathSources {
  /** The host's app data directory; packaged desktop apps provide one. */
  dataDir: string | null;
  /** A host launch parameter for development and tests. */
  hostPath: unknown;
  /** A developer environment override for hosts without a data directory. */
  envPath: string | undefined;
}

/**
 * The document path for this launch. An explicit host parameter (a test or
 * an embedding app) or environment override (the dev script) wins; otherwise
 * the host's data directory is the default, and a host with neither keeps the
 * document in memory.
 */
export function databasePath(sources: DatabasePathSources): string {
  const hostPath = typeof sources.hostPath === "string" ? sources.hostPath.trim() : "";
  if (hostPath !== "") return hostPath;
  const envPath = sources.envPath?.trim() ?? "";
  if (envPath !== "") return envPath;
  if (sources.dataDir) return `${sources.dataDir}/flow.db`;
  return ":memory:";
}
