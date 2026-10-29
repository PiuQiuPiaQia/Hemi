import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildBotRuntime} from '../../../scripts/build-bot-runtime.mjs';
import {readComponentVersion, componentUpdateNeeded, formatComponentVersion, COMPONENT_MANIFEST} from './component-version.mjs';
import {createBotTransport} from './transport.mjs';

const version = (value, build = 'a'.repeat(64)) => ({version: value, build});
test('component comparison upgrades legacy/older builds and never downgrades a newer release', () => {
  assert.equal(componentUpdateNeeded(version('0.2.15'), null), true);
  assert.equal(componentUpdateNeeded(version('0.2.15'), version('0.2.15')), false);
  assert.equal(componentUpdateNeeded(version('0.2.15'), version('0.2.15', 'b'.repeat(64))), true);
  assert.equal(componentUpdateNeeded(version('0.2.16'), version('0.2.15')), true);
  assert.equal(componentUpdateNeeded(version('0.2.15'), version('0.3.0')), false);
  assert.equal(formatComponentVersion('0.2.20',1),'0.2.20.1');
  assert.equal(componentUpdateNeeded(version('0.2.20.1'),version('0.2.20')),true);
  assert.equal(componentUpdateNeeded(version('0.2.20.10'),version('0.2.20.2')),true);
  assert.equal(componentUpdateNeeded(version('0.2.20.2'),version('0.2.20.10')),false);
  assert.equal(componentUpdateNeeded(version('0.2.21.0'),version('0.2.20.99')),true);
  assert.equal(componentUpdateNeeded(version('0.2.20.1'),version('0.2.20.1')),false);
  assert.equal(componentUpdateNeeded(version('0.2.20.1'),version('0.2.20.1','b'.repeat(64))),true);
  assert.equal(componentUpdateNeeded(version('0.2.20.1'),version('0.2.25')),false,'legacy migration requires explicit replacement');
});
test('runtime manifest identifies packaged source content and verifies the exact archive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-component-build-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const folder of ['src/main', 'src/shared', 'third-party']) await fs.mkdir(path.join(root, folder), {recursive: true});
  await fs.cp(path.resolve(import.meta.dirname, '../../../extensions/chrome-extension'), path.join(root, 'extensions/chrome-extension'), {recursive: true});
  const windowPath='packages/conversation-flow/src/core/flow-window.mjs';await fs.mkdir(path.dirname(path.join(root,windowPath)),{recursive:true});await fs.copyFile(path.resolve(import.meta.dirname,'../../..',windowPath),path.join(root,windowPath));
  await fs.writeFile(path.join(root, 'src/main/example.mjs'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'third-party/example.bin'), Buffer.from([0, 13, 10, 255]));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({version: '0.2.15', dependencies: {}}));
  const versionFile = path.join(root, 'bot-component-version.json');
  await fs.writeFile(versionFile, JSON.stringify({revision: 1}));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({packages: {}}));
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await fs.writeFile(path.join(root, file), 'test license\n');
  const output = path.join(root, 'first.tgz');
  await buildBotRuntime({root, output});
  assert.deepEqual(execFileSync('tar',['-xOf',output,'./'+windowPath]),await fs.readFile(path.join(root,windowPath)));
  const first = readComponentVersion(output + '.manifest.json');
  assert.equal(first.version, '0.2.15.1', 'component version combines the application version and its revision');
  const embedded = JSON.parse(execFileSync('tar', ['-xOf', output, './' + COMPONENT_MANIFEST], {encoding: 'utf8'}));
  assert.equal(first.build, embedded.build);
  assert.equal(first.archiveSha256, createHash('sha256').update(await fs.readFile(output)).digest('hex'));
  for (const name of ['page-logic.js', 'page-operations.js']) assert.deepEqual(execFileSync('tar', ['-xOf', output, './extensions/chrome-extension/' + name]), await fs.readFile(path.join(root, 'extensions/chrome-extension', name)));
  await buildBotRuntime({root, output: path.join(root, 'same.tgz')});
  assert.equal(readComponentVersion(path.join(root, 'same.tgz.manifest.json')).build, first.build);
  const independent=path.join(root,'component-patch.tgz');
  await fs.writeFile(versionFile, JSON.stringify({revision: 2}));
  await buildBotRuntime({root,output:independent});
  const independentVersion=readComponentVersion(independent+'.manifest.json');
  assert.equal(independentVersion.version,'0.2.15.2');
  assert.equal(independentVersion.build,first.build,'component version metadata does not change verified runtime source');
  assert.equal(componentUpdateNeeded(first,independentVersion),false,'an older desktop must not replace the independently updated component');
  assert.equal(componentUpdateNeeded(independentVersion,first),true,'a component patch advances without a desktop version change');
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version,'0.2.15');
  await fs.writeFile(versionFile, JSON.stringify({revision: 1}));
  await fs.writeFile(path.join(root, 'src/main/example.mjs'), 'export const value = 1;\r\n');
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await fs.writeFile(path.join(root, file), 'test license\r\n');
  const windows = path.join(root, 'windows.tgz');
  await buildBotRuntime({root, output: windows});
  const windowsVersion = readComponentVersion(windows + '.manifest.json');
  assert.equal(windowsVersion.build, first.build, 'checkout line endings cannot trigger alternating updates between PCs');
  assert.equal(windowsVersion.archiveSha256, createHash('sha256').update(await fs.readFile(windows)).digest('hex'));
  await fs.writeFile(path.join(root, 'third-party/example.bin'), Buffer.from([0, 10, 255]));
  await buildBotRuntime({root, output: windows});
  assert.notEqual(readComponentVersion(windows + '.manifest.json').build, first.build, 'binary content remains byte-sensitive');
  await fs.writeFile(path.join(root, 'third-party/example.bin'), Buffer.from([0, 13, 10, 255]));
  await fs.writeFile(path.join(root, 'src/main/example.mjs'), 'export const value = 2;');
  await buildBotRuntime({root, output});
  assert.notEqual(readComponentVersion(output + '.manifest.json').build, first.build);
  let remoteCalls = 0;
  const transport = createBotTransport({archivePath: output, runner: {async exec() {remoteCalls++;}}});
  await fs.appendFile(output, 'changed after packaging');
  await assert.rejects(() => transport.install('fixture', {existing: true, bot: {instanceId: 'same', activeJobs: 0}}), /版本清单不一致/);
  assert.equal(remoteCalls, 0);
});

