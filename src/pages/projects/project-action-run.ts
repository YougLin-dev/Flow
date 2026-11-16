/**
 * Runs one dialog action against the run its dialog belongs to. A run is
 * dismissed when the user closes the dialog; the store's write cannot be
 * cancelled, so a dismissed run's late success must not open or switch
 * anything, and its late failure goes to the list instead of the gone dialog.
 * A submit that arrives after the dismissal starts no write at all.
 */
import type { ProjectAction } from "./projects-home";

/** A run of a dialog: dismissal marks it so a late result stops mattering. */
export interface DialogRun {
  dismissed: boolean;
}

/** The dialog state a run needs. */
export interface DialogRuns {
  /** The live run, or null once the dialog was dismissed. */
  current(): DialogRun | null;
  /** Closes this run's dialog if it is still the live one. */
  finish(run: DialogRun): void;
  /** Shows a dismissed run's failure on the list. */
  reportLateError(action: ProjectAction, cause: unknown): void;
}

/**
 * Runs `work` for the live dialog run and applies its result: the dialog
 * closes unless the run was dismissed, and `applied` runs only for a live
 * run. Rejections keep their caller (the dialog) and, when the run was
 * dismissed, also reach the list.
 */
export async function runProjectAction<T>(
  runs: DialogRuns,
  action: ProjectAction,
  work: () => Promise<T>,
  applied: (value: T) => void,
): Promise<T | null> {
  const run = runs.current();
  if (run === null) return null;
  try {
    const value = await work();
    // A dismissed run's page state is already gone: there is no dialog to
    // close, and the result must not open or switch anything.
    if (!run.dismissed) {
      runs.finish(run);
      applied(value);
    }
    return value;
  } catch (cause) {
    if (run.dismissed) runs.reportLateError(action, cause);
    throw cause;
  }
}
