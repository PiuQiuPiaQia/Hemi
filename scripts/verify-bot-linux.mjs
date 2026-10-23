import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createSshRunner, shq } from '../src/main/remote/ssh-runner.mjs';
import { createBotTransport } from '../src/main/bot/transport.mjs';
import { buildBotRuntime } from './build-bot-runtime.mjs';
const exec = promisify(execFile),
  repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-linux-')),
  name = 'hemi-bot-verify-' + Date.now(),
  image = 'hemi-bot-verification:node22';
const command = async (bin, args, options = {}) =>
  exec(bin, args, { maxBuffer: 20 * 1024 * 1024, ...options });
const docker = (...args) => command('docker', args);
const checks = [];
let runner;
const note = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const wait = async (fn) => {
  let last;
  for (let i = 0; i < 90; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
};
try {
  const context = path.join(root, 'context');
  await fs.mkdir(context);
  await fs.writeFile(
    path.join(context, 'Dockerfile'),
    await fs.readFile(path.join(repo, 'scripts/fixtures/cloud-bot/Dockerfile')),
  );
  await docker('build', '-t', image, context);
  // systemd requires its own cgroup hierarchy. No host filesystem or user data is mounted.
  await docker(
    'run',
    '-d',
    '--privileged',
    '--cgroupns=private',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    '--hostname',
    'hemi-bot-model',
    '--name',
    name,
    '-p',
    '127.0.0.1::22',
    image,
  );
  await command('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    path.join(root, 'identity'),
  ]);
  await docker(
    'exec',
    name,
    'install',
    '-d',
    '-m',
    '700',
    '-o',
    'hemi',
    '-g',
    'hemi',
    '/home/hemi/.ssh',
  );
  await docker(
    'cp',
    path.join(root, 'identity.pub'),
    name + ':/home/hemi/.ssh/authorized_keys',
  );
  await docker(
    'exec',
    name,
    'chown',
    'hemi:hemi',
    '/home/hemi/.ssh/authorized_keys',
  );
  await docker('exec', name, 'chmod', '600', '/home/hemi/.ssh/authorized_keys');
  const mapped = (await docker('port', name, '22/tcp')).stdout
      .trim()
      .split(':')
      .at(-1),
    pub = (
      await docker('exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')
    ).stdout.trim();
  await fs.writeFile(
    path.join(root, 'known_hosts'),
    `[127.0.0.1]:${mapped} ${pub}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, 'ssh_config'),
    `Host hemi-bot-isolated\n HostName 127.0.0.1\n Port ${mapped}\n User hemi\n IdentityFile ${path.join(root, 'identity')}\n UserKnownHostsFile ${path.join(root, 'known_hosts')}\n StrictHostKeyChecking yes\n IdentitiesOnly yes\n`,
    { mode: 0o600 },
  );
  const wrapper = path.join(root, 'ssh');
  await fs.writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/ssh -F ${shq(path.join(root, 'ssh_config'))} "$@"\n`,
    { mode: 0o700 },
  );
  runner = createSshRunner({
    controlDir: path.join(root, 'sockets'),
    sshBin: wrapper,
    strictHostKeyChecking: true,
  });
  const archivePath = await buildBotRuntime({
    output: path.join(root, 'runtime.tgz'),
  });
  const transport = createBotTransport({ runner, archivePath }),
    target = 'hemi-bot-isolated';
  const info = await wait(() => transport.probe(target));
  assert.equal(info.platform, 'linux');
  assert.equal(info.existing, false);
  note('真实 SSH 严格主机密钥、Linux/Node/systemd/linger 探测');
  const hello = await transport.install(target, info);
  assert.equal(hello.protocol, 1);
  assert.equal(hello.platform, 'linux');
  note('部署真实包、npm ci、systemd 用户服务并握手');
  await docker(
    'cp',
    path.join(repo, 'scripts/fixtures/cloud-bot/model-server.mjs'),
    name + ':/tmp/model-server.mjs',
  );
  await docker('exec', '-d', name, 'node', '/tmp/model-server.mjs');
  const call = (method, p = {}) =>
    transport.rpc(target, method, {
      instanceId: hello.instanceId,
      requestId: 'op-' + crypto.randomUUID(),
      ...p,
    });
  const result = await call('model.sync', {
    models: [
      {
        modelKey: 'test/fixture',
        providerId: 'test',
        name: '隔离模型',
        model: 'fixture-model',
        baseUrl: 'http://hemi-bot-model:3030/v1',
        api: 'openai-completions',
        apiKey: 'fixture-only-key',
        thinkingLevel: 'off',
      },
    ],
  });
  assert.equal(result.results[0].ok, true);
  await call('configure', { defaultModel: 'test/fixture' });
  await call('initialize.verify');
  note('云端 Pi SDK 真实验证模型并保存私有配置');
  const a = await call('session.create');
  await call('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: {
        inputId: 'linux-input-file',
        text: '生成文件，验证真实云端运行',
      },
    },
  });
  const settled = await wait(async () => {
    const value = await call('session.open', { id: a.id });
    assert.equal(value.flow.phase, 'idle');
    assert.ok(Object.values(value.flow.artifacts).length);
    return value;
  });
  const artifact = Object.values(settled.flow.artifacts)[0];
  const file = await call('file.download', {
    id: a.id,
    artifactId: artifact.artifactId,
  });
  assert.equal(
    Buffer.from(file.base64, 'base64').toString(),
    'cloud host proof',
  );
  note('真实 Agent、Linux bash、交付登记与文件下载字节');
  await call('flow.command', {
    id: a.id,
    command: {
      type: 'send',
      input: { inputId: 'linux-input-background', text: '延时任务' },
    },
  });
  runner.close();
  await new Promise((r) => setTimeout(r, 10000));
  const background = await call('session.open', { id: a.id });
  assert.ok(
    background.flow.timeline.some(
      (i) => i.kind === 'user' && i.id === 'linux-input-background',
    ),
  );
  await wait(async () => {
    const value = await call('session.open', { id: a.id });
    assert.equal(value.flow.phase, 'idle');
    return value;
  });
  note('关闭 SSH 主连接后 Host 继续已受理工作');
  const dirs = await call('directory.list', { path: '/home/hemi' });
  assert.ok(dirs.folders.some((d) => d.name === 'hemi-workspace'));
  note('读取服务器真实目录列表');
  const permissions = await docker(
    'exec',
    name,
    'stat',
    '-c',
    '%a',
    '/home/hemi/.local/share/hemi-bot/data/state.json',
  );
  assert.equal(permissions.stdout.trim(), '600');
  note('模型和会话文件只允许运行账号访问');
  await call('service.stop');
  await transport.control(target, 'stop');
  await transport.control(target, 'start');
  await call('service.start');
  const restored = await call('session.open', { id: a.id });
  assert.equal(restored.flow.timeline.length, background.flow.timeline.length);
  note('停止、禁用与重新启用后恢复同一实例和会话');
  const evidence = {
    date: new Date().toISOString(),
    root,
    name,
    image,
    sshConfig: path.join(root, 'ssh_config'),
    sshBin: wrapper,
    hello,
    checks,
  };
  await fs.mkdir(path.join(repo, '.visual/workflow/bot-implementation'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      repo,
      '.visual/workflow/bot-implementation/linux-validation.json',
    ),
    JSON.stringify(evidence, null, 2),
  );
  if (process.env.HEMI_KEEP_BOT_TEST_CONTAINER === '1') {
    console.log(
      'KEPT',
      JSON.stringify({
        name,
        root,
        sshBin: wrapper,
        host: target,
        instanceId: hello.instanceId,
      }),
    );
    process.exitCode = 0;
  } else await docker('rm', '-f', name);
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
  await docker(
    'exec',
    name,
    'journalctl',
    '--no-pager',
    '-n',
    '45',
    '_SYSTEMD_USER_UNIT=hemi-bot.service',
  ).then(
    (r) => console.error(r.stdout),
    () => {},
  );
  await docker('logs', '--tail', '15', name).then(
    (r) => console.error(r.stdout),
    () => {},
  );
  if (process.env.HEMI_KEEP_BOT_TEST_CONTAINER !== '1')
    await docker('rm', '-f', name).catch(() => {});
  else console.error('KEPT_FAILED', JSON.stringify({ name, root }));
} finally {
  runner?.close();
  if (process.env.HEMI_KEEP_BOT_TEST_CONTAINER !== '1')
    await fs.rm(root, { recursive: true, force: true });
}
