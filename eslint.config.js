// ESLint flat config (ESLint 9+).
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      // Globals do Node (process, console, etc.) — sem isso o no-undef do
      // eslint:recommended marca todo `console.log` como erro.
      globals: globals.node,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
  // Desabilita regras que conflitam com Prettier.
  prettier,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
];
