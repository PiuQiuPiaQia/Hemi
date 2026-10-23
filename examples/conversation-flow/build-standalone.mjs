import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const result = await build({
  entryPoints: ["main.tsx"],
  write: false,
  bundle: true,
  alias: {
    react: path.dirname(require.resolve("react/package.json")),
    "react-dom": path.dirname(require.resolve("react-dom/package.json")),
  },
  format: "iife",
  jsx: "automatic",
  minify: true,
  loader: { ".css": "empty" },
  target: "es2022",
});
const css = readdirSync("dist/assets")
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync("dist/assets/" + file, "utf8"))
  .join("\n");
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
writeFileSync(
  "dist/standalone.html",
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Hemi conversation flow</title><style>' +
    css +
    '</style></head><body><div id="root"></div><script>' +
    js +
    "</script></body></html>",
);
console.log(
  "Built dist/standalone.html — bundled inline, no application server required",
);
