#!/usr/bin/env node
/**
 * Runs the app on this machine's development host with persistent data.
 *
 * The development host has no app data directory, so the app would otherwise
 * open an in-memory document and have no projects root. This points it at
 * `.nsh/dev/projects` (FLOW_PROJECTS_ROOT, declared in nsh.json's
 * capabilities), which starts the app on its project list. An explicit
 * FLOW_DB_PATH keeps the legacy single-document path for that run, and an
 * explicit FLOW_PROJECTS_ROOT picks another projects root. A packaged app
 * falls back to its own data directory when neither is set.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const env = { ...process.env };
const legacyDb = process.env.FLOW_DB_PATH;
if (legacyDb) {
  const dbPath = resolve(legacyDb);
  mkdirSync(dirname(dbPath), { recursive: true });
  env.FLOW_DB_PATH = dbPath;
} else {
  const projectsRoot = resolve(process.env.FLOW_PROJECTS_ROOT || ".nsh/dev/projects");
  mkdirSync(projectsRoot, { recursive: true });
  env.FLOW_PROJECTS_ROOT = projectsRoot;
}

const result = spawnSync("nsh", ["run", "src", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
