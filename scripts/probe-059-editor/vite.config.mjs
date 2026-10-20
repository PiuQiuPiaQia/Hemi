import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: process.env.PROBE_DIST_DIR || '/tmp/hemi-059-editor-probe',
    emptyOutDir: true,
  },
})
