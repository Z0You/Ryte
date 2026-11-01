// Renders resources/ryte/{icon,glyph}.svg into the web and Android icons.
// Needs Playwright with Chromium: node resources/ryte/render-icons.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const here = __dirname;
const root = path.resolve(here, "../..");
const icon = fs.readFileSync(path.join(here, "icon.svg"), "utf8");
const glyph = fs.readFileSync(path.join(here, "glyph.svg"), "utf8");
const svgOf = (svg, color) =>
  color ? svg.replace(/#FFFFFF/g, color) : svg;

// content: svg markup; scale: share of the canvas the svg covers; bg: page bg
async function render(page, out, size, content, scale = 1, bg = "transparent") {
  const inner = Math.round(size * scale);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${bg}">
    <div style="width:${inner}px;height:${inner}px">${content.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: bg === "transparent" });
  console.log("wrote", path.relative(root, out), size);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const web = path.join(root, "apps/web/public");
  await render(page, path.join(web, "favicon.png"), 64, icon);
  await render(page, path.join(web, "apple-touch-icon.png"), 180, icon, 1, "#0B6B57");
  await render(page, path.join(web, "android-chrome-192x192.png"), 192, icon);
  await render(page, path.join(web, "android-chrome-512x512.png"), 512, icon);
  // maskable: full-bleed background, mark inside the 80% safe zone
  const maskable = icon.replace('rx="230"', 'rx="0"');
  await render(page, path.join(web, "android-chrome-maskable-192x192.png"), 192, maskable);
  await render(page, path.join(web, "android-chrome-maskable-512x512.png"), 512, maskable);
  fs.writeFileSync(path.join(web, "favicon.svg"), icon);

  const res = path.join(root, "apps/mobile/android/app/src/main/res");
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    const dir = path.join(res, `mipmap-${d}`);
    const s = Math.round(108 * k);
    // adaptive icon: background layer + mark within the 66dp safe zone
    await render(page, path.join(dir, "ic_launcher_background.png"), s, `<svg viewBox="0 0 10 10"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14A37F"/><stop offset="1" stop-color="#0B6B57"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`);
    await render(page, path.join(dir, "ic_launcher_foreground.png"), s, glyph, 0.62);
    await render(page, path.join(dir, "ic_launcher_monochrome.png"), s, glyph, 0.62);
    // splash: the icon in the middle of a 288dp canvas
    const sp = Math.round(288 * k);
    await render(page, path.join(dir, "bootsplash_logo.png"), sp, icon, 0.42);
    await render(page, path.join(dir, "bootsplash_logo_dark.png"), sp, icon, 0.42);
  }
  await browser.close();
})();
