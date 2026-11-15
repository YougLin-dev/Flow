import { ProjectStore, type ProjectEntry, type SeedDocumentInput } from "@flow/native";

/**
 * The fixed errors the project layer uses for races. They are literals in
 * Rust and here; the Rust and native-store tests pin them so a mapping
 * cannot drift.
 */
export const PROJECT_OPEN_ELSEWHERE = "the project is open in another window";
export const PROJECT_OPEN_HERE = "the project is open in this window";
export const PROJECT_ALREADY_OPEN = "another project is already open in this window";

/** The FFI lease, narrowed to what the session uses. */
export interface ProjectLeasePort {
  readonly databasePath: string;
  readonly projectId: string;
  release(): void;
}

/** The FFI store, narrowed to the surface the flow layer drives. */
export interface ProjectStorePort {
  listProjects(): Promise<ProjectEntry[]>;
  refreshCatalog(): Promise<ProjectEntry[]>;
  createProject(title: string, seed: SeedDocumentInput | null): Promise<ProjectEntry>;
  openProject(projectId: string): Promise<ProjectLeasePort>;
  renameProject(projectId: string, title: string): Promise<ProjectEntry>;
  deleteProject(projectId: string): Promise<void>;
  duplicateProject(projectId: string, title: string): Promise<ProjectEntry>;
  importProject(source: string): Promise<ProjectEntry>;
}

/** Opens the managed root. The Rust store creates it when it is missing. */
export function openProjectStore(root: string): Promise<ProjectStorePort> {
  return ProjectStore.open(root);
}

/**
 * The message of a rejected FFI call. NSH task rejections may arrive as a
 * string or an `Error`; both compare by their text here.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isProjectOpenElsewhere(error: unknown): boolean {
  return errorMessage(error) === PROJECT_OPEN_ELSEWHERE;
}

export function isProjectOpenHere(error: unknown): boolean {
  return errorMessage(error) === PROJECT_OPEN_HERE;
}

export function isAnotherProjectOpen(error: unknown): boolean {
  return errorMessage(error) === PROJECT_ALREADY_OPEN;
}
