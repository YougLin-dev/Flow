/**
 * Project boundary rule: dependencies flow down.
 *
 *   shell (src/App.tsx)  may use everything
 *   page                 may use pages, components, the store and foundations
 *   component            may use components, shared types and foundations
 *   store                may use shared types and foundations
 *   foundation           may use foundations only (flow/, leafer/, lib/, tool.ts)
 *
 * A component or foundation importing a page, or anything below a page
 * importing the store, is reported. Tests are skipped: they may reach into
 * any layer on purpose. `import/no-cycle` covers cycles; this covers
 * direction.
 *
 * Loaded by `vite.config.ts` (`lint.jsPlugins`) as `boundaries/no-upward-import`.
 */
import { dirname, relative, resolve, sep } from "node:path";
import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const LAYERS = {
  shell: new Set(["shell", "page", "component", "store", "type", "foundation", "asset"]),
  page: new Set(["page", "component", "store", "type", "foundation", "asset"]),
  component: new Set(["component", "type", "foundation", "asset"]),
  store: new Set(["store", "type", "foundation", "asset"]),
  foundation: new Set(["foundation", "type", "asset"]),
  type: new Set(["type"]),
  asset: new Set(),
};

/** The layer of a project file, from its path relative to the repository. */
function layerOf(file) {
  // The app's root is src/; its modules are classified below it.
  const path = file.startsWith("src/") ? file.slice("src/".length) : file;
  // Import specifiers omit the extension; files passed by the linter have it.
  const stem = path.replace(/\.(?:tsx?|jsx?|mjs)$/, "");
  if (stem === "App") return "shell";
  if (stem === "store") return "store";
  if (stem === "tool") return "type";
  if (path.startsWith("pages/")) return "page";
  if (path.startsWith("components/")) return "component";
  if (path.startsWith("flow/") || path.startsWith("leafer/") || path.startsWith("lib/")) {
    return "foundation";
  }
  if (path.startsWith("assets/")) return "asset";
  return "other";
}

function toProjectPath(cwd, filename) {
  return relative(cwd, filename).split(sep).join("/");
}

export default definePlugin({
  meta: { name: "boundaries" },
  rules: {
    "no-upward-import": defineRule({
      meta: {
        type: "problem",
        docs: {
          description:
            "Keep dependencies flowing down: pages may use components and the store, never the reverse.",
        },
        messages: {
          upward: "A {{section}} module may not import a {{target}} module ({{source}}).",
        },
      },
      create(context) {
        const file = toProjectPath(context.cwd, context.filename);
        if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return {};

        const section = layerOf(file);
        const allowed = LAYERS[section];
        if (!allowed) return {};

        /** Reports a relative import that points at a disallowed layer. */
        const check = (node) => {
          const source = node.source;
          if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
          const specifier = source.value;
          if (!specifier.startsWith(".")) return;

          const target = toProjectPath(context.cwd, resolve(dirname(context.filename), specifier));
          const targetLayer = layerOf(target);
          if (targetLayer === "other" || allowed.has(targetLayer)) return;

          context.report({
            node: source,
            messageId: "upward",
            data: { section, target: targetLayer, source: specifier },
          });
        };

        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    }),
  },
});
