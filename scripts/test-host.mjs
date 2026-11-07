#!/usr/bin/env node
/**
 * Runs the tests on this machine's native development host, whatever it is:
 * the Windows Win32 host, the macOS AppKit host or the Linux GTK 4 host.
 * Headless runs (`bun run test`) stay the default gate; this one drives real
 * input and the real window.
 */
import { spawnSync } from "node:child_process";

const targets = { win32: "windows", darwin: "macos", linux: "linux" };
const target = targets[process.platform];

if (!target) {
  console.error(`No desktop test host for ${process.platform}.`);
  process.exit(1);
}

const result = spawnSync("nsh", ["test", "src", "--target", target], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
