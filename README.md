<p align="center"><img src="resources/ryte/icon.svg" width="96" alt="Ryte logo"></p>

# Ryte

Ryte is an end-to-end encrypted notes app for **Android** and the **web**, with
every feature included and no upload limits. It is a fork of
[Notesnook](https://github.com/streetwriters/notesnook) 3.4.15: the same
editor, notebooks, tags, reminders, vault, app lock, note history and
attachments, but instead of Notesnook's servers and paid plans, Ryte keeps
your data in **your own MEGA or Filen account**.

## How it works

- **Sign in** = connect MEGA or Filen, then choose an *encryption password*.
  Other devices sign in to the same MEGA/Filen account and enter the same
  encryption password.
- Everything is encrypted on the device (XChaCha20-Poly1305, key derived with
  Argon2 from the encryption password) before it is uploaded. MEGA and Filen
  only ever see ciphertext.
- Your drive gets two folders:
  - `Ryte/`: `account.json` (salt, a key check and wrapped keys; nothing
    readable) and each device's sync log (`log-<device>-<n>.json`). When many
    logs pile up, a device folds them into a snapshot (`snap-…json`).
  - `Ryte Files/`: encrypted attachments, one file per attachment.
- **No plan limits**: all features are unlocked for everyone. Storage is
  limited only by the free space of your MEGA/Filen account (check each
  service's current free plan).
- The encryption password **cannot be recovered**. If you forget it, the synced
  notes cannot be decrypted. Keep a backup (Settings → Backup & export).

## Not available in Ryte

These need Notesnook's own servers, so they are hidden: publishing notes to
the web (Monographs), the Inbox API, Notesnook Circle, 2FA/email/password
management of a Notesnook account, and account recovery.

## Downloads

- **Android**: every push to `main` builds an APK and publishes it under
  [Releases](../../releases). Use the `arm64` APK on most phones.
- **Web**: every push to `main` builds the static site (artifact `ryte-web`).
  Host it on any static host at the root of a (sub)domain, or set the
  Cloudflare secrets described in `.github/workflows/ryte-web.yml`.

## Development

```sh
npm ci --ignore-scripts
npm run bootstrap -- --scope=web     # or --scope=mobile
npm run start:web                    # http://localhost:3000
```

- Ryte's code lives in `packages/ryte-cloud` (MEGA/Filen adapters, Android
  bridge), `packages/core/src/api/ryte` (account + cloud sync),
  `apps/web/src/ryte` and `apps/mobile/app/ryte`. Other changes to Notesnook
  code are marked with `Ryte:` comments.
- Android runs MEGA/Filen in a hidden WebView (React Native has no
  WebCrypto). Rebuild that page after changing `packages/ryte-cloud`:
  `npm ci --prefix packages/ryte-cloud && node packages/ryte-cloud/scripts/build-bridge.mjs`
- Logo: `resources/ryte/*.svg`; render all icons with
  `node resources/ryte/render-icons.js`.

## License

GPL-3.0-or-later, like Notesnook. Ryte is based on Notesnook by Streetwriters
(Private) Limited; see `NOTESNOOK-README.md` for the original README. The
bundled Filen SDK (`packages/ryte-cloud/vendor/filen-sdk`) is AGPL-3.0;
megajs is MIT. Ryte is not affiliated with Notesnook, MEGA or Filen.
