# Packaging

`bun run package` builds the app for the current desktop OS with NSH, then wraps
that output in a native installer with
[`@crabnebula/packager`](https://github.com/crabnebula-dev/cargo-packager):

| Host    | NSH output                       | Installer                                                 |
| ------- | -------------------------------- | --------------------------------------------------------- |
| Windows | `.nsh/out/Flow/` + `Flow.zip`    | `.nsh/out/installers/Flow_<version>_x64-setup.exe` (NSIS) |
| macOS   | `.nsh/out/Flow.app`              | `.nsh/out/installers/Flow_<version>_<arch>.dmg`           |
| Linux   | `.nsh/out/Flow/` + `Flow.tar.gz` | `.nsh/out/installers/*.deb` and `*.AppImage`              |

The script reads the name, id and version from `src/nsh.json`, so those stay
the single source of truth; the generated packager config is written to
`.nsh/out/packager.<platform>.json`. The app root is `src/`, so NSH is called
as `nsh package --target <os> src`. `nsh package` also writes
`capabilities.json` from `src/nsh.json`, so the packaged app keeps the same
sandbox as development.

## One OS at a time

A desktop installer embeds that platform's native runtime, so it is built on
the OS it targets. `bun run package` on Windows makes the `.exe`, on macOS the
`.dmg`, on Linux the `.deb`/AppImage. NSH also cannot cross-package its desktop
runtimes (`nsh-macos-app` and `nsh-linux-app` are host tools).

To produce all three from one place, run the same command on a CI matrix
(`windows-latest`, `macos-latest`, `ubuntu-24.04`) and upload
`.nsh/out/installers` as the artifacts. Each runner needs Bun and NSH
installed; no other packaging tool is required.

## Requirements

- **All hosts:** Bun and the `nsh` CLI.
- **Windows:** nothing else. The packager downloads NSIS itself.
- **macOS:** Xcode command line tools (for `codesign` and `hdiutil`).
- **Linux:** `dpkg` tools and FUSE for AppImage; the app needs GTK 4.14+ and
  WebKitGTK 6.0 at run time. The generated `.deb` declares
  `libgtk-4-1` and `libwebkitgtk-6.0-4`.

## Icons

The icon comes from `src/assets/icon.svg`, rendered into:

- `src/assets/icon.png` — 1024×1024, referenced by `src/nsh.json`. NSH embeds
  it in the Windows executable and builds `AppIcon.icns` on macOS.
- `src/assets/icon.ico` — a 16–256 px multi-size icon used as the NSIS
  installer icon (the installer `.exe` and its window).
- `src/assets/icons/<size>x<size>.png` — the hicolor sizes for the Linux
  `.deb` and AppImage.

`bun run package` passes the macOS `.icns` and Linux PNGs to cargo-packager,
and the `.ico` to NSIS. The app's own exe, shortcut and file icon come from the
PNG that NSH embeds.

## Code signing

- **Windows:** the installer is unsigned, so SmartScreen warns. Sign it with a
  code signing certificate before publishing; see cargo-packager's
  `windows.certificateThumbprint` / `windows.signCommand`.
- **macOS:** the script ad-hoc signs the app, which is enough to launch it
  locally on Apple silicon. Before distributing it, set
  `FLOW_MACOS_SIGNING_IDENTITY="Developer ID Application: ..."` and notarize.
  On a clean CI runner the identity alone is not enough: import the
  certificate into a temporary keychain (and provide notarization
  credentials) before running the package step.
- **Linux:** `.deb` and AppImage are normally distributed unsigned.

## Before a release

1. Keep the `id` in `src/nsh.json` unique. It is the reverse-DNS form of the
   developer's domain plus the app name — currently `studio.r4.flow` (from
   `r4.studio`). Apps that share an id also share their data.
2. Replace `src/assets/icon.svg` (and re-render `icon.png`, `icon.ico` and
   `icons/`) if the branding changes.
3. Bump `version` (and `build`) in `src/nsh.json`; the installer name follows
   it.

## Mobile and web

These come straight from NSH and do not use the packager:

```sh
nsh package --target android src                # .apk (debug key unless --keystore)
nsh package --target ios --sign ... --profile ... src   # .ipa, macOS only
nsh package --target web src                    # static site
```

`nsh package --target ios-simulator` makes a simulator `.app`, and
`--target macos --run` opens the packaged Mac app.
