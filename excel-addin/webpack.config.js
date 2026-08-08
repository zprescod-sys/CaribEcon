/* eslint-disable no-undef */

const devCerts = require("office-addin-dev-certs");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const CustomFunctionsMetadataPlugin = require("custom-functions-metadata-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

// Where the add-in's OWN files (taskpane.html, functions.js, icons) are served from.
// Rewritten into manifest.xml on a production build.
const urlDev = "https://localhost:3000/";
const urlProd = "https://caribecon.org/";

// Where the DATA API lives — a separate concern from the two URLs above. Baked into
// functions.js at build time via DefinePlugin, so switching environments never means
// editing source. Override for a one-off environment without touching any file:
//   CARIBECON_API_BASE=https://my-preview.vercel.app npm run build:dev
// Must be https: Excel loads the add-in over https, so an http API (plain `vercel dev`
// on localhost) is blocked as mixed content.
const apiBase = process.env.CARIBECON_API_BASE || "https://caribecon.org";

/* global require, module, process */

async function getHttpsOptions() {
  const httpsOptions = await devCerts.getHttpsServerOptions();
  return { ca: httpsOptions.ca, key: httpsOptions.key, cert: httpsOptions.cert };
}

module.exports = async (env, options) => {
  const dev = options.mode === "development";
  const config = {
    devtool: "source-map",
    entry: {
      polyfill: ["core-js/stable", "regenerator-runtime/runtime"],
      taskpane: ["./src/taskpane/taskpane.js", "./src/taskpane/taskpane.html"],
      commands: "./src/commands/commands.js",
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
      }),
      new CustomFunctionsMetadataPlugin({
        output: "functions.json",
        input: "./src/functions/functions.js",
      }),
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["polyfill", "taskpane", "functions", "commands"],
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
