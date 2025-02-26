const { modifyWebpackConfig, shallowMerge, defaultOptions } = require('@gera2ld/plaid');
const { isProd } = require('@gera2ld/plaid/util');
const webpack = require('webpack');
const TerserPlugin = isProd && require('terser-webpack-plugin');
const deepmerge = isProd && require('deepmerge');
const { ListBackgroundScriptsPlugin } = require('./manifest-helper');
const { addWrapperWithGlobals, getCodeMirrorThemes, getUniqIdB64 } = require('./webpack-util');
const ProtectWebpackBootstrapPlugin = require('./webpack-protect-bootstrap-plugin');
const projectConfig = require('./plaid.conf');
const { getVersion } = require('./version-helper');
const mergedConfig = shallowMerge(defaultOptions, projectConfig);

// Avoiding collisions with globals of a content-mode userscript
const INIT_FUNC_NAME = `Violentmonkey:${getUniqIdB64()}`;
const VAULT_ID = 'VAULT_ID';
const PAGE_MODE_HANDSHAKE = 'PAGE_MODE_HANDSHAKE';
const VM_VER = getVersion();
const WEBPACK_OPTS = {
  node: {
    global: false,
  },
  performance: {
    maxEntrypointSize: 1e6,
    maxAssetSize: 0.5e6,
  },
};
const MIN_OPTS = {
  extractComments: false,
  parallel: true,
  terserOptions: {
    compress: {
      // `terser` often inlines big one-time functions inside a small "hot" function
      reduce_funcs: false,
    },
    output: {
      ascii_only: true,
      comments: false,
      wrap_func_args: false, // disabling a premature optimization designed for old browsers
    },
  },
};
const MIN_OPTS_PUBLIC = isProd && {
  include: 'public/',
  ...MIN_OPTS,
};
const MIN_OPTS_MAIN = isProd && deepmerge.all([{}, MIN_OPTS, {
  exclude: 'public/',
  terserOptions: {
    compress: {
      ecma: 8, // ES2017 Object.entries and so on
      passes: 2, // necessary now since we removed plaid's minimizer
      unsafe_arrows: true, // it's 'safe' since we don't rely on function prototypes
    },
  },
}]);

const pickEnvs = (items) => {
  return Object.assign({}, ...items.map(x => ({
    [`process.env.${x.key}`]: JSON.stringify(
      'val' in x ? x.val
        : process.env[x.key] ?? x.def,
    ),
  })));
};

const defsObj = {
  ...pickEnvs([
    { key: 'DEBUG', def: false },
    { key: 'VM_VER', val: VM_VER },
    { key: 'SYNC_GOOGLE_CLIENT_ID' },
    { key: 'SYNC_GOOGLE_CLIENT_SECRET' },
    { key: 'SYNC_GOOGLE_DESKTOP_ID' },
    { key: 'SYNC_GOOGLE_DESKTOP_SECRET' },
    { key: 'SYNC_ONEDRIVE_CLIENT_ID' },
    { key: 'SYNC_ONEDRIVE_CLIENT_SECRET' },
    { key: 'SYNC_DROPBOX_CLIENT_ID' },
  ]),
  'process.env.INIT_FUNC_NAME': JSON.stringify(INIT_FUNC_NAME),
  'process.env.CODEMIRROR_THEMES': JSON.stringify(getCodeMirrorThemes()),
  'process.env.DEV': JSON.stringify(!isProd),
  'process.env.TEST': JSON.stringify(process.env.BABEL_ENV === 'test'),
};
// avoid running webpack bootstrap in a potentially hacked environment
// after documentElement was replaced which triggered reinjection of content scripts
const skipReinjectionHeader = `{
  const INIT_FUNC_NAME = '${INIT_FUNC_NAME}';
  if (window[INIT_FUNC_NAME] !== 1)`;

const modify = (page, entry, init) => modifyWebpackConfig(
  (config) => {
    Object.assign(config, WEBPACK_OPTS);
    config.output.publicPath = '/';
    config.plugins.push(new webpack.DefinePlugin({
      ...defsObj,
      // Conditional compilation to remove unsafe and unused stuff from `injected`
      'process.env.IS_INJECTED': JSON.stringify(/injected/.test(page) && page),
    }));
    config.optimization.minimizer.find((m, i, arr) => (
      m.constructor.name === 'TerserPlugin' && arr.splice(i, 1)
    ));
    config.optimization.minimizer.push(...!isProd ? [] : [
      new TerserPlugin(MIN_OPTS_PUBLIC),
      new TerserPlugin(MIN_OPTS_MAIN),
    ]);
    config.module.rules.find(rule => {
      if (typeof rule.test?.test === 'function' && rule.test.test('file.js')) {
        rule.exclude = file => /node_modules/.test(file) && !/vueleton/.test(file);
      }
    });
    if (!entry) init = page;
    if (init) init(config);
    return config;
  }, {
    projectConfig: {
      ...mergedConfig,
      ...entry && { pages: { [page]: { entry } } },
    },
  },
);

module.exports = Promise.all([
  modify((config) => {
    addWrapperWithGlobals('common', config, defsObj, getGlobals => ({
      header: () => `{ ${getGlobals()}`,
      footer: '}',
      test: /^(?!injected|public).*\.js$/,
    }));
    config.plugins.push(new ListBackgroundScriptsPlugin({
      minify: false, // keeping readable
    }));
  }),

  modify('injected', './src/injected', (config) => {
    config.plugins.push(new ProtectWebpackBootstrapPlugin());
    addWrapperWithGlobals('injected/content', config, defsObj, getGlobals => ({
      header: () => `${skipReinjectionHeader} { ${getGlobals()}`,
      footer: '}}',
    }));
  }),

  modify('injected-web', './src/injected/web', (config) => {
    config.output.libraryTarget = 'commonjs2';
    config.plugins.push(new ProtectWebpackBootstrapPlugin());
    addWrapperWithGlobals('injected/web', config, defsObj, getGlobals => ({
      header: () => `${skipReinjectionHeader}
        window[INIT_FUNC_NAME] = function (IS_FIREFOX,${PAGE_MODE_HANDSHAKE},${VAULT_ID}) {
          const module = { __proto__: null };
          ${getGlobals()}`,
      footer: `
          const { exports } = module;
          return exports.__esModule ? exports.default : exports;
        }};0;`,
    }));
  }),
]);
