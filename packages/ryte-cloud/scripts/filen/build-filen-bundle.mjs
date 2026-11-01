/**
 * Builds packages/web/vendor/filen-sdk/filen-sdk.browser.mjs: Filen's official SDK (@filen/sdk,
 * AGPL-3.0) bundled into one self-contained browser module that Rite loads only when someone
 * uses Filen sync. Node-only modules are replaced by tiny stubs in ./stubs.
 *
 * To rebuild (e.g. after updating the SDK version below):
 *   mkdir /tmp/filen-build && cd /tmp/filen-build && npm init -y
 *   npm i @filen/sdk@0.4.2 esbuild@0.25.10 path-browserify@1.0.1 readable-stream@4.7.0 \
 *         buffer@6.0.3 events@3.3.0 process@0.11.10 url@0.11.4 util@0.12.5
 *   node /path/to/rite/packages/web/scripts/filen/build-filen-bundle.mjs
 */
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(process.cwd(), 'package.json'))
const esbuild = require('esbuild')
const resolveFrom = (name) => require.resolve(name)

const stub = (file) => path.join(here, 'stubs', file)
const outFile = path.join(here, '../../vendor/filen-sdk/filen-sdk.browser.mjs')
const sdkVersion = require('@filen/sdk/package.json').version

const entry = path.join(process.cwd(), 'filen-entry.mjs')
fs.writeFileSync(entry, "export { default as FilenSDK } from '@filen/sdk'\n")

await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  // The SDK is wrapped in a function (IIFE) and only FilenSDK is exported from it. As a plain ES
  // module, webpack's unused-code analysis wrongly strips the base class of a hashing class
  // that the SDK builds while loading, which breaks it with "Super constructor null of
  // anonymous class is not a constructor". Inside a function webpack leaves the code alone.
  format: 'iife',
  globalName: '__riteFilenSdk',
  platform: 'browser',
  target: 'es2019',
  minify: true,
  legalComments: 'eof',
  mainFields: ['browser', 'module', 'main'],
  define: { global: 'globalThis' },
  inject: [stub('inject.js')],
  alias: {
    'fs-extra': stub('empty.js'),
    crypto: stub('empty.js'),
    https: stub('https.js'),
    http: stub('https.js'),
    agentkeepalive: stub('agentkeepalive.js'),
    os: stub('os.js'),
    path: resolveFrom('path-browserify'),
    stream: resolveFrom('readable-stream'),
    events: resolveFrom('events'),
    url: resolveFrom('url/'),
    buffer: resolveFrom('buffer/'),
    util: resolveFrom('util/'),
  },
  footer: {
    js: 'export const FilenSDK = __riteFilenSdk.FilenSDK;',
  },
  banner: {
    js: `/* Filen SDK ${sdkVersion} (https://github.com/FilenCloudDienste/filen-sdk-ts), AGPL-3.0. Browser bundle built for Rite by scripts/filen/build-filen-bundle.mjs. */`,
  },
  logLevel: 'warning',
})

fs.writeFileSync(path.join(path.dirname(outFile), 'VERSION'), `${sdkVersion}\n`)
console.log('Wrote', outFile, `(${Math.round(fs.statSync(outFile).size / 1024)} KB, @filen/sdk ${sdkVersion})`)
