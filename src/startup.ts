import { Storage } from "nsh";
import type { FlowSession, FlowSettings, StartupMode } from "./store";
import type { ProjectEntry } from "./flow/shared";

/**
 * The app-level settings and session, and what they say to do at launch.
 * Storage is a key-value string store; the JSON shapes here are versioned so
 * a later change can tell an old file from a new one.
 */

export const SETTINGS_KEY = "flow.settings.v1";
export const SESSION_KEY = "flow.session.v1";

const DEFAULT_SETTINGS: FlowSettings = { startup: "projects" };

function startupMode(value: unknown): StartupMode {
  return value === "lastProject" ? "lastProject" : "projects";
}

export function parseSettings(raw: string | null): FlowSettings {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
    return { startup: startupMode((value as { startup?: unknown }).startup) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function parseSession(raw: string | null): FlowSession | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as {
      projectId?: unknown;
      title?: unknown;
      clean?: unknown;
    };
    if (typeof record.projectId !== "string" || typeof record.title !== "string") return null;
    return {
      projectId: record.projectId,
      title: record.title,
      clean: record.clean === true,
    };
  } catch {
    return null;
  }
}

export async function loadSettings(): Promise<FlowSettings> {
  return parseSettings(await Storage.getItem(SETTINGS_KEY));
}

export async function loadSession(): Promise<FlowSession | null> {
  return parseSession(await Storage.getItem(SESSION_KEY));
}

export async function saveSettings(settings: FlowSettings): Promise<void> {
  await Storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function saveSession(session: FlowSession | null): Promise<void> {
  if (session === null) {
    await Storage.removeItem(SESSION_KEY);
    return;
  }
  await Storage.setItem(SESSION_KEY, JSON.stringify(session));
}

/** Why the last project could not open at startup. */
export type StartupFallback = "missing" | "unreadable" | "openElsewhere";

/** What the first window shows after the app reads its settings. */
export type StartupDecision =
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly project: ProjectEntry }
  | {
      /** The last run ended uncleanly: show Projects, with a way back. */
      readonly kind: "recover";
      readonly project: ProjectEntry;
    }
  | {
      /** The last project went before this run; Projects explains and stays. */
      readonly kind: "fallback";
      readonly reason: StartupFallback;
    };

/**
 * An unclean run always shows Projects with a way back, whatever the startup
 * setting: the package may need the recovery prompt first. `startup:
 * "lastProject"` then opens the last project only when the last run closed
 * cleanly and the package still opens here; a missing, unreadable or locked
 * package falls back to Projects with the reason.
 */
export function decideStartup(
  settings: FlowSettings,
  session: FlowSession | null,
  projects: readonly ProjectEntry[],
): StartupDecision {
  if (session === null) return { kind: "projects" };
  const project = projects.find((entry) => entry.projectId === session.projectId);
  if (!session.clean) {
    return project !== undefined && !project.unreadable
      ? { kind: "recover", project }
      : { kind: "projects" };
  }
  if (settings.startup !== "lastProject") return { kind: "projects" };
  if (project === undefined) return { kind: "fallback", reason: "missing" };
  if (project.unreadable) return { kind: "fallback", reason: "unreadable" };
  if (project.openElsewhere) return { kind: "fallback", reason: "openElsewhere" };
  return { kind: "project", project };
}
