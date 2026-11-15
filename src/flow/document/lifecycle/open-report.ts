/**
 * Startup decisions from the open report. Pure, so the policies can be tested
 * without a document: a package that was not closed cleanly schedules the
 * recovery verify, and a camera saved at exit is restored instead of fitting.
 */

export interface CleanReport {
  readonly openedClean: boolean;
}

export interface CameraReport {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZoom: number;
}

export interface SavedCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Whether the package needs the post-open recovery verify. */
export function needsVerify(report: CleanReport): boolean {
  return !report.openedClean;
}

/**
 * The camera to restore, or null when the package never saved one. The
 * frozen schema has no saved marker, so the (0, 0, 1) default stands for
 * "never saved": a session that fitted or moved the camera stores other
 * values, and saveView refuses an invalid camera.
 */
export function savedCamera(report: CameraReport): SavedCamera | null {
  const { cameraX: x, cameraY: y, cameraZoom: zoom } = report;
  if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) return null;
  if (x === 0 && y === 0 && zoom === 1) return null;
  return { x, y, zoom };
}
