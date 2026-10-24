import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installBotDependencies, readShellProxyEnvironment, INSTALL_FAILURE_MARKER } from './install-dependencies.mjs';
import { createBotTransport } from './transport.mjs';
const exec = promisify(execFile);

async function installWithDiagnostics(options) {
  try { return await installBotDependencies(options); } catch (error) {
    if (error.logFile) error.message += '\n' + (await fs.readFile(error.logFile, 'utf8')).slice(-4000);
    throw error;
  }
}

async function fixture(t, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-npm-install-'));
  const directory = path.join(dir, 'release'), root = path.join(dir, 'bot');
  await fs.mkdir(directory);
  const npmCli = path.join(dir, 'npm.mjs');
  await fs.writeFile(npmCli, `import fs from 'node:fs';\nconst file='calls.json';\nconst calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];\ncalls.push(process.argv.slice(2));\nfs.writeFileSync(file,JSON.stringify(calls));\n${source}`);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { root, directory, npmCli, dir, loadShellProxy: async () => ({}) };
}

test('npm internal failure retries once with private fresh cache, the selected Node and disabled install scripts', async t => {
  const f = await fixture(t, `if(calls.length===1){console.error('npm error Exit handler never called!');process.exitCode=1;}`);
  const result = await installBotDependencies(f);
  assert.equal(result.attempts.length, 2);
  const calls = JSON.parse(await fs.readFile(path.join(f.directory, 'calls.json')));
  for (const args of calls) {
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('--omit=dev'));
    assert.ok(!args.includes('--global'));
  }
  const cache = args => args[args.indexOf('--cache') + 1];
  assert.equal(cache(calls[0]), path.join(f.root, 'npm-cache'));
  assert.notEqual(cache(calls[0]), cache(calls[1]));
  assert.equal(await fs.stat(cache(calls[1])).then(() => true, () => false), false);
  assert.match(await fs.readFile(result.attempts[0].logFile, 'utf8'), /Exit handler never called/);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(result.logDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.attempts[0].logFile)).mode & 0o777, 0o600);
  }
});

test('permanent failures stop immediately; retryable failures are bounded and retain logs', async t => {
  for (const [output, kind, count] of [
    ['ENOSPC\nExit handler never called!', 'disk', 1],
    ['EACCES\nExit handler never called!', 'permission', 1],
    ['EUSAGE lock file is not in sync', 'lock', 1],
    ['Exit handler never called!', 'npm', 3],
    ['ETIMEDOUT\nExit handler never called!', 'network', 3],
    ['EINTEGRITY', 'cache', 2],
    ['E401 Unauthorized', 'other', 1],
    ['E403 Forbidden\nExit handler never called!', 'other', 1],
  ]) {
    const f = await fixture(t, `console.error(${JSON.stringify(output)});process.exitCode=1;`);
    await assert.rejects(installBotDependencies(f), asyncError => asyncError.kind === kind && asyncError.logFile.endsWith(`${count}.log`));
    const calls = JSON.parse(await fs.readFile(path.join(f.directory, 'calls.json')));
    assert.equal(calls.length, count, output);
    for (const args of calls.slice(1)) assert.equal(await fs.stat(args[args.indexOf('--cache') + 1]).then(() => true, () => false), false);
    assert.ok((await fs.readFile(path.join(f.root, 'install-logs', (await fs.readdir(path.join(f.root, 'install-logs')))[0], 'result.json'), 'utf8')).includes(kind));
  }
});

test('retry loads server shell proxies, supports ALL_PROXY, and keeps secrets out of result metadata', async t => {
  const proxy = 'socks5://fixture-user:fixture-password@127.0.0.1:1080';
  const f = await fixture(t, `if(calls.length===1){console.error('ECONNRESET');process.exitCode=1;}else{fs.writeFileSync('proxy.json',JSON.stringify({https:process.env.https_proxy,http:process.env.http_proxy,no:process.env.NO_PROXY}));}`);
  const result = await installBotDependencies({ ...f, env: { PATH: process.env.PATH }, loadShellProxy: async () => ({ ALL_PROXY: proxy, NO_PROXY: 'localhost' }) });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].strategy, 'shell-proxy');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'proxy.json'))), { https: proxy, http: proxy, no: 'localhost' });
  assert.ok(!(await fs.readFile(path.join(result.logDir, 'result.json'), 'utf8')).includes('fixture-password'));
});

