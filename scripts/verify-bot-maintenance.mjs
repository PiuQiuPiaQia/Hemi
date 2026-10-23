// Real SSH/systemd rollback and host identity verification, using only the disposable Linux fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createSshRunner } from '../src/main/remote/ssh-runner.mjs';
import { createBotTransport } from '../src/main/bot/transport.mjs';
import { buildBotRuntime } from './build-bot-runtime.mjs';
const exec = promisify(execFile),
  repo = path.resolve(import.meta.dirname, '..'),
  evidence = path.join(repo, '.visual/workflow/bot-implementation');
const context = JSON.parse(
    await fs.readFile(path.join(evidence, 'linux-validation.json'), 'utf8'),
  ),
  root = path.join(context.root, 'maintenance');
await fs.mkdir(root, { recursive: true });
const runner = createSshRunner({
    controlDir: path.join(root, 'ssh'),
    sshBin: context.sshBin,
    strictHostKeyChecking: true,
  }),
  checks = [];
const note = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const good = await buildBotRuntime({ output: path.join(root, 'good.tgz') }),
  transport = createBotTransport({ runner, archivePath: good }),
  target = 'hemi-bot-isolated';
async function until(fn) {
  let last;
  for (let n = 0; n < 50; n++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}
try {
  const before = await transport.probe(target);
  const hello = await transport.install(target, before);
  assert.equal(hello.instanceId, context.hello.instanceId);
  const snapshot = await transport.rpc(target, 'snapshot', {
    instanceId: hello.instanceId,
  });
  const stage = path.join(root, 'broken');
  await fs.mkdir(stage);
  await exec('tar', ['-xzf', good, '-C', stage]);
  const source = path.join(stage, 'src/main/bot/storage.mjs');
  await fs.writeFile(
    source,
    (await fs.readFile(source, 'utf8')).replace(
      'BOT_PROTOCOL = 1',
      'BOT_PROTOCOL = 999',
    ),
  );
  const bad = path.join(root, 'broken.tgz');
  await exec(
    'tar',
    ['--no-xattrs', '--no-acls', '-czf', bad, '-C', stage, '.'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  const broken = createBotTransport({ runner, archivePath: bad });
  await assert.rejects(
    () => broken.install(target, { ...before, bot: hello }),
    /已切回上一版本/,
  );
  const restored = await until(() => transport.rpc(target, 'handshake'));
  assert.equal(restored.instanceId, hello.instanceId);
  assert.equal(restored.protocol, 1);
  assert.equal(
    (await transport.rpc(target, 'snapshot', { instanceId: hello.instanceId }))
      .sessions.length,
    snapshot.sessions.length,
  );
  note('新组件启动失败后真实切回上一 release，实例、模型和会话保留');
  await exec('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    path.join(root, 'wrong-key'),
  ]);
  const config = await fs.readFile(context.sshConfig, 'utf8'),
    port = /Port (\d+)/.exec(config)[1],
    wrong = await fs.readFile(path.join(root, 'wrong-key.pub'), 'utf8');
  await fs.writeFile(
    path.join(root, 'known_hosts'),
    `[127.0.0.1]:${port} ${wrong}`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, 'ssh_config'),
    config.replace(
      /UserKnownHostsFile .*/,
      `UserKnownHostsFile ${path.join(root, 'known_hosts')}`,
    ),
  );
  await fs.writeFile(
    path.join(root, 'ssh-wrong'),
    `#!/bin/sh\nexec /usr/bin/ssh -F '${path.join(root, 'ssh_config')}' "$@"\n`,
    { mode: 0o700 },
  );
  const mismatch = createSshRunner({
    controlDir: path.join(root, 'wrong-sockets'),
    sshBin: path.join(root, 'ssh-wrong'),
    strictHostKeyChecking: true,
  });
  try {
    await assert.rejects(
      () =>
        createBotTransport({ runner: mismatch, archivePath: good }).probe(
          target,
        ),
      (e) => e.code === 'conflict',
    );
  } finally {
    mismatch.close();
  }
  note('服务器主机密钥不匹配时，真实 SSH 阻止探测和接管');
  await fs.writeFile(
    path.join(evidence, 'maintenance-validation.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        instanceId: restored.instanceId,
      },
      null,
      2,
    ),
  );
} finally {
  runner.close();
  await fs.rm(root, { recursive: true, force: true });
}
