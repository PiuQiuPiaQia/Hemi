// Disposable package, interactive task and WinForms fixture; never updates the installed Bot.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID, createHash} from 'node:crypto';
import {buildBotRuntime} from './build-bot-runtime.mjs';
import {powershellCommand} from '../src/main/bot/windows-transport.mjs';

const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '..');
const host = process.env.HEMI_BOT_TEST_HOST;if (!host) throw new Error('Set HEMI_BOT_TEST_HOST to an authorized Windows target');
const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
  ...(process.env.HEMI_BOT_TEST_SSH_SOCKET ? ['-o', 'ControlPath=' + process.env.HEMI_BOT_TEST_SSH_SOCKET] : [])];
// Keep Windows cmd.exe below its command-line limit even for task definitions.
const ssh = (source, timeout = 60000) => new Promise((resolve, reject) => {
  const command = powershellCommand("& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))))");
  const child = execFile('ssh', [...options, host, command], {timeout, maxBuffer: 2 * 1024 * 1024}, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr}));
  child.stdin.on('error', () => {});child.stdin.end(Buffer.from(source).toString('base64'));
});
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const evidence = path.join(repo, '.visual/workflow/bot-capabilities/windows');await fs.mkdir(evidence, {recursive: true});
const report = {commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), workingTree: true, date: new Date().toISOString(), checks: []};
let taskName = 'HemiDesktopTest-' + randomUUID(), remote;
const sshNode = source => new Promise((resolve, reject) => {
  const child = execFile('ssh', [...options, host, `"${remote.node}" --max-old-space-size=128 --max-semi-space-size=1 --input-type=module`], {timeout: 15000, maxBuffer: 2 * 1024 * 1024}, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr}));
  child.stdin.on('error', () => {});child.stdin.end(source);
});
async function uploadInputs() {
  const archive = await buildBotRuntime({output: path.join(evidence, 'runtime.tgz')}), fixtures = path.join(evidence, 'fixtures.tgz');
  await exec('tar', ['--no-xattrs', '--no-acls', '--exclude=._*', '-czf', fixtures, 'scripts/verify-bot-windows-desktop-local.mjs', 'scripts/verify-bot-windows-scenarios-local.mjs', 'scripts/lib/windows-desktop-fixture.cs', 'scripts/lib/bot-capability-fixture.mjs', 'scripts/lib/goal-model-fixture.mjs', 'src/main/bot/windows.test.mjs'], {cwd: repo, env: {...process.env, COPYFILE_DISABLE: '1'}});
  for (const file of [archive, fixtures]) await exec('scp', [...options, file, host + ':' + remote.dir.replaceAll('\\', '/') + '/' + path.basename(file)], {timeout: 60000, maxBuffer: 65536});
  report.archiveSha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
}
try {
  if (process.env.HEMI_BOT_VERIFY_RESUME === '1') {
    remote = JSON.parse(await fs.readFile(path.join(evidence, 'remote-context.json'), 'utf8'));taskName = remote.taskName;
    if (process.env.HEMI_BOT_VERIFY_REFRESH === '1') {
      const live = await ssh(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$task=$null;try{$task=$s.GetFolder('\\').GetTask(${literal(taskName)})}catch{};@{running=($task -and $task.State -eq 4);processes=@(Get-Process node -ErrorAction SilentlyContinue|Select-Object Id,StartTime)}|ConvertTo-Json -Depth 4 -Compress`);
      const facts = JSON.parse(live.stdout.trim());assert.equal(facts.running, false, 'do not overwrite a live verifier');remote.processes = facts.processes;
      await fs.writeFile(path.join(evidence, 'remote-context.json'), JSON.stringify(remote, null, 2));
      await uploadInputs();
      await ssh(`$d=${literal(remote.dir)};$p=Join-Path $d 'package';& tar.exe -xzf (Join-Path $d 'runtime.tgz') -C $p;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};& tar.exe -xzf (Join-Path $d 'fixtures.tgz') -C $p;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};Remove-Item -LiteralPath (Join-Path $d 'result.json') -ErrorAction SilentlyContinue;exit 0`);
    }
    const probe = await ssh(`$dir=${literal(remote.dir)};[Console]::WriteLine((Get-FileHash -LiteralPath (Join-Path $dir 'runtime.tgz') -Algorithm SHA256).Hash);Set-Location (Join-Path $dir 'package');& ${literal(remote.node)} --input-type=module -e ${literal("import('./node_modules/@trycua/cua-driver/dist/index.js').then(()=>console.log('NATIVE_IMPORT_OK'))")};exit $LASTEXITCODE`);
    assert.equal(probe.stdout.trim().split(/\r?\n/)[0].toLowerCase(), createHash('sha256').update(await fs.readFile(path.join(evidence, 'runtime.tgz'))).digest('hex'));
    assert.match(probe.stdout, /NATIVE_IMPORT_OK/);report.checks.push('resumed verified package after interrupted SSH observation');
  } else {
  const prepare = await ssh(`$root=Join-Path $env:USERPROFILE '.local\\share\\hemi-bot';$active=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw|ConvertFrom-Json;$dir=Join-Path $env:TEMP ${literal(taskName)};[IO.Directory]::CreateDirectory($dir)|Out-Null;@{dir=$dir;node=$active.node;release=$active.release;network=Join-Path $root 'network.env';processes=@(Get-Process node -ErrorAction SilentlyContinue|Select-Object Id,StartTime)}|ConvertTo-Json -Depth 4 -Compress`);
  remote = JSON.parse(prepare.stdout.trim());
  await fs.writeFile(path.join(evidence, 'remote-context.json'), JSON.stringify({...remote, taskName}, null, 2));
  await uploadInputs();
  const smallInstall = process.env.HEMI_BOT_VERIFY_SCENARIOS === '1' ? "$env:NODE_OPTIONS='--max-old-space-size=256 --max-semi-space-size=1';" : '';
  const install = await ssh(`${smallInstall}$dir=${literal(remote.dir)};$package=Join-Path $dir 'package';[IO.Directory]::CreateDirectory($package)|Out-Null;& tar.exe -xzf (Join-Path $dir 'runtime.tgz') -C $package;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};& tar.exe -xzf (Join-Path $dir 'fixtures.tgz') -C $package;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};Set-Location $package;& ${literal(remote.node)} ('--env-file-if-exists='+${literal(remote.network)}) 'src/main/bot/install-dependencies.mjs' $dir ${literal(remote.release)};exit $LASTEXITCODE`, 180000);
  await fs.writeFile(path.join(evidence, 'install.log'), install.stdout + install.stderr);report.checks.push('packaged runtime dependency install');
  }
  if (process.env.HEMI_BOT_VERIFY_COLLECT_ONLY !== '1') {
  const scenarios = process.env.HEMI_BOT_VERIFY_SCENARIOS === '1';
  const split = scenarios && process.env.HEMI_BOT_VERIFY_SPLIT_DESKTOP !== '0';
  const entry = scenarios ? 'verify-bot-windows-scenarios-local.mjs' : 'verify-bot-windows-desktop-local.mjs';
  const bootstrap = `import fs from 'node:fs';import path from 'node:path';import('./package/scripts/${entry}').catch(error=>{fs.writeFileSync(path.join(import.meta.dirname,'result.json'),JSON.stringify({checks:[],error:error.stack}));process.exitCode=1;});`;
  const mode = split ? "'--split-desktop'" : process.env.HEMI_BOT_VERIFY_NATIVE_KEYBOARD_ONLY === '1' ? "'--native-keyboard-only'" : process.env.HEMI_BOT_VERIFY_BACKGROUND_ONLY === '1' ? "'--background-only'" : '';
  const flags = scenarios ? '--expose-gc --max-old-space-size=256 --max-semi-space-size=1 --optimize-for-size' : '';
  const launch = `& ${literal(remote.node)} ${flags} ${literal('--env-file-if-exists=' + remote.network)} ${literal(remote.dir + '\\verify-entry.mjs')} ${literal(remote.dir)} ${mode} 1> ${literal(remote.dir + '\\stdout.log')} 2> ${literal(remote.dir + '\\stderr.log')};exit $LASTEXITCODE`;
  // COM avoids loading the ScheduledTasks/CIM module in each verification
  // subprocess on small Windows hosts. Full scenarios run an S4U Host (2)
  // with a separate InteractiveToken desktop helper (3), as production does.
  await ssh(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$existing=$null;try{$existing=$s.GetFolder('\\').GetTask(${literal(taskName)})}catch{};if($existing -and $existing.State -eq 4){throw 'A verifier is already running; collect its result instead of replaying UI actions.'};$dir=${literal(remote.dir)};foreach($name in @('result.json','result.json.tmp','progress.json')){[IO.File]::Delete((Join-Path $dir $name))};$package=Join-Path $dir 'package';[IO.File]::WriteAllText((Join-Path $dir 'verify-entry.mjs'),${literal(bootstrap)});[IO.File]::WriteAllText((Join-Path $dir 'verify-launch.ps1'),${literal(launch)});$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$s=New-Object -ComObject Schedule.Service;$s.Connect();$d=$s.NewTask(0);$d.Principal.UserId=$sid;$d.Principal.LogonType=${split?2:3};$d.Settings.Priority=4;$d.Settings.ExecutionTimeLimit='PT20M';$d.Settings.MultipleInstances=2;$a=$d.Actions.Create(0);$a.Path='powershell.exe';$a.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $dir 'verify-launch.ps1')+'"';$a.WorkingDirectory=$package;$t=$s.GetFolder('\\').RegisterTaskDefinition(${literal(taskName)},$d,6,$sid,$null,${split?2:3},$null);$t.Run($null)|Out-Null`);
  }
  let result;
  for (let i = 0; i < 1200; i++) {
    const status = await sshNode(`import fs from 'node:fs';import path from 'node:path';const root=${JSON.stringify(remote.dir)},file=path.join(root,'result.json'),err=path.join(root,'stderr.log');console.log(JSON.stringify(fs.existsSync(file)?{resultBase64:fs.readFileSync(file).toString('base64')}:{waiting:true,fatal:fs.existsSync(err)&&/Fatal process out of memory|FATAL ERROR/.test(fs.readFileSync(err,'utf8'))}));`);
    const value = JSON.parse(status.stdout.trim());
    if (!value.waiting) {result = JSON.parse(Buffer.from(value.resultBase64, 'base64').toString('utf8'));break;}
    if (value.fatal) {
      const logs = await ssh(`$file=Join-Path ${literal(remote.dir)} 'stderr.log';if(Test-Path -LiteralPath $file){Get-Content -LiteralPath $file -Raw}`);
      await fs.writeFile(path.join(evidence, 'interactive-stderr.log'), logs.stdout);
      throw new Error('Interactive test task failed before writing its result; see interactive-stderr.log');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!result) throw new Error('Interactive verification still pending; inspect the isolated task and folder');
  await fs.writeFile(path.join(evidence, 'desktop-result.json'), JSON.stringify(result, null, 2) + '\n');
  if (!result.error) await exec('scp', [...options, host + ':' + remote.dir.replaceAll('\\', '/') + '/fixture.png', path.join(evidence, 'fixture.png')], {timeout: 30000});
  assert.equal(result.error, null, result.error);report.checks.push(...result.checks);report.deferred = result.deferred ?? [];
  const after = await ssh('@(Get-Process node -ErrorAction SilentlyContinue|Select-Object Id,StartTime)|ConvertTo-Json -Compress');
  const processes = [JSON.parse(after.stdout.trim())].flat();
  // RPC clients and unrelated Node jobs may exit while this test runs. Keep
  // that evidence without treating their lifetime as a desktop assertion.
  report.exitedPreexistingNodeProcessIds = remote.processes.filter(before =>
    !processes.some(process => process.Id === before.Id && process.StartTime === before.StartTime)).map(process => process.Id);
  if (!report.exitedPreexistingNodeProcessIds.length) report.checks.push('pre-existing Node processes remain unchanged');
  else report.notes = ['Some pre-existing Node processes exited during verification; their cause is not established by this test.'];
} catch (error) {
  report.error = error.cmd ? 'Verification command failed; see failure.log' : error.message;
  if (error.stdout || error.stderr) await fs.writeFile(path.join(evidence, 'failure.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw error;
} finally {
  if (remote) {
    const state = await ssh(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$null;try{$t=$s.GetFolder('\\').GetTask(${literal(taskName)})}catch{};@{running=($t -and $t.State -eq 4)}|ConvertTo-Json -Compress`).then(result => JSON.parse(result.stdout.trim()), () => ({running: true}));
    if (!state.running) {
      await ssh(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\');foreach($name in @(${literal(taskName)},${literal(taskName + '-Probe')})){try{$f.DeleteTask($name,0)}catch{}};exit 0`).catch(() => {});
      if (!report.error && process.env.HEMI_BOT_VERIFY_KEEP_PACKAGE !== '1') {
        const cleanup = "import fs from 'node:fs';fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3,retryDelay:100});";
        await ssh(`& ${literal(remote.node)} --input-type=module -e ${literal(cleanup)} ${literal(remote.dir)};exit $LASTEXITCODE`);
      }
    }
    else report.pendingTask = taskName;
  }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
