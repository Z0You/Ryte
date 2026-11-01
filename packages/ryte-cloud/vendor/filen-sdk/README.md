# Filen SDK (browser bundle)

`filen-sdk.browser.mjs` is Filen's official SDK, [@filen/sdk](https://github.com/FilenCloudDienste/filen-sdk-ts)
(AGPL-3.0, version in `VERSION`), bundled into one browser module. Rite loads it only when someone
uses Filen sync. It is generated, not hand-written: see `scripts/filen/build-filen-bundle.mjs` for how
to rebuild it from the npm package.
