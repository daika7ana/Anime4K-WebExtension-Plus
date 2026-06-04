const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ExtensionManifestPlugin = require('webpack-extension-manifest-plugin');
const WebExtensionPlugin = require('webpack-target-webextension');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const isDevelopment = argv.mode === 'development';
  const targetBrowser = process.env.TARGET_BROWSER || 'chrome';

  const manifest = require('./manifest.json');

  // Modify manifest based on target browser
  if (targetBrowser === 'firefox') {
    // Firefox-specific transformations
    delete manifest.background.service_worker;
    manifest.background.scripts = ['background.js'];
    manifest.browser_specific_settings = {
      gecko: {
        id: 'anime4k-webextension-plus@daika7ana',
        data_collection_permissions: {
          required: ['none']
        }
      },
    };
  }


  return {
    entry: {
      popup: './src/ui/popup/popup.ts',
      options: './src/ui/options/options.ts',
      onboarding: './src/ui/onboarding/onboarding.ts',
      content: './src/content.ts',
      background: './src/background.ts'
    },
    output: {
      filename: '[name].js',
      path: path.resolve(__dirname, 'dist-' + targetBrowser),
      clean: true, // Clean output directory
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: [
            MiniCssExtractPlugin.loader,
            'css-loader'
          ],
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    plugins: [
      new CleanWebpackPlugin(),
      new CopyWebpackPlugin({
        patterns: [
          { from: '*.{png,svg}', context: 'public/icons', to: 'icons' },
          { from: 'public/_locales', to: '_locales' },
          { from: 'rules.json' },
        ],
      }),
      new HtmlWebpackPlugin({
        filename: 'popup.html',
        template: './src/ui/popup/popup.html',
        chunks: ['popup'],
      }),
      new HtmlWebpackPlugin({
        filename: 'options.html',
        template: './src/ui/options/options.html',
        chunks: ['options'],
      }),
      new HtmlWebpackPlugin({
        filename: 'onboarding.html',
        template: './src/ui/onboarding/onboarding.html',
        chunks: ['onboarding'],
      }),
      new MiniCssExtractPlugin({
        filename: '[name].css',
      }),
      new ExtensionManifestPlugin({
        config: {
          base: manifest,
        },
        pkgJsonProps: [
          'version'
        ]
      }),
      new WebExtensionPlugin({
        background: {
          classicLoader: false,
        },
        weakRuntimeCheck: true,
      }),
    ].filter(Boolean),
    devtool: isDevelopment ? 'inline-source-map' : false,
    watch: isDevelopment,
    optimization: {
      minimize: !isDevelopment,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: {
              // Remove console.log and console.warn in production (keep console.error)
              pure_funcs: ['console.log', 'console.warn'],
            },
          },
        }),
      ],
      splitChunks: {
        chunks: 'async',
        minSize: 20000,
      },
    },
  };
};
