import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({command}) => ({
  root: 'src/renderer',
  base: './',
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  plugins: [react()],
  // dev HUD 是条件懒加载的 CommonJS 依赖，预打包以稳定首开依赖 URL。
  optimizeDeps: {
    include: ['stats.js'],
  },
  resolve: {
    alias: {
      // Workspace development reads SDK source for reliable HMR; production consumes its public build.
      ...(command === 'serve' ? {
        '@hemi/conversation-flow/styles.css': path.resolve(import.meta.dirname, 'packages/conversation-flow/dist/styles.css'),
        '@hemi/conversation-flow/core': path.resolve(import.meta.dirname, 'packages/conversation-flow/src/core.ts'),
        '@hemi/conversation-flow/react': path.resolve(import.meta.dirname, 'packages/conversation-flow/src/react.ts'),
        '@hemi/conversation-flow/parts': path.resolve(import.meta.dirname, 'packages/conversation-flow/src/parts.ts'),
        '@hemi/conversation-flow': path.resolve(import.meta.dirname, 'packages/conversation-flow/src/index.ts'),
      } : {}),
      '@': path.resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Native resource copies are build outputs, not renderer HTML entry points.
    watch: { ignored: ['**/apps/*/dist/**', '**/apps/mobile/ios/**', '**/apps/mobile/android/**', '**/.visual/**'] },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
}));
