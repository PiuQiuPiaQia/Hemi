# Third-party source and license records

Hemi's MIT license covers its own code. The components below retain their original licenses.

## Cua Driver 0.32.0 and UBRN 0.31.0-3

Hemi uses the upstream npm packages without modifying their contents. Cua's compatibility runtime contains upstream modifications to MPL-covered code; those modifications are available in its pinned build script.

| Component | Corresponding source |
| --- | --- |
| Cua Driver and its compatibility build script | [Cua commit 58aba84](https://github.com/trycua/cua/tree/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver) |
| `@ubjs/core@0.31.0-3` | [TypeScript source at 49bc591](https://github.com/jhugman/uniffi-bindgen-react-native/tree/49bc59194d183a05855ed4104c18eb92fb465e02/typescript) |
| `@ubjs/node@0.31.0-3` and its native runtime | [N-API source at dcb5c4a](https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449/runtimes/napi) |
| Cua's pinned `uniffi-bindgen-react-native@0.31.0-3` build input | [Source archive](https://codeload.github.com/jhugman/uniffi-bindgen-react-native/tar.gz/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449), [published npm source](https://registry.npmjs.org/uniffi-bindgen-react-native/-/uniffi-bindgen-react-native-0.31.0-3.tgz) |

The identical npm version does not imply an identical source commit: `@ubjs/core` and `@ubjs/node` were published separately. The revisions above were checked against npm `gitHead` metadata and the source manifests.

Cua's [build-node-runtime.mjs](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/scripts/build-node-runtime.mjs) applies the Electron-compatible buffer transformations to its pinned source. Its source version and integrity also match the lockfile at that Cua revision. Hemi distributes the upstream native binaries; it does not claim bit-for-bit native build reproducibility.

The MPL-covered source remains available under MPL-2.0. Recipients may obtain and modify it under those terms. Copies of the [MPL full text](licenses/MPL-2.0.txt), [UBRN notice](licenses/UBRN-NOTICE.txt), [Cua MIT license](licenses/Cua-MIT.txt), and [original compatibility-runtime notice](licenses/Cua-node-runtime-NOTICE.md) accompany this record. Exact source URLs and retrieved-file hashes are in [sources.json](sources.json).

The upstream [Rust third-party notices](licenses/Cua-Rust-NOTICES.md) also accompany the distribution, retaining the trope-cua, Interface-Agent and yabai attributions and MIT text. This upstream file is not a complete inventory of every linked Cargo dependency.

## Renderer bundle

`node scripts/generate-renderer-notices.mjs` collects third-party JavaScript modules from the actual Vite output and the explicit stylesheet inputs imported by globals.css and writes the component manifest and original license texts to `src/renderer/public/licenses/`. Vite copies those files into the renderer distribution.

For `bezier-js@6.1.4`, the [full MIT license](licenses/bezier-js-MIT.txt) comes from upstream commit `4e767299184ab4079dc8d7c970020103db14f431`. Its `src` tree is identical to the npm publication commit `a41f3e08e9724c9973eca0eb5c1304120e72fc70`; the original source header is also retained. Tree IDs and the original license hash are recorded in sources.json.

The renderer inventory does not cover native libraries, Electron/Chromium, or the full main-process dependency tree.

## libuiohook and embedded native components

[uiohook-relink.md](uiohook-relink.md) provides the LGPL notice, corresponding source archive, rebuilding and replacement steps, and the macOS arm64 relinking/load verification. The archive is included inside the application and as a separate Release asset. It preserves the exact npm publication's patched sources; the diagnostic verification modification is not shipped.

[native-components.json](native-components.json) and [Native-Rust-NOTICES.txt](licenses/Native-Rust-NOTICES.txt) retain the source archives, checksums, licenses and copyright notices for the Cua, UBRN and Photon Rust dependency sources. The input lockfiles are retained in `native-locks/`. This is a conservative source inventory, including build/dev dependencies and other platforms, rather than an exact linker SBOM. Actual macOS arm64 and Windows x64 binary source paths were also checked and missing versions added. Cua's compatibility runtime resolves some dependencies without `--locked`, so its workspace lockfile alone is not treated as proof of the binary's full dependency graph.

The exact published source archive for every listed MPL crate is linked in the component record. Cua/UBRN's own covered source and patches are linked above. Original notices for embedded C libraries in QuickJS-WASI and the Inter font used by Cua also accompany the app. Mbed TLS components offered under Apache-2.0 or GPL use the Apache-2.0 option.

`release-materials.json` pins the notice/source files and npm versions. `node scripts/verify-release-materials.mjs` rejects missing or changed materials and dependency version drift; packaging and CI run it before distribution.

## Electron and packaged native files

The build copies `node_modules/electron/dist/LICENSE` and `LICENSES.chromium.html` unchanged to `Resources/licenses` on macOS and `resources/licenses` on Windows. They follow the installed Electron version rather than a separately maintained copy.

Run `node scripts/verify-distribution-licenses.mjs <unpacked-app> <report.json>` after packaging. The report must be outside the application. It verifies shipped notice/source bytes against build inputs, rejects unregistered native package versions, and inventories native addons, shared libraries, WASM and executable binaries under the packaged app's node_modules, including prebuilds for other platforms. Electron's framework notices are checked separately. The macOS and Windows distribution reports accompany each Release.

## Pi 1.3.0

The seven installed Pi packages share the upstream [MIT license](licenses/Pi-MIT.txt), retained from commit `71023aec1546d6d677a65669c5665c0927ce0dd0` (tag `v1.3.0`). Their npm packages do not consistently include this full text. The `pi-mcp` package also ships its own `LICENSES` directory, which retains its embedded third-party notices. This does not replace notices for transitive npm or native libraries. Source and license hashes are recorded in sources.json.

## Vendored shadcn stylesheet

Only `dist/tailwind.css` from `shadcn@4.18.0` is retained unchanged in `src/renderer/src/vendor/shadcn-tailwind.css`. Hemi does not install the shadcn CLI. The npm tarball integrity and stylesheet/license SHA256 values are recorded in sources.json; the original [MIT license](licenses/shadcn-MIT.txt) accompanies the source and distribution. The renderer inventory also retains the MIT notices for Tailwind CSS and tw-animate-css as explicit stylesheet inputs.
