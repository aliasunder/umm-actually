import js from "@eslint/js"
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
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
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
