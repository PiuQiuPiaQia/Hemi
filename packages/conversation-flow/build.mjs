import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
fs.mkdirSync("dist", { recursive: true });
const previousJS = fs
  .readdirSync("dist")
  .filter((file) => file.endsWith(".js"));
execFileSync(
  process.execPath,
  [
    path.resolve("../../node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
  ],
  { stdio: "inherit" },
);
fs.copyFileSync("src/core/flow-window.d.mts", "dist/core/flow-window.d.mts");
const entries = [
  "index",
  "core",
  "react",
  "parts",
  "composer",
  "controls",
  "navigation",
  "resources",
  "types",
  "adapters/web-host",
  "adapters/native-host",
];
const bundled = await build({
  write: false,
  entryPoints: Object.fromEntries(
    entries.map((file) => [path.basename(file), `src/${file}.ts`]),
  ),
  outdir: "dist",
  bundle: true,
  format: "esm",
  splitting: true,
  packages: "external",
  jsx: "automatic",
  loader: { ".svg": "dataurl" },
  target: "es2022",
  metafile: true,
});
// Write shared chunks before entry points, without replacing the watched dist directory.
for (const output of [...bundled.outputFiles].sort(
  (a, b) =>
    Number(!path.basename(a.path).startsWith("chunk-")) -
    Number(!path.basename(b.path).startsWith("chunk-")),
))
  fs.writeFileSync(output.path, output.contents);
const currentJS = new Set(
  bundled.outputFiles.map((output) => path.basename(output.path)),
);
for (const file of previousJS)
  if (!currentJS.has(file)) fs.rmSync(path.join("dist", file));
const source = path.resolve("src/styles/source");
const uiStyles = path.resolve("../ui/src/styles");
const styleFile = (file) => {
  if (file === "tokens.css") return path.resolve("../ui/src/tokens.css");
  if (file === "native.css") return path.join(uiStyles, "native.css");
  if (file === "037-controls.css") return path.join(uiStyles, "controls.css");
  if (file === "040-popovers.css") return path.join(uiStyles, "popovers.css");
  if (file === "status.css") return path.join(uiStyles, "status.css");
  if (file === "dialog.css") return path.join(uiStyles, "dialog.css");
  return path.join(source, file);
};
const order = [
  "tokens.css",
  "native.css",
  "globals.css",
  "037-controls.css",
  "040-popovers.css",
  "037-chat.css",
  "037-composer.css",
  "037-task.css",
  "037-model.css",
  "048-thinking-usage.css",
  "050-result.css",
  "056-tools.css",
  "064-runtime.css",
  "dialog.css",
  "status.css",
  "037-overlays.css",
  "062-deliverables.css",
  "attachment-cards.css",
  "turn-activity.css",
  "059-workflows.css",
];
// Keep only selectors used by SDK components; desktop page chrome never ships here.
const words = new Set();
function readWords(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory() && entry.name !== "styles") readWords(file);
    else if (/\.[jt]sx?$/.test(entry.name))
      for (const word of fs
        .readFileSync(file, "utf8")
        .match(/[A-Za-z_][\w-]*/g) ?? [])
        words.add(word);
  }
}
readWords("src");
readWords("../ui/src");
function presentationCSS(file) {
  const ast = postcss.parse(
    fs.readFileSync(file, "utf8").replace(/^@import[^;]+;/gm, ""),
  );
  ast.walkRules((rule) => {
    let parent = rule.parent;
    while (parent) {
      if (parent.type === "atrule" && /keyframes$/.test(parent.name)) return;
      parent = parent.parent;
    }
    const selectors = rule.selectors.filter((selector) => {
      if (selector === "html" || selector === "body" || selector === "#root")
        return false;
      const classes = [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(
        (match) => match[1],
      );
      return (
        !classes.length ||
        classes.some(
          (name) =>
            name !== "compact-shell" && name !== "kb-nav" && words.has(name),
        )
      );
    });
    if (!selectors.length) rule.remove();
    else rule.selectors = selectors;
  });
  return ast.toString();
}
const input =
  '@import "tailwindcss" source(none);\n@source "./src";\n@source "../ui/src";\n' +
  order
    .filter((file) => fs.existsSync(styleFile(file)))
    .map((file) => presentationCSS(styleFile(file)))
    .join("\n");
const compiled = await postcss([tailwind({ optimize: false })]).process(input, {
  from: path.resolve("sdk-styles.css"),
});
const css = postcss.parse(compiled.css.replace(/--tw-/g, "--hcf-tw-"));
const animationNames = new Map();
css.walkAtRules(/keyframes$/, (rule) => {
  const name = rule.params;
  animationNames.set(name, "hcf-" + name);
  rule.params = "hcf-" + name;
});
css.walkDecls((decl) => {
  if (/^animation(?:-name)?$/.test(decl.prop))
    for (const [name, replacement] of animationNames)
      decl.value = decl.value.replace(
        new RegExp("(?<![\\w-])" + name + "(?![\\w-])", "g"),
        replacement,
      );
});
const scope = "[data-hemi-conversation-flow]";
css.walkRules((rule) => {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/.test(parent.name)) return;
    parent = parent.parent;
  }
  if (rule.selector.includes("&")) return;
  rule.selectors = rule.selectors.map((selector) => {
    let value = selector
      .replace(
        /html\.kb-nav\s+\.compact-shell/g,
        scope + '[data-hcf-keyboard="true"]',
      )
      .replace(/html\.kb-nav/g, scope + '[data-hcf-keyboard="true"]')
      .replace(/\.compact-shell/g, scope)
      .replace(/:root|#root|(?<![\w.-])(?:html|body)(?![\w-])/g, scope);
    return value.includes(scope) ? value : `${scope} ${value}`;
  });
});
css.walkDecls((decl) => {
  if (
    /^--(?!tw-|hcf-)/.test(decl.prop) &&
    decl.parent.type === "rule" &&
    decl.parent.selector === scope
  ) {
    decl.value = `var(--hcf-${decl.prop.slice(2)}, ${decl.value})`;
  }
});
const extra = fs.readFileSync("src/styles/sdk.css", "utf8");
fs.writeFileSync("dist/styles.css", css.toString() + "\n" + extra);
fs.mkdirSync("dist/styles", {recursive: true});
for (const name of fs.readdirSync(source).filter(name => !name.startsWith('.') && name.endsWith('.css')))
  fs.copyFileSync(path.join(source, name), path.join("dist/styles", name));
