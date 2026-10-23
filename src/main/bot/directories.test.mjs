import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBotTransport } from './transport.mjs';
import { createBotDesktopService } from './desktop-service.mjs';
const exec = promisify(execFile);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-directory-')));
  const runner = {
    async exec({ command }) {
      try {
        const result = await exec('/bin/sh', ['-c', command], { env: { ...process.env, HOME: root }, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
        return { code: 0, stdout: result.stdout, stderr: result.stderr.toString() };
      } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr.toString() }; }
    },
    close() {},
  };
  const transport = createBotTransport({ runner });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runner, transport };
}

test('pre-install browser executes the production shell, preserving names and following directory symlinks', async t => {
  const f = await fixture(t), parent = path.join(f.root, 'projects');
  await fs.mkdir(parent);
  const names = ['alpha', '项目 space', "folder'quoted", 'line\nbreak'];
  for (const name of [...names, '.hidden']) await fs.mkdir(path.join(parent, name));
  await fs.symlink(path.join(parent, 'alpha'), path.join(parent, 'linked'));
  await fs.writeFile(path.join(parent, 'ordinary-file'), 'not a folder');
  const result = await f.transport.directory('fixture', '~/projects');
  assert.equal(result.path, parent);
  assert.equal(result.parent, f.root);
  assert.equal(result.home, f.root);
  assert.deepEqual(result.folders.map(x => x.name), [...names, 'linked'].sort((a, b) => a.localeCompare(b)));
  assert.ok(result.folders.every(x => x.path === path.join(parent, x.name)));
  assert.equal(result.truncated, false);
});

test('candidate directory flow distinguishes a not-yet-created default workspace and can browse its real parent', async t => {
  const f = await fixture(t);
  const transport = { ...f.transport, probe: async () => ({ home: f.root, existing: false }) };
  const client = createBotDesktopService({ userDataDir: path.join(f.root, 'desktop'), runner: f.runner, profiles: {}, transport });
  t.after(() => client.close());
  const state = await client.connect({ host: 'fixture' });
  const id = state.candidate.id, missing = path.join(f.root, 'hemi-workspace');
  await assert.rejects(client.candidatesDirectory(id, missing), e => e.code === 'missing' && /找不到/.test(e.message));
  assert.equal(await fs.stat(missing).then(() => true, () => false), false, 'browsing must not create the prospective workspace');
  assert.equal((await client.candidatesDirectory(id, path.dirname(missing))).path, f.root);
  const file = path.join(f.root, 'a-file'); await fs.writeFile(file, 'file');
  await assert.rejects(client.candidatesDirectory(id, file), e => e.code === 'missing' && /不是一个文件夹/.test(e.message));
});

test('unreadable folders return a permission error rather than a missing-folder or SSH error', async t => {
  if (process.getuid?.() === 0) return t.skip('permission check requires a non-root test account');
  const f = await fixture(t), locked = path.join(f.root, 'locked');
  await fs.mkdir(locked); await fs.chmod(locked, 0);
  try {
    await assert.rejects(f.transport.directory('fixture', locked), e => e.code === 'permission');
    await assert.rejects(f.transport.directory('fixture', path.join(locked, 'nested')), e => e.code === 'permission');
  }
  finally { await fs.chmod(locked, 0o700); }
});

test('large directories have a bounded result and explicit truncation', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 1002 }, (_, i) => fs.mkdir(path.join(f.root, 'folder-' + String(i).padStart(4, '0')))));
  const result = await f.transport.directory('fixture', '~');
  assert.equal(result.folders.length, 1000);
  assert.equal(result.truncated, true);
});

test('untrusted directory text is quoted and never executed as a shell command', async t => {
  const f = await fixture(t), target = path.join(f.root, "a'$(touch INJECTED)");
  await fs.mkdir(target);
  assert.equal((await f.transport.directory('fixture', target)).path, target);
  assert.equal(await fs.stat(path.join(f.root, 'INJECTED')).then(() => true, () => false), false);
  await assert.rejects(f.transport.directory('fixture', 'relative/path'), /绝对文件夹路径/);
  await assert.rejects(f.transport.directory('fixture', '/bad\0path'), /绝对文件夹路径/);
});

test('connection failures retain their category; malformed directory replies cannot be selected', async () => {
  for (const [result, code] of [
    [{ code: 255, connError: 'hostkey' }, 'conflict'],
    [{ code: 255, connError: 'auth' }, 'permission'],
    [{ code: 255, connError: 'unreachable' }, 'offline'],
    [{ code: 0, timedOut: true }, 'needs-review'],
    [{ code: 0, stdout: Buffer.from('not a directory reply') }, 'offline'],
    [{ code: 0, stdout: Buffer.from('__HEMI_DIR_V1__\0ok\0/broken') }, 'offline'],
  ]) {
    const transport = createBotTransport({ runner: { exec: async () => ({ stdout: Buffer.alloc(0), stderr: '', ...result }) } });
    await assert.rejects(transport.directory('fixture', '~'), e => e.code === code);
  }
});
