import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "generated/**",
      "node_modules/**",
      "packages/runtime-read-client/dist/**",
      "packages/runtime-read-client/generated/**",
      "spikes/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
