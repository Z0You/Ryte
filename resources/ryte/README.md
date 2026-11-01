# Ryte logo

`icon.svg` (app icon) and `glyph.svg` (the white mark alone) are the
sources of every Ryte icon. `render-icons.js` renders them into the web
icons (`apps/web/public`) and the Android launcher / splash icons
(`apps/mobile/android/app/src/main/res`).

    node resources/ryte/render-icons.js

Replace the two SVGs with your own logo and run the script again.
