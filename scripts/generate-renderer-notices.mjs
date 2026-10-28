#!/usr/bin/env node
// Offline inventory of modules in the actual renderer build. No dependency updates.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {dependencySourcePath} from './lib/dependency-source-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const ids = new Set();
await build({
  root: path.join(root, 'src/renderer'),
  configFile: path.join(root, 'vite.config.ts'),
  build: { write: false },
  plugins: [{
    name: 'hemi-renderer-license-inventory',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          if (id.replaceAll('\\', '/').includes('/node_modules/')) ids.add(id);
        }
      }
    },
  }],
});

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const packages = new Map();
for (const id of [...ids].sort()) {
  const filename = id.split('?')[0].replaceAll('\0', '');
  if (!path.isAbsolute(filename)) throw new Error(`Unresolved bundle module: ${id}`);
  let dir = path.dirname(filename), manifest;
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (candidate.name && candidate.version) { manifest = candidate; break; }
    }
    dir = path.dirname(dir);
  }
  if (!manifest) throw new Error(`Missing package metadata: ${id}`);
  const relative = dependencySourcePath(root, dir);
  const key = `${manifest.name}@${manifest.version}`;
  let record = packages.get(key);
  if (!record) {
    record = { name: manifest.name, version: manifest.version, license: manifest.license ?? null, repository: manifest.repository ?? null, locations: [], modules: [], notices: [] };
    packages.set(key, record);
  }
  if (!record.locations.includes(relative)) {
    record.locations.push(relative);
    const licenseFiles = fs.readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
    for (const name of licenseFiles.sort()) {
      const bytes = fs.readFileSync(path.join(dir, name));
      record.notices.push({ source: `${relative}/${name}`, sha256: sha256(bytes), text: bytes.toString('utf8') });
    }
    if (!licenseFiles.length && manifest.name.startsWith('@flowgram.ai/') && manifest.version === '1.0.16') {
      const source = 'src/main/workflows/vendor/flowgram-engine/LICENSE';
      const bytes = fs.readFileSync(path.join(root, source));
      record.notices.push({ source, upstream: 'https://github.com/bytedance/flowgram.ai/blob/2ee4a9d2aaf11850276b7d72eeb0ad5bed0e2948/LICENSE', sha256: sha256(bytes), text: bytes.toString('utf8') });
    }
    if (!licenseFiles.length && manifest.name === 'bezier-js' && manifest.version === '6.1.4') {
      const source = `${relative}/src/bezier.js`;
      const text = fs.readFileSync(path.join(root, source), 'utf8').match(/^\/\*\*[\s\S]*?\*\//)?.[0];
      if (!text?.includes('MIT licensed')) throw new Error('bezier-js source license notice changed');
      record.notices.push({ source, upstream: 'https://github.com/Pomax/bezierjs/blob/a41f3e08e9724c9973eca0eb5c1304120e72fc70/src/bezier.js', sha256: sha256(text), text });
      const licenseSource = 'third-party/licenses/bezier-js-MIT.txt';
      const bytes = fs.readFileSync(path.join(root, licenseSource));
      record.notices.push({ source: licenseSource, upstream: 'https://github.com/Pomax/bezierjs/blob/4e767299184ab4079dc8d7c970020103db14f431/LICENSE.md', sha256: sha256(bytes), text: bytes.toString('utf8') });
    }
  }
  record.modules.push(dependencySourcePath(root, filename));
}

