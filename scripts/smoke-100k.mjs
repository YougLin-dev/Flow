#!/usr/bin/env node
/**
 * Seeds the text half of the 100k benchmark fixture and drives the app against
 * it on this machine's real desktop host: pan, zoom, search a far node, reveal
 * it and fit again.
 *
 * The fixture shares the release Rust benchmark's 100,000-node, 99,000-edge
 * text graph but deliberately not its 2,000 four-item image batches: at Flow
 * HEAD image previews are data URLs that QuickJS and native Image decode, and
 * that separate cost would mask the graph/canvas work measured here. The
 * Rust benchmark still reads real persisted image assets.
 *
 * The run labels itself as a development-host profile. It is not the release
 * Rust benchmark: the host is `nsh test --target` (a development build) and
 * the wall times include test-host setup, not release DB latency. The app reads
 * FLOW_DB_PATH (declared in nsh.json's capabilities); the dev and test hosts
 * would otherwise open their own document. The generated database and
 * screenshots live under `.nsh/bench` and are not committed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const targets = { win32: "windows", darwin: "macos", linux: "linux" };
const target = targets[process.platform];
if (!target) {
  console.error(`No desktop test host for ${process.platform}.`);
  process.exit(1);
}

const dbPath = resolve(".nsh/bench/flow-100k.db");
mkdirSync(dirname(dbPath), { recursive: true });
// The fixture is a package: the database and its asset directory. A stale
// assets tree from an older fixture version would be read by the new rows.
rmSync(join(dirname(dbPath), "assets"), { recursive: true, force: true });

const seedStarted = Date.now();
const seed = spawnSync(
  "cargo",
  [
    "test",
    "--release",
    "--manifest-path",
    "src/native/Cargo.toml",
    "db::tests::seed_benchmark_database",
    "--",
    "--ignored",
    "--nocapture",
  ],
  { stdio: "inherit", env: { ...process.env, FLOW_BENCH_DB: dbPath } },
);
if (seed.error) throw seed.error;
if (seed.status !== 0) process.exit(seed.status ?? 1);
console.log(`100k smoke seed elapsed=${Date.now() - seedStarted}ms path=${dbPath}`);
console.log(
  "100k smoke profile: release Rust fixture seed, then a development host via nsh test --target with --trace/--fps/--verbose; these are not release-host timings",
);

const result = spawnSync(
  "nsh",
  ["test", "src/Smoke100k.host.test.tsx", "--target", target, "--trace", "--fps", "--verbose"],
  {
    stdio: "inherit",
    env: { ...process.env, FLOW_DB_PATH: dbPath },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
