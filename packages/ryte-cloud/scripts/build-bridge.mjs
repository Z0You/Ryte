/*
This file is part of the Ryte project.

Copyright (C) 2026 Ryte contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// Bundles src/bridge.ts (with megajs and the Filen SDK) into one HTML page
// that the Android app loads in a hidden WebView:
//   apps/mobile/android/app/src/main/assets/ryte-bridge.html

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.resolve(
  root,
  "../../apps/mobile/android/app/src/main/assets/ryte-bridge.html"
);

const result = await esbuild.build({
  entryPoints: [path.join(root, "src/bridge.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "chrome80",
  minify: true,
  legalComments: "eof",
  mainFields: ["browser", "module", "main"],
  conditions: ["browser"],
  define: { global: "globalThis" },
  alias: {
    "@ryte/megajs": path.join(root, "vendor/megajs/megajs.browser.mjs"),
    "@ryte/filen-sdk": path.join(
      root,
      "vendor/filen-sdk/filen-sdk.browser.mjs"
    )
  },
  logLevel: "warning"
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Ryte cloud bridge</title></head>
<body><script>${js}</script></body></html>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(
  "Wrote",
  path.relative(process.cwd(), out),
  `(${Math.round(html.length / 1024)} KB)`
);
