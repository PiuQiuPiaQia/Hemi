import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'skills-market', 'source');
const outRoot = path.join(repoRoot, 'src', 'main', 'skills', 'official');
const definitions = [
  { id: 'source-check', author: 'Hemi', version: '1.0.0' },
  { id: 'meeting-notes', author: 'Hemi', version: '1.0.0' },
  { id: 'draft-review', author: 'Hemi', version: '1.0.0' },
];

async function sourceFiles(dir, prefix = '') {
  const out = [];
  for (const entry of (await readdir(path.join(dir, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(dir, relative));
    else if (entry.isFile()) out.push({ path: relative, contentBase64: (await readFile(path.join(dir, relative))).toString('base64') });
    else throw new Error(`不支持的源文件：${relative}`);
  }
  return out;
}

const items = [];
await mkdir(path.join(outRoot, 'bundles'), { recursive: true });
for (const definition of definitions) {
  const files = await sourceFiles(path.join(sourceRoot, definition.id));
  const skill = Buffer.from(files.find((file) => file.path === 'SKILL.md')?.contentBase64 ?? '', 'base64').toString('utf8');
  const name = skill.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const title = skill.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const description = skill.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== definition.id || !title || !description) throw new Error(`Skill 元数据缺失：${definition.id}`);
  const bundleName = `${definition.id}-${definition.version}.json`;
  const bytes = Buffer.from(JSON.stringify({ schema: 1, files }) + '\n');
  await writeFile(path.join(outRoot, 'bundles', bundleName), bytes);
  items.push({
    ...definition,
    name,
    title,
    description,
    package: `bundles/${bundleName}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    files: files.map((file) => file.path),
  });
}
await writeFile(path.join(outRoot, 'catalog.json'), JSON.stringify({
  schema: 1,
  publisher: 'Hemi',
  publishedAt: '2026-10-01',
  items,
}, null, 2) + '\n');
