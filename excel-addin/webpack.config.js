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

// Where the DATA API lives — a separate concern from the two URLs above. Baked into
// functions.js at build time via DefinePlugin, so switching environments never means
// editing source. Override for a one-off environment without touching any file:
//   CARIBECON_API_BASE=https://my-preview.vercel.app npm run build:dev
// Must be https: Excel loads the add-in over https, so an http API (plain `vercel dev`
// on localhost) is blocked as mixed content.
const apiBase = process.env.CARIBECON_API_BASE || "https://caribecon.org";

// Shared token for the research endpoint. Empty by default: with no token the Ask tab hides
// itself rather than shipping a build that 401s on every question.
const researchToken = process.env.CARIBECON_RESEARCH_TOKEN || "";

/* global require, module, process */

async function getHttpsOptions() {
  const httpsOptions = await devCerts.getHttpsServerOptions();
  return { ca: httpsOptions.ca, key: httpsOptions.key, cert: httpsOptions.cert };
}

module.exports = async (env, options) => {
  const dev = options.mode === "development";
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
      port: process.env.npm_package_config_dev_server_port || 3000,
    },
  };

  return config;
};
