import js from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.strict,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
  },
  {
    // AGENTS.md → Code style: blank lines separate logical steps, so a
    // declaration never runs straight into the `if` that consumes it.
    // Prettier does not manage blank lines, so this rule cannot conflict with it.
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: ["const", "let"], next: "if" },
      ],
    },
  },
  {
    // AGENTS.md → Code style: a function stays small enough for a reviewer
    // to hold.
    // - The recommended configs leave both rules off, and these limits are
    //   ESLint's own defaults.
    // - A function over the complexity limit carries
    //   `eslint-disable-next-line complexity` until a change splits it.
    // - ESLint reports an arrow function at its `=>`, and a method or a
    //   function-valued property at its key. The directive sits on the line
    //   above the reported line, inside the signature when the signature
    //   spans lines.
    rules: {
      complexity: ["error", { max: 20 }],
      "max-depth": ["error", 4],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["warn", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    // Layering boundary (see AGENTS.md → Module layering): pure modules never
    // import I/O modules or SDKs at runtime. Type-only imports are allowed —
    // they are erased at compile time. Tests are exempt (they read fixtures).
    files: ["src/diff/**/*.ts", "src/review/**/*.ts"],
    ignores: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/github/**", "**/openrouter/**", "**/context/**"],
              allowTypeImports: true,
              message:
                "pure modules (diff/, review/) must not import I/O modules at runtime — thread data through orchestrate.ts",
            },
            {
              group: ["node:fs", "node:fs/**", "@actions/**", "@openrouter/**"],
              allowTypeImports: true,
              message: "no I/O or SDK usage in pure modules",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/"],
  },
)
