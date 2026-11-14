/** One filesystem resolver shared by the lint plugin and the structure report. */
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** A project path with forward slashes, relative to the repository root. */
export function toProjectPath(cwd, filename) {
  return relative(cwd, filename).split(sep).join("/");
}

/**
 * Resolve a relative import to an existing project file. The linter sees a
 * specifier, not a resolved target, so try every spelling NSH accepts: the
 * exact file, `.ts`, `.tsx`, `.js`, `.jsx`, then a directory index.
 */
export function resolveProjectImport(cwd, fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(cwd, dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toProjectPath(cwd, candidate);
    }
  }
  return null;
}
