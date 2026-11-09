#!/usr/bin/env node
/**
 * Runs the app's tests on this machine's native development host, whatever it
 * is: the Windows Win32 host, the macOS AppKit host or the Linux GTK 4 host.
 * Headless runs (`bun run test`) stay the default gate; this one drives real
 * input and the real window.
 *
 * The host loads test bundles before an app has registered its native module,
 * so a test file that imports `@flow/native` cannot load there. `native.test.ts`
 * and `*.native.test.ts` run in the headless suite instead; the other test
 * files run one by one.
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
    else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) files.push(path);
  }
  return files;
}

const extra = process.argv.slice(2);
const files = testFiles("src")
  .filter(
    (file) => basename(file) !== "native.test.ts" && !basename(file).endsWith(".native.test.ts"),
  )
  .toSorted();
let failed = false;

for (const file of files) {
  const result = spawnSync("nsh", ["test", file, "--target", target, ...extra], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
