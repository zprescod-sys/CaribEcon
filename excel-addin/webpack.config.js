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

// Where the DATA API lives — a separate concern from the two URLs above. Baked into
// functions.js at build time via DefinePlugin, so switching environments never means
// editing source. Override for a one-off environment without touching any file:
//   CARIBECON_API_BASE=https://my-preview.vercel.app npm run build:dev
// Must be https: Excel loads the add-in over https, so an http API (plain `vercel dev`
// on localhost) is blocked as mixed content.
//
// Under `npm run dev-server` the default is the dev server itself, which serves
// /api/snapshot locally (see setupMiddlewares below). That makes the add-in fully testable
// in Excel with nothing deployed — the point being that you should never have to merge to
// main to find out whether the task pane works. Plain builds still default to production.
function resolveApiBase(isServe) {
  if (process.env.CARIBECON_API_BASE) return process.env.CARIBECON_API_BASE;
  return isServe ? `https://localhost:${devServerPort}` : "https://caribecon.org";
}

// Shared token for the research endpoint. Empty by default: with no token the Ask tab hides
// itself rather than shipping a build that 401s on every question.
const researchToken = process.env.CARIBECON_RESEARCH_TOKEN || "";

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
    resolve: {
      extensions: [".html", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.js$/,
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
    },
  };

  return config;
};
