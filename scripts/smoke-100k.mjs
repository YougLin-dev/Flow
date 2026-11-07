#!/usr/bin/env node
/**
 * Seeds a 100k-node database and drives the app against it on this machine's
 * real desktop host: pan, zoom, search a far node, reveal it and fit again.
 *
 * The app reads FLOW_DB_PATH (declared in nsh.json's capabilities); the dev
 * and test hosts would otherwise open their own document. The generated
 * database and screenshot live under `.nsh/bench` and are not committed.
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

const steps = `
await app.waitUntil(() => app.texts().some((text) => /^[0-9]+%$/.test(text)))
await app.press("Hand")
await app.drag("id:flow-canvas", { x: 300, y: 100 })
await app.keyboard.press("mod+=")
await app.keyboard.press("mod+=")
await app.keyboard.press("mod+k")
await app.waitUntil(() => app.shows("id:search-input"))
await app.type("id:search-input", "Node 99999")
await app.waitUntil(() => app.shows("id:search-result-n99999"))
await app.submit("id:search-input")
await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")))
await app.screenshot(${JSON.stringify(revealPath)})
await app.press("Fit")
await app.waitUntil(() => app.texts().some((text) => text === "5%"))
await app.wait(250)
await app.keyboard.press("mod+=")
await app.waitUntil(() => app.texts().some((text) => text === "6%"))
await app.wait(250)
await app.screenshot(${JSON.stringify(overviewPath)})
console.log("100k UI smoke passed:", app.texts().join(" | "))
`;

const result = spawnSync("nsh", ["test", "src/App.tsx", "--target", target], {
  input: steps,
  stdio: ["pipe", "inherit", "inherit"],
  env: { ...process.env, FLOW_DB_PATH: dbPath },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
