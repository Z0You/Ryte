# megajs (browser build)

`megajs.browser.mjs` is `dist/main.browser-es.mjs` from
[megajs](https://github.com/qgustavor/mega) 1.3.10 (MIT, see LICENSE),
copied as is. It has no imports of its own. To update it:

    npm i megajs@<version> && cp node_modules/megajs/dist/main.browser-es.mjs vendor/megajs/megajs.browser.mjs
