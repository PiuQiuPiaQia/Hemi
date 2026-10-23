// Container PID1 restarts verify systemd/linger and stopped-state persistence, not a physical kernel reboot.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createSshRunner } from '../src/main/remote/ssh-runner.mjs';
import { createBotTransport } from '../src/main/bot/transport.mjs';
const exec = promisify(execFile),
  repo = path.resolve(import.meta.dirname, '..'),
  evidence = path.join(repo, '.visual/workflow/bot-implementation'),
  context = JSON.parse(
    await fs.readFile(path.join(evidence, 'linux-validation.json'), 'utf8'),
  );
const runner = createSshRunner({
    controlDir: path.join(context.root, 'reboot-sockets'),
    sshBin: context.sshBin,
    strictHostKeyChecking: true,
  }),
  transport = createBotTransport({
    runner,
    archivePath: path.join(repo, 'build/hemi-bot-runtime.tgz'),
  }),
  host = 'hemi-bot-isolated',
  checks = [];
const note = (s) => {
  checks.push(s);
  console.log('PASS', s);
};
const wait = async (fn) => {
  let last;
  for (let n = 0; n < 60; n++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
};
async function syncFixturePort(){
 const port=(await exec('docker',['port',context.name,'22/tcp'])).stdout.trim().split(':').at(-1);
 const config=await fs.readFile(context.sshConfig,'utf8');await fs.writeFile(context.sshConfig,config.replace(/Port \d+/,`Port ${port}`),{mode:0o600});
 const known=path.join(context.root,'known_hosts'),keys=await fs.readFile(known,'utf8');await fs.writeFile(known,keys.replace(/\[127\.0\.0\.1\]:\d+/,`[127.0.0.1]:${port}`),{mode:0o600});
}
try {
  await syncFixturePort();
  const before = await transport.rpc(host, 'handshake');
  const call = (method, p = {}) =>
    transport.rpc(host, method, {
      instanceId: before.instanceId,
      requestId: 'op-' + crypto.randomUUID(),
      ...p,
    });
  const records = await call('snapshot');
  assert.equal(before.activeJobs, 0);
  runner.close();
  await exec('docker', ['restart', context.name]);
  await syncFixturePort();
  const after = await wait(() => transport.rpc(host, 'handshake'));
  assert.equal(after.instanceId, before.instanceId);
  assert.notEqual(after.bootId, before.bootId);
  assert.equal(after.activeJobs, 0);
  assert.equal(
    (await call('snapshot')).sessions.length,
    records.sessions.length,
  );
  note(
    '隔离 Linux PID1 重启后由 systemd/linger 自动恢复相同实例，不重放旧任务',
  );
  await call('service.stop');
  await transport.control(host, 'stop');
  runner.close();
  await exec('docker', ['restart', context.name]);
  await syncFixturePort();
  const stopped = await wait(() => transport.probe(host));
  assert.equal(stopped.existing, true);
  assert.equal(stopped.bot, undefined);
  assert.ok(stopped.serviceError);
  note('停止并禁用后再次重启，不擅自恢复 Bot');
  await fs.writeFile(
    path.join(evidence, 'residency-validation.json'),
    JSON.stringify(
      { date: new Date().toISOString(), checks, instanceId: before.instanceId },
      null,
      2,
    ),
  );
} finally {
  runner.close();
}
