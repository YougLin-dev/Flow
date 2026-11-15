/**
 * Whether an open should write the M1 example.
 *
 * Three independent conditions: the project permits the automatic seed (a
 * managed project created blank records its initial-content decision and
 * refuses it), the document has not seeded before, and it is empty. The
 * marker separates "never had content" from "the user deleted everything":
 * an emptied project stays empty.
 */
export function shouldSeedDocument(
  seedDemo: boolean,
  demoSeeded: boolean,
  empty: boolean,
): boolean {
  return seedDemo && !demoSeeded && empty;
}

/**
 * The default for an open: the legacy/dev path may seed; a managed open
 * (one with a project identity) never does, because the managed project's
 * initial-content decision was made at creation.
 */
export function seedDemoDefault(projectId: string | undefined): boolean {
  return projectId === undefined;
}
