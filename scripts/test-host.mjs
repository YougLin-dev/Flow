#!/usr/bin/env node
/**
 * Runs the platform tests on this machine's native development host, whatever
 * it is: the Windows Win32 host, the macOS AppKit host or the Linux GTK 4
 * host. Only `*.host.test.ts(x)` files run here: their subject is the real
 * window, native input, rendering or a desktop API, so they add signal beyond
 * the headless engine.
 *
 * Everything else belongs to `bun run test`: pure unit tests, the mounted
 * app's headless tests, and `*.native.test.ts` files, which cannot load the
 * Rust module in a host test bundle. Extra arguments go to `nsh test`, e.g.
 * `bun run test:host -- --filter composer`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const targets = { win32: "windows", darwin: "macos", linux: "linux" };
const target = targets[process.platform];

if (!target) {
  console.error(`No desktop test host for ${process.platform}.`);
  process.exit(1);
}

function testFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".nsh" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(path));
    else if (entry.name.endsWith(".host.test.ts") || entry.name.endsWith(".host.test.tsx")) {
      files.push(path);
    }
  }
  return files;
}

const extra = process.argv.slice(2);
const files = testFiles("src").toSorted();

if (files.length === 0) {
  console.error("No *.host.test.ts or *.host.test.tsx files under src.");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  console.log(`host: ${basename(file)}`);
  const result = spawnSync("nsh", ["test", file, "--target", target, ...extra], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
