# Working on Hemi

Use Node.js 22.19 or later in the Node 22 line on macOS. Install dependencies with `npm ci`.

- `npm test`: unit and integration tests without external model credentials.
- `npm run build`: TypeScript checks and renderer build.
- `node scripts/check-spacing.mjs`: spacing token checks.
- `HEMI_SMOKE_TEST=1 npx electron .`: isolated application smoke test.

Keep changes scoped and preserve unrelated work. Check the actual IPC and production services for changed behavior; mocks only establish behavior at their boundary. For UI lifecycle changes, verify both the Vite development renderer and the built renderer. Record the tested commit, environment, commands, and remaining gaps.

Development data is separate from installed application data. Set `HEMI_USER_DATA_DIR` to a fresh temporary directory for isolated verification. Keep credentials, personal conversations, recordings, and local application data out of commits.

Preserve third-party copyright notices. After renderer dependency changes, run `node scripts/generate-renderer-notices.mjs` and review the generated license inventory and any unresolved notices. Native components require separate source and license checks.
