/**
 * The backup dialog: a new destination folder. The store copies a verified
 * package (project.db and assets) there and leaves the project as it is.
 */
import { projectControlName } from "../../flow/projects";
import type { ProjectEntry } from "../../flow/shared";
import { ProjectPathDialog } from "./ProjectPathDialog";

export interface BackupProjectDialogProps {
  readonly project: ProjectEntry;
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  readonly onCancel: () => void;
  readonly onBackup: (destination: string) => Promise<void>;
}

export function BackupProjectDialog(props: BackupProjectDialogProps) {
  const title = projectControlName(props.project);
  return (
    <ProjectPathDialog
      idPrefix="project-backup"
      accessibilityLabel="Back up project"
      heading="Back up project"
      description={`Copies “${title}” and its assets to a new folder. The project stays as it is.`}
      fieldLabel="Destination folder"
      inputLabel="Backup destination folder"
      placeholder="A new folder outside the projects folder"
      submitLabel="Back up"
      failurePrefix={props.failurePrefix}
      onCancel={props.onCancel}
      onSubmit={props.onBackup}
    />
  );
}
