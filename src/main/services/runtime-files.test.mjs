import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listRuntimeFiles, readRuntimeFile } from './runtime-files.mjs';

test('runtime file transport reads original bytes and rejects traversal, symlinks and oversized files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-runtime-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'pi-memory');
  assert.deepEqual(await listRuntimeFiles(library), []);
  await fs.mkdir(library);
  await fs.mkdir(path.join(library, 'daily'));
  await fs.mkdir(path.join(library, 'recovery'));
  const original = '# 原生正文\n\n#preference 中文 😀\n';
  await fs.writeFile(path.join(library, 'MEMORY.md'), original);
  await fs.writeFile(path.join(library, 'USER.md'), 'must not be exposed');
  await fs.writeFile(path.join(library, 'daily/2026-10-26.md'), 'daily');
  await fs.writeFile(path.join(library, 'recovery/11111111-1111-4111-8111-111111111111.json'), '{"original":"deleted fact"}');
  assert.deepEqual((await listRuntimeFiles(library)).map(item => item.path).sort(), ['MEMORY.md', 'daily/2026-10-26.md', 'recovery/11111111-1111-4111-8111-111111111111.json'].sort());
  assert.equal((await readRuntimeFile(library, 'MEMORY.md')).text, original);
  for (const target of ['../MEMORY.md', '/MEMORY.md', 'USER.md', 'daily/../../secrets', 'recovery/not-an-id.json']) await assert.rejects(readRuntimeFile(library, target));
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(library, 'MEMORY.md'), path.join(library, 'SCRATCHPAD.md'));
    await assert.rejects(readRuntimeFile(library, 'SCRATCHPAD.md'));
    assert.equal((await listRuntimeFiles(library)).some(item => item.path === 'SCRATCHPAD.md'), false);
    await fs.symlink(library, path.join(root, 'alias'));
    await assert.rejects(listRuntimeFiles(path.join(root, 'alias')));
    await assert.rejects(readRuntimeFile(path.join(root, 'alias'), 'MEMORY.md'));
  }
  await fs.writeFile(path.join(library, 'MEMORY.md'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(readRuntimeFile(library, 'MEMORY.md'), /过大/);
});
