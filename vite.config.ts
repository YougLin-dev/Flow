import { defineConfig } from "vite-plus";

const generated = [".nsh/**", "src/.nsh/**", "target/**", "node_modules/**"];

export default defineConfig({
  lint: {
    ignorePatterns: generated,
    // Project rule: dependencies flow down (docs/architecture.md).
    jsPlugins: ["./lint/boundaries.js"],
    options: {
      // Type-aware rules (floating promises, exhaustive switches…) and the
      // same TypeScript check `nsh check` runs, so `bun run check` is the one
      // gate before a commit.
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      // `any` erases the types of everything it touches: app code may not
      // spell it. Leafer's own declarations use `any` internally;
      // `src/leafer/nsh-platform.ts` is the one place that narrows them, with
      // `unknown` and type guards.
      "typescript/no-explicit-any": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-import-type-side-effects": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/consistent-type-definitions": ["error", "interface"],
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unsafe-type-assertion": "error",

      // Dependencies flow down only: pages may import components and the
      // store; neither may import a page. Cycles are never allowed. The
      // project-specific direction check is a JS plugin (lint/boundaries.js).
      "boundaries/no-upward-import": "error",
      "import/no-cycle": "error",
      "import/no-duplicates": "error",
      "import/no-self-import": "error",
      "import/no-default-export": "error",

      "no-console": ["error", { allow: ["error"] }],
      "no-debugger": "error",
      "no-shadow": "error",
      "no-implicit-coercion": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "unicorn/prefer-number-properties": "error",
      "unicorn/prefer-module": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",

      // Component-local helpers close over props and signals on purpose;
      // hoisting them would only scatter the code.
      "unicorn/consistent-function-scoping": "off",

      // Components are PascalCase, every other module is kebab-case. Tests
      // keep their subject's name (`App.test.tsx`, `camera.test.ts`), so the
      // check ignores the extension chain; an override below turns on
      // PascalCase for `.tsx`. Assets are not linted; their names follow
      // docs/conventions.md.
      "unicorn/filename-case": ["error", { case: "kebabCase", multipleFileExtensions: false }],
    },
    overrides: [
      {
        files: ["vite.config.ts"],
        rules: { "import/no-default-export": "off" },
      },
      {
        files: ["scripts/**", "lint/**"],
        env: { node: true },
        rules: {
          "no-console": "off",
          // A filesystem walk visits entries one at a time.
          "no-await-in-loop": "off",
          // The JS plugin and .mjs scripts are not type-checked; these rules
          // only see `any` there, not a missing annotation.
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-argument": "off",
          // The plugin's entry point is a default export, as Oxlint expects.
          "import/no-default-export": "off",
        },
      },
      {
        // A component's file is named after the function it exports.
        files: ["**/*.tsx"],
        rules: {
          "unicorn/filename-case": ["error", { case: "pascalCase", multipleFileExtensions: false }],
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        rules: {
          // nsh/test awaits the callback; it is typed as returning void.
          "typescript/no-misused-promises": "off",
          // Tests build stand-ins for native canvases on purpose.
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
    ],
  },
  fmt: {
    ignorePatterns: [...generated, "package-lock.json"],
    singleQuote: false,
    semi: true,
  },
});
