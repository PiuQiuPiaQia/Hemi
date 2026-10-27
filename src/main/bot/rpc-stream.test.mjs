import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
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
    await fs.rm(root, {recursive: true, force: true});
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
  const runner = createSshRunner({controlDir: path.join(root, 'ssh'), sshBin: ssh});
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
