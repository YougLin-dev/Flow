#!/usr/bin/env node
/**
 * Builds the app for this machine's desktop target and wraps it in a native
 * installer: NSIS on Windows, a DMG on macOS, and a .deb + AppImage on Linux.
 *
 * A native installer bundles the platform's own runtime, so each one is built
 * on the OS it targets. Run this on Windows, macOS and Linux (or in a CI
 * matrix), not once for all three.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

const manifest = readJson("src/nsh.json");
const pkg = readJson("package.json");

const targets = { win32: "windows", darwin: "macos", linux: "linux" };
const target = targets[process.platform];
if (!target) {
  console.error(
    `Desktop installers are built on Windows, macOS or Linux, not ${process.platform}.`,
  );
  process.exit(1);
}

const name = manifest.name;
// NSH names the desktop executable after the app, keeping ASCII letters and digits.
const executable = name.replace(/[^A-Za-z0-9]/g, "") || "App";
const out = join(root, ".nsh", "out");
const appDir = join(out, name);

const run = (command, args) => {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("nsh", ["package", "--target", target, "src"]);

const config = {
  $schema:
    "https://raw.githubusercontent.com/crabnebula-dev/cargo-packager/main/bindings/packager/nodejs/schema.json",
  name,
  productName: name,
  version: manifest.version,
  identifier: manifest.id,
  publisher: name,
  description: pkg.description,
  category: "DeveloperTool",
  outDir: join(out, "installers"),
  binaries: [{ path: executable, main: true }],
  resources: [],
  formats: [],
};

if (target === "windows") {
  config.binariesDir = appDir;
  config.resources = [{ src: join(appDir, "nsh"), target: "nsh" }];
  config.formats = ["nsis"];
  config.nsis = {
    compression: "lzma",
    installMode: "currentUser",
    languages: ["English", "SimpChinese"],
    installerIcon: join(root, "src", "assets", "icon.ico"),
  };
} else if (target === "macos") {
  // NSH lays the app out as <name>.app/Contents/{MacOS,Resources/nsh}.
  const bundle = join(appDir, `${name}.app`);
  const icns = join(bundle, "Contents", "Resources", "AppIcon.icns");
  config.binariesDir = join(bundle, "Contents", "MacOS");
  config.resources = [{ src: join(bundle, "Contents", "Resources", "nsh"), target: "nsh" }];
  config.formats = ["dmg"];
  // Keep the icon NSH built from nsh.json's PNG.
  if (existsSync(icns)) config.icons = [icns];
  config.macos = {
    minimumSystemVersion: "14.0",
    // Ad-hoc signing is enough to launch locally. Set
    // FLOW_MACOS_SIGNING_IDENTITY to a "Developer ID Application: ..."
    // identity (and notarize) before distributing outside the Mac App Store.
    signingIdentity: process.env.FLOW_MACOS_SIGNING_IDENTITY || "-",
  };
} else {
  config.binariesDir = appDir;
  config.resources = [{ src: join(appDir, "nsh"), target: "nsh" }];
  config.formats = ["deb", "appimage"];
  // The hicolor icon theme expects each size as its own PNG.
  config.icons = [16, 24, 32, 48, 64, 128, 256, 512].map((size) =>
    join(root, "src", "assets", "icons", `${size}x${size}.png`),
  );
  config.deb = {
    depends: ["libgtk-4-1", "libwebkitgtk-6.0-4"],
  };
}

const configPath = join(out, `packager.${process.platform}.json`);
mkdirSync(join(out, "installers"), { recursive: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

run("bunx", ["packager", "--config", configPath]);

console.log(`\nInstallers: ${join(out, "installers")}`);
