import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createRpcStream, serveRpcStream} from './rpc-stream.mjs';
import {createBotTransport} from './transport.mjs';
import {createSshRunner} from '../remote/ssh-runner.mjs';
import {rpc} from './cli.mjs';
import {botControlEndpoint, controlToken} from './control-endpoint.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('JSON-RPC correlates concurrent UTF-8 replies, cancelled late replies, and disconnects without replay', async t => {
  const input = new PassThrough(), output = new PassThrough(), gate = Promise.withResolvers(), started = Promise.withResolvers();
  const requests = [];
  const client = createRpcStream({start: async ({onStdin, onStdout, signal}) => {
    output.on('data', bytes => {for (const byte of bytes) onStdout(Buffer.from([byte]));});
    onStdin(async bytes => {input.write(bytes);});
    signal.addEventListener('abort', () => {input.destroy(); output.destroy();}, {once: true});
    await serveRpcStream({input, output, request: async request => {
      requests.push(request.method);
      if (request.method === 'slow') {started.resolve(); await gate.promise;}
      return {ok: true, result: request.params};
    }});
  }});
  t.after(() => {gate.resolve(); client.close();});
  const abort = new AbortController();
  const slow = client.request({method: 'slow', params: '晚到的回执🙂'}, {signal: abort.signal});
  await started.promise;
  assert.equal(await client.request({method: 'fast', params: '中文🙂'}), '中文🙂');
  abort.abort(); await assert.rejects(slow, {code: 'needs-review'});
  gate.resolve(); await delay(25);
  assert.equal(await client.request({method: 'after', params: true}), true, 'late cancelled response does not corrupt connection');
  const blocked = client.request({method: 'never', params: null});
  client.close(); await assert.rejects(blocked, error => ['offline', 'needs-review'].includes(error.code));
  assert.equal(requests.filter(method => method === 'slow').length, 1);
});

test('Windows transport reuses one real CLI/Host process channel and reconnects without replaying writes', {timeout: 30000}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-rpc-stream-')));
  const dataDir = path.join(root, 'data'), entry = path.join(import.meta.dirname, 'cli.mjs');
  const env = {...process.env, HEMI_BOT_DATA_DIR: dataDir, HEMI_BOT_ISOLATED_TEST: '1'};
  const host = spawn(process.execPath, [entry, 'serve'], {env, stdio: ['ignore', 'ignore', 'pipe']});
  let errors = '', transport;
  host.stderr.on('data', chunk => {errors += chunk;});
  t.after(async () => {
    transport?.disconnect();
    if (host.exitCode === null) {const ended = once(host, 'exit'); host.kill(); await ended;}
    await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  });
  let hello;
  for (let i = 0; i < 300; i++) {
    try {hello = await rpc({method: 'handshake'}, {socket: botControlEndpoint(dataDir, process.platform, controlToken(dataDir)), token: controlToken(dataDir), timeoutMs: 500}); break;}
    catch {if (host.exitCode !== null) throw new Error(errors); await delay(25);}
  }
  assert.ok(hello, errors);
  const log = path.join(root, 'launches.jsonl'), ssh = path.join(root, 'ssh.mjs');
  // Only the Windows shell/SSH OS boundary is substituted. The runner, CLI,
  // authenticated Host and state store below are production implementations.
  await fs.writeFile(ssh, `#!${process.execPath}
import fs from 'node:fs';import {spawn} from 'node:child_process';
if(process.argv.includes('-O'))process.exit(0);
const source=Buffer.from(process.argv.at(-1).split(' -EncodedCommand ')[1],'base64').toString('utf16le');
const mode=source.includes('" rpc-stream')?'rpc-stream':'rpc';
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({mode})+'\\n');
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(entry)},mode],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(dataDir)},HEMI_BOT_ISOLATED_TEST:'1'},stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
`, {mode: 0o700});
  // Windows 真机没有 POSIX shebang exec：直接 spawn .mjs 会被 CreateProcess 拒绝
  // （spawn EFTYPE）。按仓库构建命令监督器的口径（scripts/build-windows-command-job.mjs）
  // 用 .NET Framework 自带的 csc 现场编译一个透传启动器：argv、stdio 与退出码原样
  // 转交 node 执行上面的 ssh.mjs；runner、transport、CLI、Host 仍全是生产实现。
  let sshBin = ssh;
  if (process.platform === 'win32') {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const launcher = path.join(root, 'ssh-mock.exe'), source = path.join(root, 'ssh-mock.cs');
    await fs.writeFile(source, `using System;
using System.Diagnostics;
using System.Text;
class HemiSshMockLauncher {
    static int Main(string[] args) {
        var script = Environment.GetEnvironmentVariable("HEMI_TEST_SSH_MOCK");
        var node = Environment.GetEnvironmentVariable("HEMI_TEST_SSH_MOCK_NODE");
        if (string.IsNullOrEmpty(script) || string.IsNullOrEmpty(node)) {
            Console.Error.WriteLine("hemi ssh-mock launcher: HEMI_TEST_SSH_MOCK or HEMI_TEST_SSH_MOCK_NODE missing");
            return 255;
        }
        var line = new StringBuilder(Quote(script));
        foreach (var argument in args) line.Append(' ').Append(Quote(argument));
        using (var child = Process.Start(new ProcessStartInfo {
            FileName = node, Arguments = line.ToString(), UseShellExecute = false,
        })) {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
    static string Quote(string value) {
        var slash = Convert.ToChar(92).ToString();
        var mark = Convert.ToChar(34).ToString();
        return mark + (value ?? string.Empty).Replace(slash, slash + slash).Replace(mark, slash + mark) + mark;
    }
}
`);
    await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/out:' + launcher, source], {windowsHide: true, timeout: 30000});
    process.env.HEMI_TEST_SSH_MOCK = ssh;
    process.env.HEMI_TEST_SSH_MOCK_NODE = process.execPath;
    sshBin = launcher;
  }
  const runner = createSshRunner({controlDir: path.join(root, 'ssh'), sshBin});
  transport = createBotTransport({runner}); transport.setPlatform('fixture', 'win32');
  const call = (method, params = {}) => transport.rpc('fixture', method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params});
  assert.equal((await call('handshake')).bootId, hello.bootId);
  await call('snapshot');
  const snapshots = await Promise.all(Array.from({length: 8}, () => call('snapshot')));
  assert.ok(snapshots.every(value => value.instanceId === hello.instanceId));
  await assert.rejects(call('session.create'), {code: 'missing'});
  assert.equal((await call('handshake')).bootId, hello.bootId, 'rejected mutation leaves channel usable');
  let launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(launches.map(value => value.mode), ['rpc', 'rpc-stream']);
  transport.disconnect();
  await call('handshake'); await call('snapshot');
  launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(launches.map(value => value.mode), ['rpc', 'rpc-stream', 'rpc', 'rpc-stream']);
});
