import { defineConfig } from "vite";
// Makes the example usable as a local WebView asset bundle, with no asset server.
export default defineConfig({
  base: "./",
  resolve: { dedupe: ["react", "react-dom"] },
  build: { assetsInlineLimit: 10_000_000, cssCodeSplit: false },
});