test('runtime includes a matching Windows supervisor binary and refuses stale native source', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-package-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const gate=path.join(root,'src/main/agent/gate');
  for(const folder of [gate,path.join(root,'src/shared'),path.join(root,'third-party')])await fs.mkdir(folder,{recursive:true});
  await fs.cp(path.resolve(import.meta.dirname, '../../../extensions/chrome-extension'), path.join(root, 'extensions/chrome-extension'), {recursive: true});
  const windowPath='packages/conversation-flow/src/core/flow-window.mjs';await fs.mkdir(path.dirname(path.join(root,windowPath)),{recursive:true});await fs.copyFile(path.resolve(import.meta.dirname,'../../..',windowPath),path.join(root,windowPath));
  const actual=path.resolve(import.meta.dirname,'../agent/gate');
  for(const extension of ['cs','exe','json'])await fs.copyFile(path.join(actual,'windows-command-job.'+extension),path.join(gate,'windows-command-job.'+extension));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version:'0.2.19',dependencies:{}}));
  await fs.writeFile(path.join(root,'bot-component-version.json'),JSON.stringify({revision:1}));
  await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify({packages:{}}));
  for(const name of ['LICENSE','THIRD-PARTY-NOTICES.md'])await fs.writeFile(path.join(root,name),'fixture license\n');
  const output=path.join(root,'native.tgz');
  await buildBotRuntime({root,output});
  for(const extension of ['cs','exe','json']){
    const packaged=execFileSync('tar',['-xOf',output,'./src/main/agent/gate/windows-command-job.'+extension]);
    assert.deepEqual(packaged,await fs.readFile(path.join(gate,'windows-command-job.'+extension)));
  }
  await fs.appendFile(path.join(gate,'windows-command-job.cs'),'\n// source changed\n');
  await assert.rejects(buildBotRuntime({root,output}),/源码校验不一致/);
  await fs.copyFile(path.join(actual,'windows-command-job.cs'),path.join(gate,'windows-command-job.cs'));
  await fs.writeFile(path.join(gate,'windows-command-job.exe'),'corrupt executable');
  await assert.rejects(buildBotRuntime({root,output}),/源码校验不一致/);
});

test('missing or invalid component version cannot silently reuse the desktop version', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-component-version-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version:'0.2.20'}));
  await assert.rejects(buildBotRuntime({root}),{code:'ENOENT'});
  for (const revision of [undefined,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]) {
    await fs.writeFile(path.join(root,'bot-component-version.json'),JSON.stringify({revision}));
    await assert.rejects(buildBotRuntime({root}),/Bot 组件版本号无效/);
  }
  await assert.rejects(buildBotRuntime({root,componentVersion:'0.2.99'}),/不支持临时版本覆盖/);
});