// Tailwind resolves @import itself, so these styles are not represented in JS
// chunk.modules. Record the explicit stylesheet inputs as a separate evidence type.
const globals = fs.readFileSync(path.join(root, 'src/renderer/src/globals.css'), 'utf8');
const styleInputs = [
  { specifier: 'tailwindcss', dir: 'node_modules/tailwindcss', file: 'index.css', licenseFile: 'LICENSE' },
  { specifier: 'tw-animate-css', dir: 'node_modules/tw-animate-css', file: 'dist/tw-animate.css', licenseFile: 'LICENSE' },
];
for (const item of styleInputs) {
  if (!globals.includes(`@import '${item.specifier}';`)) throw new Error(`Stylesheet import changed; update inventory: ${item.specifier}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, item.dir, 'package.json'), 'utf8'));
  const source = `${item.dir}/${item.file}`, licenseSource = `${item.dir}/${item.licenseFile}`;
  const bytes = fs.readFileSync(path.join(root, licenseSource));
  const key = `${pkg.name}@${pkg.version}`;
  const record = packages.get(key) ?? { name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository ?? null, locations: [item.dir], modules: [], notices: [] };
  record.modules.push(source);
  record.stylesheets = [{ source, sha256: sha256(fs.readFileSync(path.join(root, source))) }];
  if (!record.notices.some(notice => notice.source === licenseSource)) record.notices.push({ source: licenseSource, sha256: sha256(bytes), text: bytes.toString('utf8') });
  packages.set(key, record);
}
const shadcn = JSON.parse(fs.readFileSync(path.join(root, 'third-party/sources.json'), 'utf8')).components.find(item => item.stylesheet?.path === 'src/renderer/src/vendor/shadcn-tailwind.css');
if (!shadcn || !globals.includes("@import './vendor/shadcn-tailwind.css';")) throw new Error('Vendored shadcn stylesheet provenance or import missing');
for (const file of [shadcn.stylesheet, shadcn.licenseFile]) {
  if (sha256(fs.readFileSync(path.join(root, file.path))) !== file.sha256) throw new Error(`Vendored stylesheet input changed: ${file.path}`);
}
packages.set('shadcn@4.18.0', {
  name: 'shadcn', version: '4.18.0', license: shadcn.license, repository: 'https://github.com/shadcn-ui/ui',
  locations: ['src/renderer/src/vendor'], modules: [shadcn.stylesheet.path],
  stylesheets: [{ source: shadcn.stylesheet.path, sha256: shadcn.stylesheet.sha256 }],
  notices: [{ source: shadcn.licenseFile.path, upstream: shadcn.source, sha256: shadcn.licenseFile.sha256, text: fs.readFileSync(path.join(root, shadcn.licenseFile.path), 'utf8') }],
});

const records = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
for (const record of records) {
  record.locations.sort(); record.modules = [...new Set(record.modules)].sort();
  if (!record.license || !record.notices.length) throw new Error(`Missing license evidence: ${record.name}@${record.version}`);
}
const manifest = {
  scope: 'JavaScript modules represented in Vite output chunks plus explicit stylesheet inputs imported by globals.css; excludes main-process/native/Electron dependencies',
  lockfileSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
  components: records.map(({ notices, ...record }) => ({ ...record, notices: notices.map(({ text, ...notice }) => notice) })),
};
const texts = ['Hemi renderer third-party notices', 'Generated by node scripts/generate-renderer-notices.mjs.', 'License wording preserved; line endings and trailing whitespace normalized.', 'Packages marked REVIEW REQUIRED have unresolved upstream notice gaps.', ''];
for (const record of records) {
  texts.push('='.repeat(72), `${record.name}@${record.version} (${record.license})`);
  if (record.reviewRequired) texts.push(`REVIEW REQUIRED: ${record.reviewRequired}`);
  const seen = new Set();
  for (const notice of record.notices) {
    if (seen.has(notice.sha256)) continue;
    seen.add(notice.sha256);
    texts.push(`Source: ${notice.upstream ?? notice.source}`, '', notice.text.replaceAll('\r\n', '\n').replace(/[\t ]+$/gm, '').trimEnd(), '');
  }
}
const output = path.join(root, 'src/renderer/public/licenses');
fs.mkdirSync(output, { recursive: true });
for (const [name, content] of [['renderer-components.json', `${JSON.stringify(manifest, null, 2)}\n`], ['renderer-third-party.txt', `${texts.join('\n').trimEnd()}\n`]]) {
  const filename = path.join(output, name);
  if (checkOnly) {
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) throw new Error(`Stale renderer license output: ${name}`);
  } else fs.writeFileSync(filename, content);
}
console.log(JSON.stringify({ components: records.length, reviewRequired: records.filter(record => record.reviewRequired).map(record => `${record.name}@${record.version}`), mode: checkOnly ? 'check' : 'write' }));
