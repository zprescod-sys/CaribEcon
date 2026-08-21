/* eslint-disable no-undef */

const devCerts = require("office-addin-dev-certs");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const CustomFunctionsMetadataPlugin = require("custom-functions-metadata-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

// Where the add-in's OWN files (taskpane.html, functions.js, icons) are served from.
// Rewritten into manifest.xml on a production build.
//
// The /addin/ path, not the site root: `npm run build:addin` (root package.json) copies this
// dist/ into the Astro site's public/addin/, which Astro publishes verbatim. Keeping the
// add-in on its own path means its bundle never collides with a site route, and the built
// manifest is itself served at caribecon.org/addin/manifest.xml for sideloading.
// Every asset reference inside taskpane.html is relative, so the subpath needs no other change.
const urlDev = "https://localhost:3000/";
const urlProd = "https://caribecon.org/addin/";

const devServerPort = process.env.npm_package_config_dev_server_port || 3000;

// Separate `vercel dev` process serving the real /api/*.ts Vercel Functions for local testing
// (`npx vercel@58 dev --listen ${vercelDevPort}`, run alongside `npm start` in its own terminal —
// vercel CLI is intentionally NOT a devDependency here, see commit 98725f1: it was the sole
// source of 24 Dependabot alerts on a public repo, and nothing in this repo depends on it besides
// this occasional local use, which `npx` covers fine). `vercel dev` has no HTTPS option, so it is
// proxied below rather than fetched directly — Excel blocks a direct http call from the https
// task pane as mixed content, but this dev server is already https and already trusted, and
// proxying to a plain-http backend is a Node-to-Node hop the browser never sees.
const vercelDevPort = process.env.CARIBECON_VERCEL_DEV_PORT || 3001;

// Where the DATA API lives — a separate concern from the two URLs above. Baked into
// functions.js at build time via DefinePlugin, so switching environments never means
// editing source. Override for a one-off environment without touching any file:
//   CARIBECON_API_BASE=https://my-preview.vercel.app npm run build:dev
// Must be https: Excel loads the add-in over https, so an http API (plain `vercel dev`
// on localhost) is blocked as mixed content — see the devServer.proxy rule below, which is
// what makes leaving this at the dev-server's own https origin work for every /api/* route.
//
// Under `npm run dev-server` the default is the dev server itself, which serves /api/snapshot
// locally (see setupMiddlewares below) and proxies every other /api/* route to vercel dev (see
// devServer.proxy below). That makes the add-in fully testable in Excel with nothing deployed —
// the point being that you should never have to merge to main to find out whether the task pane
// works. Plain builds still default to production.
function resolveApiBase(isServe) {
  if (process.env.CARIBECON_API_BASE) return process.env.CARIBECON_API_BASE;
  return isServe ? `https://localhost:${devServerPort}` : "https://caribecon.org";
}

// Shared token for the research endpoint. Empty by default: with no token the Ask tab hides
// itself rather than shipping a build that 401s on every question.
//
// This file reads plain process.env, nothing here loads .env itself — package.json's
// dev-server/build:dev scripts do that (`node --env-file-if-exists=../.env ...`), so both this
// token and ASK_CARIBECON_MODE below are picked up automatically from the repo root .env for
// local dev, no exporting required. `build` (what `npm run build:addin` calls, whose output is
// public/addin/, committed and served at caribecon.org/addin/) deliberately does NOT get this
// treatment — a real deploy's env comes from Vercel/CI, never a developer's local .env, and
// auto-loading it there would risk baking a local token into a publicly committed bundle.
const researchToken = process.env.CARIBECON_RESEARCH_TOKEN || "";

// CLAUDE.md's explicit task-pane rollback switch: "ask" points the chat tab at the real
// Phase 3 pipeline (POST /api/ask — interpret -> plan -> executeResearchPlan -> synthesize ->
// verify, claim-structured, grounding-gated). Anything else — including unset — is "legacy",
// which keeps posting to the frozen POST /api/research. Defaults to legacy, not ask: this is a
// build-time flip, not a runtime feature flag, so the safe default is the endpoint already
// proven in production, not the newest one. Flip explicitly (or add ASK_CARIBECON_MODE=ask to
// the repo root .env, which dev-server/build:dev now read automatically — see above):
//   ASK_CARIBECON_MODE=ask npm run build:dev
const askMode = process.env.ASK_CARIBECON_MODE === "ask" ? "ask" : "legacy";

/* global require, module, process */

async function getHttpsOptions() {
  const httpsOptions = await devCerts.getHttpsServerOptions();
  return { ca: httpsOptions.ca, key: httpsOptions.key, cert: httpsOptions.cert };
}

/* Local stand-in for GET /api/snapshot, so `npm run dev-server` is a complete stack.

   The transform below mirrors api/snapshot.ts, which stays the source of truth — this copy
   exists only because that file is TypeScript inside the Astro project and this config is
   CommonJS inside a separate npm project. If the wire format changes there, change it here
   too; the symptom of forgetting is the task pane failing to load against the dev server,
   which you would hit on the very next run. */
function devSnapshot() {
  const path = require("path");
  const root = path.join(__dirname, "..");
  const series = require(path.join(root, "data/almanac-data.json"));
  const meta = require(path.join(root, "data/indicator-meta.json"));

  // Mirrors COUNTRY_NAMES in src/lib/indicators.ts.
  const names = {
    GY: "Guyana", TT: "Trinidad & Tobago", BB: "Barbados", JM: "Jamaica", BS: "Bahamas",
    BZ: "Belize", SR: "Suriname", GD: "Grenada", LC: "Saint Lucia", AG: "Antigua & Barbuda",
    KN: "Saint Kitts & Nevis", DM: "Dominica", VC: "Saint Vincent & the Grenadines",
    TC: "Turks & Caicos", KY: "Cayman Islands", VG: "British Virgin Islands", HT: "Haiti",
    AW: "Aruba", CW: "Curaçao",
  };

  const labels = new Map();
  let maxVintage = "";
  for (const s of series) {
    if (!labels.has(s.indicator)) labels.set(s.indicator, s.indicatorLabel);
    for (const p of s.series) if (p.vintage > maxVintage) maxVintage = p.vintage;
  }

  return JSON.stringify({
    version: `${maxVintage}:${series.length}`,
    countries: [...new Set(series.map((s) => s.country))].sort().map((code) => ({
      code,
      name: names[code] || code,
      flag: `/flags/${code.toLowerCase()}.svg`,
    })),
    indicators: [...labels.entries()]
      .map(([slug, label]) => ({
        slug,
        label,
        chartGroup: (meta[slug] || {}).chartGroup || "other",
        order: (meta[slug] || {}).order == null ? 999 : meta[slug].order,
      }))
      .sort((a, b) => a.order - b.order),
    series: series.map((s) => ({
      c: s.country, i: s.indicator, u: s.unit, src: s.source, org: s.sourceOrg,
      tier: s.sourceTier, url: s.sourceUrl, conf: s.confidence,
      ...(s.seriesNote ? { note: s.seriesNote } : {}),
      p: s.series.map((p) => [p.year, p.value, p.type, p.vintage]),
    })),
  });
}

module.exports = async (env, options) => {
  const dev = options.mode === "development";
  const isServe = Boolean(env && env.WEBPACK_SERVE);
  const apiBase = resolveApiBase(isServe);
  const config = {
    // Dev only. A production build's output is committed to the site's public/addin/, and the
    // polyfill's map alone is 1.2MB of generated noise in git for a bundle nobody debugs
    // minified — debug in `npm run dev-server`, where the maps are still emitted.
    devtool: dev ? "source-map" : false,
    entry: {
      polyfill: ["core-js/stable", "regenerator-runtime/runtime"],
      taskpane: ["./src/taskpane/taskpane.js", "./src/taskpane/taskpane.html"],
      // No `commands` entry: the ribbon's only control is ShowTaskpane, and the generator's
      // commands.js called Office.context.mailbox — an Outlook-only API that throws in a
      // Workbook host. Add one back here if a real ExecuteFunction command is ever needed.
      functions: "./src/functions/functions.js",
    },
    output: {
      clean: true,
    },
    // .ts last, so a .js file always wins when both exist. Present so the task pane can import
    // the shared deterministic modules under ../../src/lib — see the babel rule below.
    //
    // extensionAlias fixes a real, previously-unbuildable gap: src/lib/*.ts increasingly uses
    // explicit nodenext-style './foo.js' specifiers (TypeScript's own convention for a file that
    // is actually foo.ts on disk — see e.g. excelOutputs.ts's `import { evidenceId } from
    // './askTools.js'`). Without this, webpack's default resolver treats an already-.js-suffixed
    // specifier as fully resolved and does NOT fall back to trying .ts — it appends the
    // extensions list onto the existing suffix instead (looking for the literal file
    // 'askTools.js.ts'), which can never exist. This is exactly the gap contracts.ts's own
    // header comment already named ("webpack's resolve.extensions has no extensionAlias, so it
    // cannot resolve an explicit ./foo.js specifier to a foo.ts on disk") — it stayed unnoticed
    // only as long as every runtime import chain into src/lib/ai/* happened to be `import type`
    // and got erased by babel before webpack ever needed to resolve it.
    resolve: {
      extensions: [".html", ".js", ".ts"],
      extensionAlias: {
        ".js": [".ts", ".js"],
      },
    },
    module: {
      rules: [
        {
          /* .ts as well as .js so taskpane.js can import src/lib/excelOutputs.ts directly rather
             than keeping a second, drifting copy of the WorkbookPlan layout rules (contrast the
             devSnapshot duplication above, which is unavoidable because this config file is
             CommonJS and cannot import TypeScript at all).

             @babel/preset-typescript only strips types — it never type-checks — which is exactly
             what is wanted here: `npm run check` at the repo root already type-checks src/lib,
             and excel-addin stays excluded from that tsconfig because its minified dist/ once
             exhausted the compiler's heap. Safe for the shared modules because every import in
             excelOutputs.ts is `import type`, so nothing survives erasure to resolve at runtime.

             No exclude for node_modules is needed beyond the existing one; ../../src is outside
             it and so is compiled normally. */
          test: /\.[jt]s$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
          },
        },
        {
          test: /\.html$/,
          exclude: /node_modules/,
          use: "html-loader",
        },
        {
          test: /\.(png|jpg|jpeg|gif|ico)$/,
          type: "asset/resource",
          generator: {
            filename: "assets/[name][ext][query]",
          },
        },
      ],
    },
    plugins: [
      // Compile-time text substitution — there is no `process` object in Excel's
      // custom-function runtime; this bakes the literal URL into the bundle.
      new webpack.DefinePlugin({
        "process.env.CARIBECON_API_BASE": JSON.stringify(apiBase),
        // Gate on /api/research, which spends tokens (unlike the free deterministic lookups).
        // This IS readable in the published bundle — it deters casual scripted abuse and pairs
        // with the endpoint's rate limit; it is not a secret and must never guard anything
        // that writes or costs more than a capped read. Set CARIBECON_RESEARCH_TOKEN in the
        // build environment to the same value configured on the Vercel project.
        "process.env.CARIBECON_RESEARCH_TOKEN": JSON.stringify(researchToken),
        "process.env.ASK_CARIBECON_MODE": JSON.stringify(askMode),
      }),
      new CustomFunctionsMetadataPlugin({
        output: "functions.json",
        input: "./src/functions/functions.js",
      }),
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        // functions.js is loaded by the task pane page too: with the shared runtime declared in
        // manifest.xml this is the one runtime, so the pane and the custom functions share a
        // single module instance — and therefore a single loaded snapshot.
        chunks: ["polyfill", "taskpane", "functions"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "assets/*",
            to: "assets/[name][ext][query]",
          },
          {
            from: "manifest*.xml",
            to: "[name]" + "[ext]",
            transform(content) {
              if (dev) {
                return content;
              } else {
                // replaceAll, not replace: a string first argument replaces only the
                // FIRST match, which previously left six of the seven manifest URLs
                // pointing at localhost while one flipped to the production host.
                return content.toString().replaceAll(urlDev, urlProd);
              }
            },
          },
        ],
      }),
    ],
    devServer: {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      server: {
        type: "https",
        options: env.WEBPACK_BUILD || options.https !== undefined ? options.https : await getHttpsOptions(),
      },
      port: devServerPort,
      // Serve the data API alongside the add-in so the whole thing runs offline. Same origin
      // as the add-in, so it is https and raises no mixed-content block in Excel.
      setupMiddlewares: (middlewares, server) => {
        server.app.get("/api/snapshot", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          // Rebuilt per request, unlike production's per-cold-start cache: editing
          // data/*.json then reloading the pane should show the new numbers.
          res.end(devSnapshot());
        });
        return middlewares;
      },
      // Every other /api/*.ts Vercel Function, proxied to a separately-running `vercel dev`
      // (see the vercelDevPort comment above). /api/snapshot is deliberately NOT in this list —
      // it keeps using the hand-mocked route above, unchanged. List explicit paths rather than
      // a blanket '/api' context so a new route added here is a one-line, deliberate opt-in, not
      // a silent behavior change for whatever else lives under /api next.
      //
      // Add a new endpoint's path here as it's built — currently pending: /api/comparison.
      proxy: [
        {
          context: ["/api/deepdive", "/api/indicator", "/api/research", "/api/ask"],
          target: `http://localhost:${vercelDevPort}`,
          changeOrigin: true,
          on: {
            error: (err, req, res) => {
              // The default behavior here is a hung request with no explanation. This is the
              // one error every contributor hits on a fresh checkout, so it gets a message
              // pointing at the exact fix rather than a generic ECONNREFUSED.
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "vercel_dev_unreachable",
                  message:
                    `Could not reach vercel dev on port ${vercelDevPort} for ${req.url}. ` +
                    `Run 'npx vercel@58 dev --listen ${vercelDevPort}' in a separate terminal, ` +
                    `alongside 'npm start'.`,
                }),
              );
            },
          },
        },
      ],
    },
  };

  return config;
};
