// Run only as a disposable interactive scheduled task; screenshots target this fixture's window.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startWindowsDesktopWorker, createWindowsDesktopClient} from '../src/main/bot/windows-desktop.mjs';
import {powershellCommand} from '../src/main/bot/windows-transport.mjs';
import {describeAction, describeToolResult} from '../src/main/agent/gate/cua-client.mjs';

if (process.platform !== 'win32') throw new Error('Run on Windows');
const exec = promisify(execFile), root = path.resolve(process.argv[2]);
const nativeKeyboardOnly = process.argv.includes('--native-keyboard-only');
const report = {node: process.version, platform: process.platform, mode: nativeKeyboardOnly ? 'native-keyboard' : 'host-sdk', checks: [], error: null};
const appName = 'HemiFixture-' + path.basename(root), title = 'HEMI ' + appName;
const exe = path.join(root, 'fixture.exe'), dataDir = path.join(root, 'host/data');
const fixtureState = path.join(root, 'fixture-state.txt');
const ps = async script => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', powershellCommand(script).split(' -EncodedCommand ')[1]], {timeout: 30000, windowsHide: true});
const literal = value => "'" + value.replaceAll("'", "''") + "'";
let worker, fixture, shortcut, client, target, foreground = false, stage = 0;
try {
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await exec(compiler, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/out:' + exe, path.join(import.meta.dirname, 'lib/windows-desktop-fixture.cs')]);
  const link = await ps(`$dir=Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs';$link=Join-Path $dir ${literal(appName + '.lnk')};$shell=New-Object -ComObject WScript.Shell;$item=$shell.CreateShortcut($link);$item.TargetPath=${literal(exe)};$item.Arguments=${literal('"' + title + '" "' + fixtureState + '"')};$item.Save();[Console]::WriteLine($link)`);
  shortcut = link.stdout.trim();
  worker = await startWindowsDesktopWorker({dataDir});client = createWindowsDesktopClient({dataDir});
  const status = await client.status();assert.equal(status.available, true, JSON.stringify(status));report.sessionConnected = status.sessionConnected;report.checks.push('native driver is reachable in the logged-in Windows session');
  if (nativeKeyboardOnly) {
    const app = await client.findInstalledApplication({app: appName});assert.ok(app);
    await client.openApplication({app: app.bundleId});
    for (let i = 0; !target && i < 20; i++) {
      const running = (await client.listAppWindows()).find(item => item.windows.some(window => window.title === title));
      if (running) target = {pid: running.pid, windowId: running.windows.find(window => window.title === title).windowId, bundleId: running.bundleId};
      else await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(target, 'the native fixture window appeared');
    let state = await client.windowState({...target, includeTree: true});
    const edit = state.elements.find(element => element.label === 'HemiInput');assert.ok(edit?.elementToken);
    const confirm = (value, kind = 'tool') => assert.equal((kind === 'click' ? describeAction(value) : describeToolResult(value)).actionState, 'executed', JSON.stringify(value));
    confirm(await client.setValue({...target, elementToken: edit.elementToken, value: 'FIRST_VALUE'}));
    confirm(await client.click({...target, x: 100, y: 100, delivery: 'foreground'}), 'click');
    confirm(await client.key({...target, combo: 'ctrl+a', delivery: 'foreground'}));
    confirm(await client.typeText({...target, text: '中文 Windows Bot🙂', delivery: 'foreground'}));
    state = await client.windowState({...target, includeTree: true});
    const button = state.elements.find(element => element.label === 'HemiApply');assert.ok(button?.elementToken);
    confirm(await client.click({...target, elementToken: button.elementToken}), 'click');
    state = await client.windowState({...target, includeTree: true});
    const values = (await fs.readFile(fixtureState, 'utf8')).split('\n').map(value => Buffer.from(value, 'base64').toString('utf8'));
    assert.deepEqual(values, ['中文 Windows Bot🙂', '中文 Windows Bot🙂'], 'native foreground Ctrl+A and Unicode input replace the prior text exactly');
    const shot = state.images?.[0];assert.ok(shot);await fs.writeFile(path.join(root, 'fixture.png'), Buffer.from(shot.dataBase64, 'base64'));
    report.checks.push('actual desktop pipe/native foreground click, Ctrl+A, Chinese and Emoji typing, UIA button action and targeted screenshot');
  } else {
  const {createBotCapabilityFixture} = await import('./lib/bot-capability-fixture.mjs');
  fixture = await createBotCapabilityFixture(async body => {
    const results = body.messages.filter(message => message.role === 'tool');
    if (results.length && /未执行|✗|失败/.test(String(results.at(-1).content))) throw new Error(`Desktop stage ${stage} refused: ${String(results.at(-1).content).slice(0, 500)}`);
    if (stage >= 2 && !target) {
      const apps = await client.listAppWindows();const app = apps.find(app => app.windows.some(window => window.title === title));
      if (!app) return {tool: {name: 'ui_list', args: {}}};
      target = {pid: app.pid, windowId: app.windows.find(window => window.title === title).windowId, bundleId: app.bundleId};
    }
    const text = String(results.at(-1)?.content ?? '');
    const editRef = text.match(/\[(t\d+)\].*(?:HemiInput|TextArea|TextField|Edit)/)?.[1];
    const buttonRef = text.match(/\[(t\d+)\].*(?:HemiApply|Apply)/)?.[1];
    if (stage === (foreground ? 1 : 4)) assert.ok(editRef, 'real UI tree identifies the fixture input');
    if (stage === 6) assert.ok(buttonRef, 'real UI tree identifies the fixture button');
    const steps = foreground ? [
      {name: 'ui_tree', args: {app: target?.bundleId}},
      {name: 'ui_act', args: {actions: [{op: 'set_value', ref: editRef, value: 'FIRST_VALUE'}]}},
      {name: 'ui_click', args: {target, x: 100, y: 100}},
      {name: 'ui_key', args: {target, combo: 'ctrl+a', delivery: 'foreground'}},
      {name: 'ui_type', args: {target, text: '中文 Windows Bot🙂', delivery: 'foreground'}},
      {name: 'ui_tree', args: {app: target?.bundleId}},
      {name: 'ui_act', args: {actions: [{op: 'click', ref: buttonRef}]}}, {name: 'screen_view', args: {target}},
    ] : [
      {name: 'app_open', args: {app: appName}}, {name: 'ui_list', args: {}},
      {name: 'screen_view', args: {target}}, {name: 'ui_tree', args: {app: target?.bundleId}},
      {name: 'ui_act', args: {actions: [{op: 'set_value', ref: editRef, value: '中文 Windows Bot🙂'}]}},
      {name: 'ui_tree', args: {app: target?.bundleId}},
      {name: 'ui_act', args: {actions: [{op: 'click', ref: buttonRef}]}}, {name: 'screen_view', args: {target}},
    ];
    return stage < steps.length ? {tool: steps[stage++]} : {content: 'WINDOWS_DESKTOP_COMPLETE'};
  }, {root: path.join(root, 'host'), capabilityOptions: {desktop: client}});
  const session = await fixture.call('session.create');
  const detail = await fixture.send(session.id, 'WINDOWS_DESKTOP_PROOF', {}, permission => {
    assert.ok(permission.title.includes(appName) || permission.title.includes('fixture'), 'only the synthetic fixture may receive a grant');
    report.checks.push('real app-scoped permission card');return permission.options[0];
  });
  assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');
  const state = await client.windowState({...target, includeTree: true, includeScreenshot: true});
  report.elements = (state.elements ?? []).map(element => ({role: element.role, label: element.label, value: element.value}));
  const readValues = async () => (await fs.readFile(fixtureState, 'utf8')).split('\n').map(value => Buffer.from(value, 'base64').toString('utf8'));
  assert.deepEqual(await readValues(), ['中文 Windows Bot🙂', '中文 Windows Bot🙂'], 'fixture-owned input and button result prove the actual UIA changes');
  const context = await fixture.call('context.capture', {id: session.id, target});assert.equal(context.attachment.kind, 'image');
  report.checks.push('actual Host/SDK app launch, UI tree, UIA Unicode value changes, button actions and window screenshots', 'manual remote-window context becomes a session attachment');
  const shot = state.images?.[0];assert.ok(shot);await fs.writeFile(path.join(root, 'fixture.png'), Buffer.from(shot.dataBase64, 'base64'));
  if (process.argv.includes('--background-only')) {
    report.deferred = ['foreground Ctrl+A and Unicode typing require a connected, unlocked Windows desktop'];
  } else {
    foreground = true;stage = 0;
    const keyboard = await fixture.send(session.id, 'WINDOWS_FOREGROUND_PROOF');
    assert.equal(Object.values(keyboard.flow.runs).at(-1).outcome, 'completed');
    assert.deepEqual(await readValues(), ['中文 Windows Bot🙂', '中文 Windows Bot🙂'], 'foreground Ctrl+A replaces the prior text and Unicode input preserves Emoji');
    report.checks.push('actual foreground Ctrl+A and Unicode typing preserve the exact fixture text');
  }
  }
} catch (error) {report.error = error.stack;process.exitCode = 1;}
finally {
  if (target?.pid) await ps(`$p=Get-Process -Id ${Number(target.pid)} -ErrorAction SilentlyContinue;if($p -and $p.Path -eq ${literal(exe)}){Stop-Process -Id $p.Id}`).catch(() => {});
  if (shortcut) await fs.rm(shortcut, {force: true});
  const cleanup = await Promise.allSettled([fixture?.host.close()]);
  cleanup.push(...await Promise.allSettled([worker?.close()]));
  cleanup.push(...await Promise.allSettled([fixture?.close()]));
  const failed = cleanup.find(item => item.status === 'rejected');if (failed && !report.error) {report.error = failed.reason.stack;process.exitCode = 1;}
  await fs.writeFile(path.join(root, 'result.json.tmp'), JSON.stringify(report, null, 2) + '\n');
  await fs.rename(path.join(root, 'result.json.tmp'), path.join(root, 'result.json'));
}
