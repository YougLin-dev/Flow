/**
 * The restore confirmation: a backup folder or archive of the same project.
 * The store replaces the closed package's canvas and assets; the action is
 * irreversible, so the dialog is an alert.
 */
import { projectControlName } from "../../flow/projects";
import type { ProjectEntry } from "../../flow/shared";
import { ProjectPathDialog } from "./ProjectPathDialog";

export interface RestoreProjectDialogProps {
  readonly project: ProjectEntry;
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  readonly onCancel: () => void;
  readonly onRestore: (source: string) => Promise<void>;
}

export function RestoreProjectDialog(props: RestoreProjectDialogProps) {
  const title = projectControlName(props.project);
  return (
    <ProjectPathDialog
      idPrefix="project-restore"
      accessibilityLabel="Restore project"
      role="alertdialog"
      destructive
      heading="Restore project"
      description={`Replaces “${title}” with a backup of the same project. Its current canvas and assets are replaced; this can’t be undone.`}
      fieldLabel="Backup folder or archive"
      inputLabel="Backup folder or archive"
      placeholder="A backup folder or .zip archive"
      submitLabel="Restore"
      failurePrefix={props.failurePrefix}
      onCancel={props.onCancel}
      onSubmit={props.onRestore}
    />
  );
}
