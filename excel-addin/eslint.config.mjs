import officeAddins from "eslint-plugin-office-addins";
import tsParser from "@typescript-eslint/parser";

// office-addin-lint falls back to its own bundled config (node_modules/office-addin-lint/
// config/eslint.config.mjs) whenever a project has no eslint.config.mjs of its own — it does
// NOT read .eslintrc.json (that's the legacy format; this tool only looks for flat config).
// This file exists so lint reflects the codebase's actual conventions instead of the bundled
// default's: single-quoted strings, bare single-arg arrow params, fetch/process/globalThis as
// known identifiers (document/Excel/Office are already covered by the /* global ... */ comment
// at the top of taskpane.js, so they aren't repeated here).
export default [
  ...officeAddins.configs.recommended,
  {
    plugins: {
      "office-addins": officeAddins,
    },
    languageOptions: {
      parser: tsParser,
      // fetch is deliberately NOT here: hub.js and functions.js already declare it per-file
      // via /* global fetch */ (this codebase's actual convention), and declaring it here too
      // triggers no-redeclare in those files. taskpane.js's own /* global ... */ comment now
      // lists fetch alongside document/Excel/Office instead, for the same reason.
      globals: {
        process: "readonly",
        globalThis: "readonly",
      },
    },
    rules: {
      "prettier/prettier": [
        "error",
        {
          singleQuote: true,
          arrowParens: "avoid",
          trailingComma: "all",
          printWidth: 100,
          endOfLine: "auto",
        },
      ],
    },
  },
];
