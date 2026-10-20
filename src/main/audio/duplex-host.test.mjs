import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDuplexHost, resolveDuplexBin } from './duplex-host.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));

/**
 * 假 duplexd（真实子进程版）：HEMI_FAKE_DELAY_START_MS 毫秒后才回 ready，
 * 用于超时路径；常规路径用注入 spawnFn 的假 child（stdout 回调手动喂行）。
 */
const FAKE_HELPER = `#!/usr/bin/env node
const delay = Number(process.env.HEMI_FAKE_DELAY_START_MS || 0); // 由生成时改写
let out = '';
process.stdin.on('data', (chunk) => {
  out += chunk.toString('utf8');
  let nl;
  while ((nl = out.indexOf('\\n')) >= 0) {
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch { continue; }
    setTimeout(() => process.stdout.write('{"event":"ready"}\\n'), delay);
  }
});
`;

function makeDelayedHelper(delayMs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hemi-duplex-test-'));
  const file = path.join(dir, 'fake-duplexd');
  writeFileSync(file, FAKE_HELPER.replace(
    'Number(process.env.HEMI_FAKE_DELAY_START_MS || 0)',
    `Number(${delayMs})`,
  ));
  chmodSync(file, 0o755);
  return file;
}

/** 手动驱动测试用的 bin：真实存在即可执行文件（spawnFn 已注入，不会被真的跑）。 */
function makeDummyBin() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hemi-duplex-test-'));
  const file = path.join(dir, 'duplexd');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

/**
 * 可手动驱动的假 child 工厂：记录 stdin 命令；stdout 回调收集到数组，
 * 由测试喂事件行；exit 由测试触发。每个 spawnFn() 返回 {fake, feed, kill_, exit_}。
 */
function manualSpawn() {
  const instances = [];
  const spawnFn = () => {
    const stdoutCallbacks = [];
    const stdinLines = [];
    const listeners = { exit: [] };
    let killed = false;
    const instance = {
      stdin: {
        get writable() { return !killed; },
        write: (line) => stdinLines.push(JSON.parse(line)),
      },
      stdout: { on: (_name, cb) => stdoutCallbacks.push(cb) },
      stderr: { on: () => {} },
      on: (name, cb) => { if (name === 'exit') listeners.exit.push(cb); },
      once: (name, cb) => { if (name === 'exit') listeners.exit.push(cb); },
      kill: () => { killed = true; },
    };
    const handle = {
      commands: stdinLines,
      feedLine: (line) => { for (const cb of [...stdoutCallbacks]) cb(Buffer.from(`${line}\n`)); },
      fireExit: (code = 1) => { for (const cb of [...listeners.exit]) cb(code, null); },
    };
    instances.push(handle);
    return instance;
  };
  return { spawnFn, instances };
}

test('start resolves ready; cap/drained/underrun relay through events', async () => {
  const { spawnFn, instances } = manualSpawn();
  const host = createDuplexHost({ bin: makeDummyBin(), spawnFn });
  const startPromise = host.start();
  await wait(10);
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].commands.map((c) => c.cmd), ['start']);

  const capP = once(host.events, 'cap');
  const drainedP = once(host.events, 'drained');
  const underrunP = once(host.events, 'underrun');
  instances[0].feedLine('{"event":"ready","inFormat":"48000Hz/1ch"}');
  const result = await startPromise;
  assert.equal(result.ok, true);
  assert.equal(result.inFormat, '48000Hz/1ch');
  assert.equal(host.isActive, true);

  instances[0].feedLine('{"event":"cap","pcm":"AAAA","ms":21.3}');
  const cap = await capP;
  assert.equal(Buffer.compare(cap.data, Buffer.from('AAAA', 'base64')), 0);
  assert.equal(cap.ms, 21.3);

  instances[0].feedLine('{"event":"drained"}');
  instances[0].feedLine('{"event":"underrun"}');
  await drainedP;
  await underrunP;
  await host.stop();
});

test('binary missing: start fails cleanly', async () => {
  const host = createDuplexHost({ bin: '/nonexistent/hemi-duplexd-test' });
  const result = await host.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'binary-missing');
  assert.equal(host.isActive, false);
});

