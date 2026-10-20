# Screenshot sources

These images show the real Hemi macOS application, not design mockups or renderer fixtures. They were captured on 2026-10-20 from a local source build using the documentation capture script.

Environment: macOS 26.5.1 (25F80), Apple Silicon, Electron 44.0.0. The renderer was built using `npm run build`. The first four images used a 1440-pixel-wide window; the usage image used a 1100-pixel-wide window with the same renderer build. Relevant regions were captured directly at the display scale. The pixels were not retouched.

| Image | Actual state | Capture boundary |
| --- | --- | --- |
| feature-routing.png | Saved main, role, and fallback model configuration in the real routing dialog | Model names and endpoint are demo configuration; no savings benchmark |
| feature-usage.png | Completed bilingual README review using real configured models, with a written report and work delegated to the explorer and oracle roles | Real provider responses and usage: 20 calls, 299k input, 24.0k output, 96 token/s, 82% cache hit. Input includes cached tokens; calls include title generation. This is one task's result, not a performance or savings benchmark |
| feature-newapi.png | New API sign-in entry in the real provider setup screen | Local demo site; the same capture session completed sign-in, API key creation, verification, and import |
| feature-app-permissions.png | Calculator and TextEdit granted through the real installed-app picker | Grants exist only in isolated application data; no actions were performed in those applications |
| feature-memory.png | Two fictional preferences written by the main agent's actual memory tools and displayed in Settings | Model responses were scripted by a local demo endpoint; memory persistence and UI are real |

All state changes went through the application UI or its existing Settings IPC. No personal conversations or memory were copied, and no internal store was edited to prepopulate screenshots. The first four images used isolated demo configuration. The usage capture copied only encrypted model settings and onboarding configuration into a fresh isolated directory; real credentials stayed in application memory and private configuration files and are absent from the public images and capture manifest.

To reproduce from the repository root, use a fresh temporary directory for `HEMI_USER_DATA_DIR`, then run:

```bash
npm run build
HEMI_USER_DATA_DIR="$(mktemp -d /tmp/hemi-docs-XXXXXX)" HEMI_SMOKE_TEST=1 \
  npx electron scripts/capture-070-features.mjs
```

The script saves full-window and focused captures, plus a redacted capture manifest, under `.visual/workflow/vision/070-features/` (ignored by Git). Five selected focused captures are used in the README. The New API entry image uses `feature-newapi-start-focus.png`; its full completion capture is kept with the local evidence because renderer-only capture does not include the native child browser view.

The usage image replaces the earlier scripted example. `scripts/capture-070-usage.mjs` submits a real task through the composer UI: review the supplied README translations and screenshot references, delegate factual checks and independent review, and write `readme-review.md`. The configured main/explorer model was `deepseek-v4.1-flash`; the oracle model was `claude-opus-5-5`. The report was written and both delegated tasks completed. The review used a document snapshot, not the whole source repository, so its recommendations are not product acceptance findings.

The production runtime recorded every provider request. After completion, the capture script read the normal usage IPC, hovered the actual UI trigger with Electron pointer events, and captured the popover bounds with `capturePage`. No responses, token counts, timings, role rows, DOM content, or persisted usage records were fabricated or edited. The final image is 1000×404 pixels; SHA-256: `c846a84d15e3af16c7c902b0d9ae33f90e174dc7d6e0cda69e3ba64e66383f6b`.

To reproduce with your own configured providers, prepare a fresh `/tmp/hemi-070-real-*` directory. Copy encrypted `text-model-profiles.json` and `onboarding.json` from your application data to that directory's root, optionally adding `text-model.json`; let the normal product migration create `runtime-v2`. Place the two READMEs, license files, and screenshot directory under `workspace/default`. Then run:

```bash
HEMI_USER_DATA_DIR=<isolated-directory> HEMI_SMOKE_TEST=1 HEMI_070_USAGE_RUN=1 \
  npx electron scripts/capture-070-usage.mjs
```

Omit `HEMI_070_USAGE_RUN` to recapture an existing isolated session without running another task. Local evidence includes `usage-real-capture.json` (redacted usage records and hashes), `readme-review-real.md`, `feature-usage-real-full.png`, and `feature-usage-real-focus.png`. The requirement's capture log records unrelated working-tree changes present during capture.
