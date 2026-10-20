#!/usr/bin/env node
// License/source materials are pinned to the dependency versions being shipped.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'third-party/release-materials.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const [name, version] of Object.entries(manifest.npmVersions)) {
  const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith(`/node_modules/${name}`) || key === `node_modules/${name}`);
  if (!entries.length || entries.some(([, value]) => value.version !== version)) throw new Error(`Refresh native license materials for ${name}@${version}`);
}
for (const item of manifest.files) {
  if (!item.path.startsWith('third-party/') || item.path.includes('..') || path.isAbsolute(item.path)) throw new Error('Invalid material path');
  const bytes = fs.readFileSync(path.join(root, item.path));
  if (bytes.length !== item.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Release material changed: ${item.path}`);
}
const native = JSON.parse(fs.readFileSync(path.join(root, 'third-party/native-components.json'), 'utf8'));
if (!native.components.length || native.components.some(item => !item.license || !item.notices.length)) throw new Error('Incomplete native notices');
console.log(`Release materials verified: ${manifest.files.length} files; ${native.components.length} native source components`);