test('network failures fall back to a direct mirror only for the final child, preserving server configuration', async t => {
  const f = await fixture(t, `if(calls.length<3){console.error('ETIMEDOUT');process.exitCode=1;}else{fs.writeFileSync('proxy.json',JSON.stringify(Object.keys(process.env).filter(key=>/proxy/i.test(key))));}`);
  const env = { PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'socks5://127.0.0.1:2', NPM_CONFIG_HTTPS_PROXY: 'http://127.0.0.1:3' };
  const result = await installBotDependencies({ ...f, env });
  assert.deepEqual(result.attempts.map(attempt => attempt.strategy), ['server', 'retry', 'npmmirror']);
  const calls = JSON.parse(await fs.readFile(path.join(f.directory, 'calls.json')));
  assert.ok(!calls[0].includes('--registry'));
  assert.ok(!calls[1].includes('--registry'));
  assert.equal(calls[2][calls[2].indexOf('--registry') + 1], 'https://registry.npmmirror.com/');
  assert.ok(calls[2].includes('--replace-registry-host=registry.npmjs.org'));
  assert.ok(calls[2].includes('--strict-ssl=true'));
  assert.ok(calls[2].includes('--https-proxy=null'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'proxy.json'))), []);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
});

test('shell proxy discovery reads an interactive shell, ignores banners and excludes unrelated secrets', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, '');
  const shell = path.join(f.dir, 'bash'), rc = path.join(f.dir, 'bashrc');
  await fs.writeFile(rc, 'printf shell-banner\nexport HTTPS_PROXY=http://127.0.0.1:7890\nexport NO_PROXY=localhost\nexport HEMI_UNRELATED_SECRET=private-fixture\n');
  await fs.writeFile(shell, `#!/bin/sh\nexec /bin/bash --noprofile --rcfile '${rc}' -ic "$2" "$3" "$4" "$5"\n`, { mode: 0o700 });
  const result = await readShellProxyEnvironment({ env: { HOME: f.dir, SHELL: shell, PATH: process.env.PATH } });
  assert.deepEqual(result, { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' });
  await fs.writeFile(rc, 'sleep 10\n');
  assert.deepEqual(await readShellProxyEnvironment({ env: { HOME: f.dir, SHELL: shell, PATH: process.env.PATH }, timeoutMs: 100 }), {});
});

test('a hung npm process is terminated and reported without retrying an uncertain process', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  await assert.rejects(installBotDependencies({ ...f, timeoutMs: 500 }), error => error.kind === 'timeout');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'calls.json'))).length, 1);
});

test('an exit-handler error is classified by the underlying failure in npm debug logs', async t => {
  const f = await fixture(t, `const log=process.argv[process.argv.indexOf('--logs-dir')+1];fs.writeFileSync(log+'/debug.log','http fetch GET registry request failed with ETIMEDOUT');console.error('npm error Exit handler never called!');process.exitCode=1;`);
  await assert.rejects(installBotDependencies(f), error => error.kind === 'network');
  const logs = await fs.readdir(path.join(f.root, 'install-logs'));
  assert.match(await fs.readFile(path.join(f.root, 'install-logs', logs[0], '2.log'), 'utf8'), /ETIMEDOUT/);
});

test('transport reports the installation cause and private log path instead of raw npm output', async t => {
  const f = await fixture(t, '');
  const archivePath = path.join(f.dir, 'runtime.tgz');
  await fs.writeFile(archivePath, 'fixture');
  let command;
  const transport = createBotTransport({ archivePath, runner: { exec: async value => {
    command = value.command;
    return { code: 1, stdout: Buffer.alloc(0), stderr: 'npm error secret-fixture-value\n' + INSTALL_FAILURE_MARKER + JSON.stringify({ kind: 'network', logFile: '/home/hemi/.local/share/hemi-bot/install-logs/fixture/2.log' }) + '\n' };
  } } });
  await assert.rejects(transport.install('fixture', { nodeBin: '/opt/node22/bin/node', home: '/home/hemi', root: '/home/hemi/.local/share/hemi-bot', arch: 'arm64' }), error => {
    assert.match(error.message, /下载 Bot 依赖失败/);
    assert.match(error.message, /install-logs\/fixture\/2.log/);
    assert.ok(!error.message.includes('secret-fixture-value'));
    return true;
  });
  assert.match(command, /'\/opt\/node22\/bin\/node' src\/main\/bot\/install-dependencies.mjs/);
});

