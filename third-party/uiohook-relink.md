# Rebuilding and replacing libuiohook

`uiohook-napi@1.5.5` contains an MIT-licensed N-API wrapper statically linked
with **libuiohook, LGPL-3.0-or-later**. Hemi's MIT license does not replace
that license. The complete GPL-3.0 and LGPL-3.0 texts are in `licenses/`.

`uiohook-napi-1.5.5-source.tar.gz`, included here and alongside the release
downloads, contains the wrapper, all platform library sources, headers,
`binding.gyp` and JavaScript loader from the exact npm publication. It excludes
prebuilt binaries. The upstream libuiohook patch is already applied in these
sources; it is also included separately for reference. Original copyright
headers and the wrapper's MIT license are retained.

Provenance and archive checksums are in `release-materials.json`. The wrapper
revision is `44e0d868ac6fedd2a68c7f8ad8163c73a3f36fc3`; its libuiohook
submodule is `f259ff37e81125f6f91ebac5439e7cde1e78b296` plus
`src/libuiohook.patch`. Hemi does not modify the distributed library.

## Build

Use Node.js 22 and Python 3. On macOS install Xcode Command Line Tools;
on Windows install Visual Studio 2022 Build Tools with Desktop development
with C++ and a Windows SDK. Build on the same OS and architecture as Hemi.

```sh
mkdir uiohook-source
tar -xzf uiohook-napi-1.5.5-source.tar.gz -C uiohook-source
cd uiohook-source/package
# Modify libuiohook/src or libuiohook/include as desired, then relink the addon:
npm exec --yes --package=node-gyp@12.4.0 -- node-gyp rebuild
```

This produces `build/Release/uiohook_napi.node`. This is a Node-API addon;
it does not require the Electron-specific V8 ABI. Both the wrapper and the
library can be rebuilt from the supplied sources, so proprietary object files
are not required for relinking. Node-API headers and platform build tools are
obtained by node-gyp.

## Replace in Hemi

Quit Hemi and work on a copy of the application. Hemi ships unpacked JavaScript
(`asar: false`). Replace the addon at:

- macOS: `Hemi.app/Contents/Resources/app/node_modules/uiohook-napi/build/Release/uiohook_napi.node`
- Windows: `<Hemi installation>/resources/app/node_modules/uiohook-napi/build/Release/uiohook_napi.node`

Create `build/Release` if needed. The `node-gyp-build` loader tries this local
build before the bundled `prebuilds/` directories. Keep its relative package
layout and JavaScript loader intact. The source is also inside the installed
app under `resources/app/third-party/` (macOS: `Contents/Resources/app/third-party/`).

On macOS, modifying a bundle invalidates its signature. For your local copy,
ad-hoc sign it again with `codesign --force --deep --sign - /path/to/Hemi.app`.
macOS may require renewed Accessibility/Input Monitoring authorization for the
modified application. On Windows, use a writable copy or your installation's
normal file permissions. Hemi imposes no separate key, signature enforcement,
or license restriction preventing these modifications or reverse engineering
to debug modifications to this LGPL component.

## Verification

On macOS arm64, both the unmodified source and a modified `libuiohook/src/logger.c`
were rebuilt with Node 22.22.3, Python 3.13.3 and node-gyp 12.4.0. A diagnostic
export in the wrapper returned the modified library's unique marker under
Electron 44.0.0 (Node-API 10); `start` and `stop` remained callable exports.
The marker modification is a local verification fixture and is not shipped.
This verifies relinking and loading; it does not claim a global input event
test or Windows rebuild. The published applications additionally pass their
platform release smoke checks.
