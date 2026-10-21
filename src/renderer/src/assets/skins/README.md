# Built-in character skins

Runtime exports of the user-supplied and subsequently approved Hemi theme artwork. These files are derived assets, not a grant of rights to the characters, referenced model brands, or original posters. Existing source references and notices remain in the repository.

- Source posters: `docs/requirements/assets/appearance-and-skins/references/`.
- Transparent masters and portrait compositions: `docs/design/appearance-skins/v1/manifest.json`.
- Approved blue local animation and eye-frame provenance: `docs/design/appearance-skins/character-motion-trial-v1/README.md`, `character-motion-trial-v2/README.md`, and `home-background-motion-v1/README.md`.
- Exporter: `scripts/build-skin-assets.mjs`. It uses local artwork, browser Canvas/WebGL and FFmpeg; it does not request AI generation or call a remote service.
- Catalog: `src/shared/appearance/skins.config.json` registers colors, lettering and media metadata. See `docs/technical/adding-a-skin.md` for adding a skin with prepared assets.
- Inventory: `manifest.json` is generated from the catalog and actual asset bytes by `scripts/generate-appearance.mjs`; development/build refreshes it automatically. The original five-character exporter remains an optional offline authoring tool.

Each skin has a WebP static figure, a 256px WebP portrait and an 8-second 30fps VP9 WebM with alpha. Blue reuses the approved blink/hair/cloth animation. Purple, orange and gold use local hair/cloth deformation; red uses scarf/cloth deformation. They are not Cubism models. No fonts, SDK binaries, source desktop paths, API credentials or private application data are bundled here.
