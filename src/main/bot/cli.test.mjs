import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rpc } from './cli.mjs';

test(
  'deployed symlink entry starts a real resident Host, socket is private and a second Host cannot replace it',
  { timeout: 15000, skip: process.platform === 'win32' && 'Linux Host Unix socket, symlink and POSIX permissions' },
  async (t) => {
    const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-cli-')),
      ),
      entry = path.join(root, 'current.mjs');
    await fs.symlink(path.join(import.meta.dirname, 'cli.mjs'), entry);
    const env = {
      ...process.env,
      HEMI_BOT_DATA_DIR: path.join(root, 'data'),
      HEMI_BOT_ISOLATED_TEST: '1',
    };
    const child = spawn(process.execPath, [entry, 'serve'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk) => (error += chunk));
    t.after(async () => {
      if (child.exitCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGTERM');
        await done;
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const socket = path.join(root, 'data/control.sock');
    let hello;
    for (let i = 0; i < 200; i++) {
      try {
        hello = await rpc({ method: 'handshake' }, { socket, timeoutMs: 1000 });
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(error);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(hello);
    assert.equal(hello.protocol, 1);
    assert.equal((await fs.stat(socket)).mode & 0o777, 0o600);
    const second = spawn(process.execPath, [entry, 'serve'], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const [code] = await once(second, 'exit');
    assert.notEqual(code, 0);
    const restored = await rpc({ method: 'handshake' }, { socket });
    assert.equal(restored.bootId, hello.bootId);
    assert.equal(restored.instanceId, hello.instanceId);
  },
);
