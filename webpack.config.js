const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const WebExtensionPlugin = require("webpack-target-webextension");

const pkg = require("./package.json");

module.exports = (env, argv) => {
  const isDevelopment = argv.mode === "development";
  const targetBrowser = process.env.TARGET_BROWSER || "chrome";
  // `build:dev` sets this to keep console.log/warn in an otherwise production build.
  const keepConsoleLogs = process.env.KEEP_CONSOLE_LOGS === "1";

  const manifest = require("./manifest.json");

  // Keep the emitted manifest in sync with package.json; asserted by
  // `pnpm check:version` for the built dist-<target>/manifest.json files.
  manifest.version = pkg.version;

  // Modify manifest based on target browser
  if (targetBrowser === "firefox") {
    // Firefox-specific transformations
    delete manifest.background.service_worker;
    manifest.background.scripts = ["background.js"];
    manifest.browser_specific_settings = {
      gecko: {
        id: "anime4k-webextension-plus@daika7ana",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    };
  }

  return {
    entry: {
      popup: "./src/ui/popup/popup.ts",
      options: "./src/ui/options/options.ts",
      onboarding: "./src/ui/onboarding/onboarding.ts",
      content: "./src/content.ts",
      background: "./src/background.ts",
    },
    output: {
      filename: "[name].js",
      path: path.resolve(__dirname, "dist-" + targetBrowser),
      clean: true, // Clean output directory
      cssFilename: "[name].css",
    },
    // Webpack's built-in CSS handling (webpack >= 5.109) parses, extracts,
    // and minifies CSS itself, replacing css-loader + mini-css-extract-plugin
    // for the default global-CSS setup this project uses.
    experiments: {
      css: true,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: "esbuild-loader",
            options: {
              target: "es2022",
              format: "cjs",
            },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.wgsl$/,
          type: "asset/source",
        },
      ],
    },
    resolve: {
      extensions: [".ts", ".js"],
      // Dynamic imports of TypeScript modules use explicit `.js` specifiers
      // (required by TS node16 ESM resolution for `import()`); map them back
      // to the `.ts` sources at bundle time.
      extensionAlias: {
        ".js": [".ts", ".js"],
      },
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@core": path.resolve(__dirname, "src/core"),
        "@core/video": path.resolve(__dirname, "src/core/video"),
        "@core/gpu": path.resolve(__dirname, "src/core/gpu"),
        "@core/effects": path.resolve(__dirname, "src/core/effects"),
        "@core/ui": path.resolve(__dirname, "src/core/ui"),
        "@core/utils": path.resolve(__dirname, "src/core/utils"),
        "@utils": path.resolve(__dirname, "src/utils"),
        "@shaders": path.resolve(__dirname, "src/shaders"),
      },
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: "*.{png,svg}", context: "public/icons", to: "icons" },
          { from: "public/_locales", to: "_locales" },
          { from: "rules.json" },
          {
            // Emit the (browser-adjusted, version-injected) extension manifest.
            from: "manifest.json",
            transform: () => JSON.stringify(manifest, null, 2),
          },
        ],
      }),
      new HtmlWebpackPlugin({
        filename: "popup.html",
        template: "./src/ui/popup/popup.html",
        chunks: ["popup"],
      }),
      new HtmlWebpackPlugin({
        filename: "options.html",
        template: "./src/ui/options/options.html",
        chunks: ["options"],
      }),
      new HtmlWebpackPlugin({
        filename: "onboarding.html",
        template: "./src/ui/onboarding/onboarding.html",
        chunks: ["onboarding"],
      }),
      new WebExtensionPlugin({
        // Declare which entry is the background so the plugin can apply its
        // MV3 fixes (eager chunk loading + a try/catch wrapper so the service
        // worker console stays readable if the entry throws). Chrome MV3 uses
        // a service worker; Firefox uses a background page.
        background: {
          ...(targetBrowser === "firefox"
            ? { pageEntry: "background" }
            : { serviceWorkerEntry: "background" }),
          classicLoader: false,
        },
        weakRuntimeCheck: true,
      }),
    ].filter(Boolean),
    devtool: isDevelopment ? "inline-source-map" : false,
    watch: isDevelopment,
    performance: {
      maxAssetSize: 4 * 1024 * 1024, // 4 MiB
      hints: "warning",
    },
    optimization: {
      minimize: !isDevelopment,
      // Configure webpack's built-in minimizers instead of supplying an
      // explicit `minimizer` array: overriding the minimizer array replaces
      // the built-in CSS minimizer, leaving native CSS unminified.
      minimizeOptions: {
        javascript: {
          compress: {
            // Remove console.log and console.warn in production (keep console.error).
            // `build:dev` (KEEP_CONSOLE_LOGS=1) retains them for debugging.
            pure_funcs: keepConsoleLogs ? [] : ["console.log", "console.warn"],
            // Match webpack's default of 2 compression passes (overriding
            // minimizeOptions is not merged with the defaults).
            passes: 2,
          },
        },
      },
      splitChunks: {
        chunks: "async",
        minSize: 20000,
      },
    },
  };
};
