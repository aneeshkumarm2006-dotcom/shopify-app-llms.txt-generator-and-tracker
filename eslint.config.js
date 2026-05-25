// Flat ESLint config — Shopify-style baseline with Prettier conflict resolution.
// The official Shopify ESLint preset is consumed via inline rules so we avoid a
// dependency on shopify/eslint-plugin which still ships a legacy .eslintrc.
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "node_modules/**",
      "build/**",
      ".cache/**",
      ".react-router/**",
      ".shopify/**",
      "prisma/migrations/**",
      "extensions/**/dist/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "smart"],
      "prefer-const": "warn",
    },
  },
  prettier,
];