test('deployed CLI returns a structured cause and retained log for an invalid dependency lock', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t, '');
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify({ name: 'invalid-lock-fixture', version: '1.0.0' }));
  await assert.rejects(exec(process.execPath, [path.join(import.meta.dirname, 'install-dependencies.mjs'), f.root], { cwd: f.directory }), error => {
    const line = error.stderr.trim();
    assert.ok(line.startsWith(INSTALL_FAILURE_MARKER));
    const result = JSON.parse(line.slice(INSTALL_FAILURE_MARKER.length));
    assert.equal(result.kind, 'lock');
    assert.ok(result.logFile.startsWith(f.root + path.sep));
    return true;
  });
});

test('production installation shell retains the active release, data and service when npm fails', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t, '');
  const root = path.join(f.dir, '.local/share/hemi-bot'), previous = path.join(root, 'releases/previous');
  const data = path.join(root, 'data/state.json'), service = path.join(f.dir, '.config/systemd/user/hemi-bot.service');
  await fs.mkdir(previous, { recursive: true });
  await fs.symlink(previous, path.join(root, 'current'));
  await fs.mkdir(path.dirname(data), { recursive: true });
  await fs.writeFile(data, 'original-data');
  await fs.mkdir(path.dirname(service), { recursive: true });
  await fs.writeFile(service, 'original-service');
  const sourceDir = path.join(f.directory, 'src/main/bot');
  await fs.mkdir(sourceDir, { recursive: true });
  for (const name of ['install-dependencies.mjs', 'storage.mjs']) await fs.copyFile(path.join(import.meta.dirname, name), path.join(sourceDir, name));
  await fs.mkdir(path.join(f.directory, 'src/main/lib'), {recursive: true});
  await fs.copyFile(path.join(import.meta.dirname, '../lib/rename-retry.mjs'), path.join(f.directory, 'src/main/lib/rename-retry.mjs'));
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify({ name: 'missing-lock-fixture', version: '1.0.0' }));
  const archivePath = path.join(f.dir, 'runtime.tgz');
  await exec('tar', ['-czf', archivePath, '-C', f.directory, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const runner = { async exec({ command, stdin }) {
    const pending = exec('/bin/sh', ['-c', command], { env: { ...process.env, HOME: f.dir }, encoding: 'buffer', timeout: 12000 });
    pending.child.stdin.end(stdin);
    try { const result = await pending; return { code: 0, ...result }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } };
  const transport = createBotTransport({ runner, archivePath });
  await assert.rejects(transport.install('fixture', { root, home: f.dir, nodeBin: process.execPath, arch: 'arm64', existing: true, bot: { activeJobs: 0 } }), /依赖清单不一致/);
  assert.equal(await fs.readlink(path.join(root, 'current')), previous);
  assert.equal(await fs.readFile(data, 'utf8'), 'original-data');
  assert.equal(await fs.readFile(service, 'utf8'), 'original-service');
  assert.equal(await fs.stat(path.join(root, 'install.lock')).then(() => true, () => false), false);
});

test('actual npm ci recovers from registry failures, verifies the locked package and never runs install scripts', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t, '');
  const packageDir = path.join(f.dir, 'package');
  await fs.mkdir(packageDir);
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'hemi-install-fixture', version: '1.0.0', scripts: { postinstall: 'node -e "process.exit(99)"' } }));
  await fs.writeFile(path.join(packageDir, 'proof.txt'), 'locked dependency bytes');
  const archive = path.join(f.dir, 'dependency.tgz');
  await exec('tar', ['-czf', archive, '-C', f.dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(archive);
  let downloads = 0;
  const server = http.createServer((_req, response) => {
    downloads++;
    if (downloads <= 2) { response.writeHead(503); response.end('temporary registry failure'); }
    else { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(bytes); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const pkg = { name: 'hemi-bot-install-fixture', version: '1.0.0', dependencies: { 'hemi-install-fixture': '1.0.0' }, scripts: { postinstall: 'node -e "process.exit(98)"' } };
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(f.directory, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': pkg,
    'node_modules/hemi-install-fixture': { version: '1.0.0', resolved: `http://127.0.0.1:${server.address().port}/dependency.tgz`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), hasInstallScript: true },
  } }));
  // Use the same npm entry resolution and process invocation as the deployed Host.
  const { npmCli, ...actual } = f;
  const result = await installBotDependencies(actual);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].code, 0);
  assert.ok(downloads >= 3);
  assert.equal(await fs.readFile(path.join(f.directory, 'node_modules/hemi-install-fixture/proof.txt'), 'utf8'), 'locked dependency bytes');
});

