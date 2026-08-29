import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Light-touch flat config for the whole workspace.
 *
 * Deliberately NOT using the type-checked typescript-eslint presets: they need
 * a full program per package and make `pnpm lint` slow. `pnpm typecheck` is the
 * type-correctness gate; this is the style/bug-pattern gate.
 *
 * The Next.js apps have no per-app ESLint config — they are covered here so the
 * workspace has exactly one lint entry point (`next lint` is intentionally not
 * wired into the root script).
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  // Registers these extensions for file discovery when running bare `eslint .`.
  { files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  // Dev/ops scripts run under plain Node.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  prettier,
);
