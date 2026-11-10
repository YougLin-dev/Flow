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
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const targets = { win32: "windows", darwin: "macos", linux: "linux" };
const target = targets[process.platform];
if (!target) {
  console.error(`No desktop test host for ${process.platform}.`);
  process.exit(1);
}

const dbPath = resolve(".nsh/bench/flow-100k.db");
const revealPath = resolve(".nsh/bench/flow-100k-reveal.png");
const overviewPath = resolve(".nsh/bench/flow-100k-overview.png");
mkdirSync(dirname(dbPath), { recursive: true });

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

const steps = `
console.log("100k smoke marker: start at=" + Date.now())
await app.waitUntil(() => app.texts().some((text) => /^[0-9]+%$/.test(text)), { timeout: 30000 })
console.log("100k smoke marker: ready at=" + Date.now())
await app.press("Hand")
await app.drag("id:flow-canvas", { x: 300, y: 100 })
console.log("100k smoke marker: after-pan at=" + Date.now())
await app.keyboard.press("mod+=")
await app.keyboard.press("mod+=")
console.log("100k smoke marker: after-zoom at=" + Date.now())
await app.keyboard.press("mod+k")
await app.waitUntil(() => app.shows("id:search-input"), { timeout: 30000 })
console.log("100k smoke marker: search-open at=" + Date.now())
await app.type("id:search-input", "Node 99999")
await app.waitUntil(() => app.shows("id:search-result-n99999"), { timeout: 60000 })
console.log("100k smoke marker: search-typed at=" + Date.now())
await app.submit("id:search-input")
await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")), { timeout: 60000 })
console.log("100k smoke marker: search-revealed at=" + Date.now())
await app.screenshot(${JSON.stringify(revealPath)})
console.log("100k smoke marker: reveal-screenshot at=" + Date.now())
await app.keyboard.press("escape")
await app.waitUntil(() => app.texts().some((text) => text === "Fit"), { timeout: 30000 })
console.log("100k smoke marker: composer-closed at=" + Date.now())
await app.press("Fit")
console.log("100k smoke zoom after Fit: " + app.texts().filter(t => /%$/.test(t)).join(","))
await app.waitUntil(() => app.texts().some((text) => text === "5%"), { timeout: 60000 })
await app.wait(250)
await app.keyboard.press("mod+=")
console.log("100k smoke zoom after mod+=: " + app.texts().filter(t => /%$/.test(t)).join(","))
await app.waitUntil(() => app.texts().some((text) => text === "6%"), { timeout: 60000 })
await app.wait(250)
console.log("100k smoke marker: fit-overview at=" + Date.now())
await app.screenshot(${JSON.stringify(overviewPath)})
console.log("100k smoke marker: overview-screenshot at=" + Date.now())
console.log("100k UI smoke passed:", app.texts().join(" | "))
`;

const result = spawnSync(
  "nsh",
  ["test", "src/App.tsx", "--target", target, "--trace", "--fps", "--verbose"],
  {
    input: steps,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, FLOW_DB_PATH: dbPath },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