test('actual npm ci bypasses broken npmrc proxies for the mirror, preserves the lock and rejects changed package bytes', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t, '');
  const packageDir = path.join(f.dir, 'package');
  await fs.mkdir(packageDir);
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'hemi-mirror-fixture', version: '1.0.0', scripts: { postinstall: 'node -e "process.exit(99)"' } }));
  await fs.writeFile(path.join(packageDir, 'proof.txt'), 'integrity-locked bytes');
  const archive = path.join(f.dir, 'dependency.tgz');
  await exec('tar', ['-czf', archive, '-C', f.dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(archive);
  let tamper = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(tamper ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  // Reserve then release a port so the configured proxy deterministically fails.
  const dead = http.createServer();
  await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve));
  const deadProxy = `http://127.0.0.1:${dead.address().port}`;
  await new Promise(resolve => dead.close(resolve));
  const npmrc = `proxy=${deadProxy}\nhttps-proxy=${deadProxy}\nstrict-ssl=false\n`;
  const userConfig = path.join(f.dir, 'npmrc');
  await fs.writeFile(userConfig, npmrc);
  const pkg = { name: 'hemi-mirror-install-fixture', version: '1.0.0', dependencies: { 'hemi-mirror-fixture': '1.0.0' } };
  const lock = JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': pkg,
    'node_modules/hemi-mirror-fixture': { version: '1.0.0', resolved: 'https://registry.npmjs.org/hemi-mirror-fixture/-/hemi-mirror-fixture-1.0.0.tgz', integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), hasInstallScript: true },
  } });
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(f.directory, 'package-lock.json'), lock);
  const { npmCli, ...actual } = f;
  const options = { ...actual, env: { PATH: process.env.PATH, HOME: f.dir, npm_config_userconfig: userConfig }, mirrorRegistry: `http://127.0.0.1:${server.address().port}/` };
  const result = await installWithDiagnostics(options);
  assert.deepEqual(result.attempts.map(value => value.strategy), ['server', 'retry', 'npmmirror']);
  assert.equal(await fs.readFile(path.join(f.directory, 'node_modules/hemi-mirror-fixture/proof.txt'), 'utf8'), 'integrity-locked bytes');
  assert.deepEqual(requests, ['/hemi-mirror-fixture/-/hemi-mirror-fixture-1.0.0.tgz']);
  assert.equal(await fs.readFile(userConfig, 'utf8'), npmrc);
  assert.equal(await fs.readFile(path.join(f.directory, 'package-lock.json'), 'utf8'), lock);
  tamper = true;
  await assert.rejects(installBotDependencies({ ...options, root: path.join(f.dir, 'second-bot') }), error => error.kind === 'cache' && error.logFile.endsWith('3.log'));
});

test('actual npm uses the discovered shell proxy for locked downloads without contacting the mirror', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t, '');
  const packageDir = path.join(f.dir, 'package');
  await fs.mkdir(packageDir);
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'hemi-proxy-fixture', version: '1.0.0' }));
  const archive = path.join(f.dir, 'dependency.tgz');
  await exec('tar', ['-czf', archive, '-C', f.dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(archive), requests = [];
  const proxy = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(bytes);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); return new Promise(resolve => proxy.close(resolve)); });
  const origin = http.createServer((_request, response) => { response.writeHead(503); response.end('registry unavailable'); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => { origin.closeAllConnections(); return new Promise(resolve => origin.close(resolve)); });
  const resolved = `http://127.0.0.1:${origin.address().port}/dependency.tgz`;
  const userConfig = path.join(f.dir, 'npmrc');
  const npmrc = `proxy=http://127.0.0.1:${origin.address().port}\nhttps-proxy=http://127.0.0.1:${origin.address().port}\n`;
  await fs.writeFile(userConfig, npmrc);
  const pkg = { name: 'proxy-install-fixture', version: '1.0.0', dependencies: { 'hemi-proxy-fixture': '1.0.0' } };
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(f.directory, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': pkg,
    'node_modules/hemi-proxy-fixture': { version: '1.0.0', resolved, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
  } }));
  const { npmCli, ...actual } = f;
  const result = await installWithDiagnostics({ ...actual, env: { PATH: process.env.PATH, HOME: f.dir, npm_config_userconfig: userConfig }, loadShellProxy: async () => ({ ALL_PROXY: `http://127.0.0.1:${proxy.address().port}` }) });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].strategy, 'shell-proxy');
  assert.deepEqual(requests, [resolved]);
  assert.equal(await fs.readFile(userConfig, 'utf8'), npmrc);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'node_modules/hemi-proxy-fixture/package.json'))).version, '1.0.0');
});
