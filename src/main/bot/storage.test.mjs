import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {atomicJson} from './storage.mjs';
import {retryingRenameSync} from '../lib/rename-retry.mjs';
import {psLiteral} from './windows-transport.mjs';

test('atomicJson preserves serialization errors and cleans its uncommitted temporary file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-json-error-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'state.json'); atomicJson(file, {generation: 'old'});
  const error = new Error('serialization failed');
  assert.throws(() => atomicJson(file, {toJSON() {throw error;}}), value => value === error);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {generation: 'old'});
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

async function lockedTarget(t, holdMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-json-lock-'));
  const file = path.join(root, 'state.json');
  atomicJson(file, {generation: 'old'});
  // A separate OS process releases the handle even while Node's synchronous
  // retry blocks its event loop. ReadWrite permits reads, but NOT deletion.
  const script = `$ErrorActionPreference='Stop'; $f=[IO.File]::Open(${psLiteral(file)},'Open','Read',[IO.FileShare]::ReadWrite); try { [Console]::WriteLine('READY'); Start-Sleep -Milliseconds ${holdMs} } finally { $f.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(root, {recursive: true, force: true});
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lock helper readiness timed out: ' + stderr)), 10000);
    child.stdout.once('data', data => {
      clearTimeout(timer);
      if (String(data).trim() === 'READY') resolve(); else reject(new Error(String(data)));
    });
    child.once('error', error => {clearTimeout(timer); reject(error);});
    exited.then(([code]) => {clearTimeout(timer); if (code !== 0) reject(new Error('Lock helper failed: ' + stderr));});
  });
  return {root, file};
}

test('atomicJson replaces a real Windows locked target after the former 150ms budget', {skip: process.platform !== 'win32'}, async t => {
  const {root, file} = await lockedTarget(t, 900);
  const probe = path.join(root, 'probe.tmp'); fs.writeFileSync(probe, 'probe');
  const oldPolicy = retryingRenameSync(fs.renameSync, {attempts: 5});
  assert.throws(() => oldPolicy(probe, file), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {generation: 'old'});
  fs.rmSync(probe);
  atomicJson(file, {generation: 'new', sibling: 'retained'});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {generation: 'new', sibling: 'retained'});
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('atomicJson propagates a persistent real sharing failure and keeps old JSON without orphan temps', {skip: process.platform !== 'win32'}, async t => {
  const {root, file} = await lockedTarget(t, 15000);
  const started = performance.now();
  assert.throws(() => atomicJson(file, {generation: 'uncommitted'}), error => {
    assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.equal(error.syscall, 'rename'); assert.equal(error.dest, file);
    assert.match(error.path, /\.tmp$/); return true;
  });
  assert.ok(performance.now() - started < 6000, 'persistent lock has a bounded retry budget');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {generation: 'old'});
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});
