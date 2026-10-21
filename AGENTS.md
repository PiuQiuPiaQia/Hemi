# Working on Hemi

Use Node.js 22.19 or later in the Node 22 line on macOS. Install dependencies with `npm ci`.

- `npm test`: unit and integration tests without external model credentials.
- `npm run build`: TypeScript checks and renderer build.
- `node scripts/check-spacing.mjs`: spacing token checks.
- `HEMI_SMOKE_TEST=1 npx electron .`: isolated application smoke test.

Choose validation based on the change's impact. For small, scoped changes, run only relevant checks and targeted tests. Do not run the full test suite or broad Electron/device regression by default. Run the full test suite for broad-impact changes and releases, with application regression checks covering the affected areas. The commands above are available checks, not a mandatory checklist for every change. Expand validation only when failures or unresolved concerns justify it.

Keep changes scoped and preserve unrelated work. When a change affects IPC or production services, verify the changed behavior against the actual implementation; mocks only establish behavior at their boundary. For UI lifecycle changes, verify the affected behavior in both the Vite development renderer and the built renderer. Record the tested commit, environment, commands, and remaining gaps.

Development data is separate from installed application data. Set `HEMI_USER_DATA_DIR` to a fresh temporary directory for isolated verification. Keep credentials, personal conversations, recordings, and local application data out of commits.

Preserve third-party copyright notices. After renderer dependency changes, run `node scripts/generate-renderer-notices.mjs` and review the generated license inventory and any unresolved notices. Native components require separate source and license checks.
