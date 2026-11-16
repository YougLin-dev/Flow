/**
 * The import dialog: one folder or archive path. The Rust store reads a
 * package folder or a `.zip` of one, refuses a folder inside the managed
 * root, and imports a copy.
 */
import { ProjectPathDialog } from "./ProjectPathDialog";

export interface ImportProjectDialogProps {
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  readonly onCancel: () => void;
  readonly onImport: (source: string) => Promise<void>;
}

export function ImportProjectDialog(props: ImportProjectDialogProps) {
  return (
    <ProjectPathDialog
      idPrefix="project-import"
      accessibilityLabel="Import project"
      heading="Import project"
      description="Enter the path of a Flow project folder (the one that holds project.db) or a .zip archive of one."
      fieldLabel="Folder or archive"
      inputLabel="Project folder or archive"
      placeholder="A package folder or .zip archive"
      submitLabel="Import"
      failurePrefix={props.failurePrefix}
      onCancel={props.onCancel}
      onSubmit={props.onImport}
    />
  );
}