test('first-launch exit: start fails, no respawn (restarts only guard mid-session)', async () => {
  const { spawnFn, instances } = manualSpawn();
  const host = createDuplexHost({ bin: makeDummyBin(), spawnFn });
  const startPromise = host.start();
  await wait(10);
  instances[0].fireExit(1);
  const result = await startPromise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'helper-exited');
  assert.equal(host.isActive, false);
  await wait(80);
  assert.equal(instances.length, 1, '首启失败不得重启');
});

test('ready timeout (real delayed helper): fails and kills', { skip: process.platform === 'win32' ? '直接 spawn 无扩展名 shebang 脚本在 win 起不来（进程立即退出测不到 ready 超时）；duplex 音频链路 mac 专属' : false }, async () => {
  const host = createDuplexHost({ bin: makeDelayedHelper(60_000) });
  const result = await host.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ready-timeout');
  assert.equal(host.isActive, false);
});

test('mid-session exit: respawns and recovers; exhaustion gives failed', async () => {
  const { spawnFn, instances } = manualSpawn();
  const host = createDuplexHost({ bin: makeDummyBin(), spawnFn });
  const states = [];
  host.events.on('state', (snapshot) => states.push(snapshot.phase));

  const startPromise = host.start();
  await wait(10);
  instances[0].feedLine('{"event":"ready"}');
  assert.equal((await startPromise).ok, true);

  // 三次崩溃三次恢复（60s 窗口内允许 3 次重启）。
  for (let round = 1; round <= 3; round += 1) {
    instances.at(-1).fireExit(1);
    await wait(30);
    assert.equal(instances.length, round + 1, `第 ${round} 次重启`);
    instances.at(-1).feedLine('{"event":"ready"}');
    await wait(10);
  }
  assert.equal(host.isActive, true);

  // 第 4 次死亡：超预算 → failed，不再拉起。
  instances.at(-1).fireExit(1);
  await wait(50);
  assert.equal(instances.length, 4, '超限后不再重启');
  assert.equal(host.isActive, false);
  assert.equal(states.at(-1), 'failed');
});

test('stop is graceful: no respawn after explicit stop', async () => {
  const { spawnFn, instances } = manualSpawn();
  const host = createDuplexHost({ bin: makeDummyBin(), spawnFn });
  const startPromise = host.start();
  await wait(10);
  instances[0].feedLine('{"event":"ready"}');
  await startPromise;
  await host.stop();
  instances[0].fireExit(0); // stop 宽限内退出
  await wait(60);
  assert.equal(instances.length, 1, '主动停止不触发重启');
  assert.equal(host.isActive, false);
});

test('play/volume/stopPlay encode onto stdin (ArrayBuffer → base64)', async () => {
  const { spawnFn, instances } = manualSpawn();
  const host = createDuplexHost({ bin: makeDummyBin(), spawnFn });
  const startPromise = host.start();
  await wait(10);
  instances[0].feedLine('{"event":"ready"}');
  await startPromise;

  host.play(new Int16Array([0, 0x1234]).buffer);
  host.setVolume(0.25);
  host.setVolume(1.5); // 越界钳到 1
  host.stopPlay();
  const commands = instances[0].commands.map((entry) => entry.cmd);
  assert.deepEqual(commands, ['start', 'play', 'volume', 'volume', 'stopPlay']);
  const play = instances[0].commands.find((entry) => entry.cmd === 'play');
  assert.equal(Buffer.from(play.pcm, 'base64').length, 4);
  const volumes = instances[0].commands.filter((entry) => entry.cmd === 'volume');
  assert.equal(volumes[0].gain, 0.25);
  assert.equal(volumes[1].gain, 1);
  await host.stop();
});

test('resolveDuplexBin: env override wins; dev falls back to app dist', () => {
  const saved = process.env.HEMI_DUPLEX_BIN;
  try {
    process.env.HEMI_DUPLEX_BIN = '/opt/custom/duplexd';
    assert.equal(resolveDuplexBin({ isPackaged: false, getAppPath: () => '/repo' }), '/opt/custom/duplexd');
    delete process.env.HEMI_DUPLEX_BIN;
    assert.equal(resolveDuplexBin({ isPackaged: false, getAppPath: () => '/repo' }), path.join('/repo', 'dist', 'duplexd'));
  } finally {
    if (saved !== undefined) process.env.HEMI_DUPLEX_BIN = saved;
  }
});