const names = new Set();
css.walkDecls((decl) => {
  if (/^--(?!tw-|hcf-)/.test(decl.prop)) names.add(decl.prop);
});
fs.writeFileSync(
  "dist/token-names.json",
  JSON.stringify([...names].sort()) + "\n",
);
const notices = ["Hemi conversation flow SDK third-party notices", ""];
const seenDependencies = new Set();
function notice(name, from = root) {
  let directory = from,
    entry;
  while (true) {
    const candidate = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      entry = fs.realpathSync(candidate);
      break;
    }
    const next = path.dirname(directory);
    if (next === directory) throw new Error(`Cannot resolve license: ${name}`);
    directory = next;
  }
  if (seenDependencies.has(entry)) return;
  seenDependencies.add(entry);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(entry, "package.json"), "utf8"),
  );
  const licenses = fs
    .readdirSync(entry)
    .filter(
      (file) =>
        /^(licen[cs]e|notice|copying)([.-]|$)/i.test(file) &&
        fs.statSync(path.join(entry, file)).isFile(),
    );
  if (!licenses.length) throw new Error(`Missing license evidence: ${name}`);
  notices.push(
    `${name}@${manifest.version} (${JSON.stringify(manifest.license)})`,
    ...licenses.map((file) => fs.readFileSync(path.join(entry, file), "utf8")),
    "",
  );
  for (const child of Object.keys(manifest.dependencies ?? {}).sort())
    notice(child, entry);
}
for (const name of Object.keys(
  JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies,
).sort())
  notice(name);
notice("tailwindcss");
notices.push(
  "Material Icon Theme (MIT)",
  fs.readFileSync("licenses/Material-Icon-Theme-MIT.txt", "utf8"),
);
fs.writeFileSync("THIRD-PARTY-NOTICES.md", notices.join("\n"));
console.log("Built conversation SDK, declarations, scoped CSS and notices");
