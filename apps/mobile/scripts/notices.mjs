import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {dependencySourcePath} from '../../../scripts/lib/dependency-source-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const visited = new Set();
const inventory = [];
const text = ['Hemi Mobile — third-party notices', ''];

function visit(name, from) {
  let folder = from;
  let location;
  while (true) {
    const candidate = path.join(folder, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      location = fs.realpathSync(candidate);
      break;
    }
    const parent = path.dirname(folder);
    if (parent === folder) throw new Error(`Missing dependency: ${name}`);
    folder = parent;
  }
  if (visited.has(location)) return;
  visited.add(location);
  const pkg = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
  const licenses = fs.readdirSync(location).filter(file =>
    /^(licen[cs]e|notice|copying)([.-]|$)/i.test(file) && fs.statSync(path.join(location, file)).isFile());
  if (!licenses.length) {
    // Some older MIT packages ship their full copyright and grant in README.
    for (const file of ['README.md', 'readme.md']) {
      const source = path.join(location, file);
      if (fs.existsSync(source) && /Copyright[\s\S]+Permission is hereby granted,[\s\S]+THE SOFTWARE IS PROVIDED/i.test(fs.readFileSync(source, 'utf8'))) {licenses.push(file);break;}
    }
  }
  if (!licenses.length) throw new Error(`Missing license evidence: ${name}`);
  inventory.push({
    name: pkg.name, version: pkg.version, license: pkg.license,
    repository: pkg.repository ?? null,
    location: dependencySourcePath(repository, location),
    notices: licenses.sort().map(file => {
      const bytes = fs.readFileSync(path.join(location, file));
      text.push(`${pkg.name}@${pkg.version} — ${file}`, bytes.toString('utf8'), '');
      return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
    }),
  });
  for (const child of Object.keys(pkg.dependencies ?? {}).sort()) visit(child, location);
}
for (const name of Object.keys(manifest.dependencies).sort()) visit(name, root);
// SDK icons and compiled CSS carry notices beyond its runtime npm dependencies.
text.push(fs.readFileSync(path.join(repository, 'packages/conversation-flow/THIRD-PARTY-NOTICES.md'), 'utf8'));
for (const [name, license, file] of [['PDF.js (embedded in unpdf)', 'Apache-2.0', 'PDFjs-LICENSE.txt'], ['Adobe CMaps', 'BSD-3-Clause', 'CMap-LICENSE.txt']]) {
  const source = path.join(repository, 'third-party/pdfjs', file), bytes = fs.readFileSync(source);
  inventory.push({name, version:'6.4.299', license, location:'third-party/pdfjs', notices:[{file,sha256:createHash('sha256').update(bytes).digest('hex')}]});
  text.push(`${name} — ${file}`, bytes.toString('utf8'), '');
}
// SwiftPM and the Apache-licensed Cordova native bridge are outside the npm license graph.
text.push(fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8'));
const output = path.join(root, 'public/licenses');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'notices.txt'), text.join('\n'));
fs.writeFileSync(path.join(output, 'components.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(`Mobile notices: ${inventory.length} packages, no unresolved npm notices`);
