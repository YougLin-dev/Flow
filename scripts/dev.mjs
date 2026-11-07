#!/usr/bin/env node
/**
 * Runs the app on this machine's development host with a persistent database.
 *
 * The development host has no app data directory, so the app would otherwise
 * use an in-memory document. This sets FLOW_DB_PATH (declared in nsh.json's
 * capabilities) to a database under `.nsh/dev`. An explicit FLOW_DB_PATH or
 * host launch parameter still wins, and a packaged app falls back to its data
 * directory when neither is set.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath = resolve(process.env.FLOW_DB_PATH || ".nsh/dev/flow.db");
mkdirSync(dirname(dbPath), { recursive: true });

const result = spawnSync("nsh", ["run", "src", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, FLOW_DB_PATH: dbPath },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
