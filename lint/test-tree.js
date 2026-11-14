/** A temporary project tree for the tooling tests, removed in `finally`. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function withTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), "flow-structure-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
