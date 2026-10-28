import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createBotTransport } from './transport.mjs';
import { botControlEndpoint, controlToken, validControlToken } from './control-endpoint.mjs';
import { rpc } from './cli.mjs';
import {runCommand} from '../agent/gate/command-execution.mjs';
import { powershellSource, copyWindowsInput, windowsRootSetupScript, windowsProbeScript, windowsCliScript, windowsDirectoryScript, windowsInstallScript, windowsRollbackScript, windowsControlScript } from './windows-transport.mjs';
const exec = promisify(execFile);
const ps = process.platform === 'win32' ? 'powershell.exe' : process.env.HEMI_TEST_POWERSHELL;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const decode = command => Buffer.from(command.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');

test('Windows control pipe is case insensitive, bounded and authenticated with a persistent private token', async t => {
  assert.equal(botControlEndpoint('C:\\Users\\Owner\\data', 'win32'), botControlEndpoint('c:\\users\\owner\\DATA', 'win32'));
  assert.match(botControlEndpoint('C:\\' + 'long'.repeat(100), 'win32'), /^\\\\\.\\pipe\\hemi-bot-[a-f0-9]{32}$/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-pipe-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const token = controlToken(root, {create: true, platform: 'win32'});
  assert.notEqual(botControlEndpoint(root,'win32',token),botControlEndpoint(root,'win32',''));
  assert.equal(controlToken(root, {create: true, platform: 'win32'}), token);
  assert.equal(validControlToken(token, token), true);
  for (const value of [null, 'a'.repeat(64), '项'.repeat(64), token.slice(1)]) assert.equal(validControlToken(value, token), false);
});

test('Windows probe, directory, RPC and resumed binding use PowerShell and preserve Unicode JSON', async () => {
  const fields = {platform: 'win32', home: 'C:\\Users\\项目 Owner', arch: 'x64', node: 'v22.22.3', nodeBin: 'C:\\node\\node.exe', runtimeNeeded: '0', existing: '0'};
  const commands = [], payloads = [];
  const runner = {async exec({command, stdin}) {
    if (command === 'uname -s') return {code: 1, stdout: Buffer.alloc(0), stderr: 'uname is not recognized'};
    const script = decode(command); commands.push(script); payloads.push(stdin);
    const stdout = script.includes('function Emit')
      ? Object.entries(fields).map(([k,v]) => '__HB_' + k + '=' + Buffer.from(v).toString('base64')).join('\r\n') + '\r\n'
      : script.includes('__HEMI_DIR_JSON__') ? '__HEMI_DIR_JSON__' + JSON.stringify({status:'ok',path:fields.home,home:fields.home,parent:'C:\\Users',folders:[{name:'中文',path:fields.home+'\\中文'}]}) + '\r\n'
      : JSON.stringify({ok:true,result:{text:'中文🙂'}});
    return {code:0,stdout:Buffer.from(stdout),stderr:''};
  }};
  const transport = createBotTransport({runner});
  const info = await transport.probe('win-fixture');
  assert.equal(info.platform, 'win32'); assert.equal(info.root, fields.home+'\\.local\\share\\hemi-bot');
  const target = "C:\\Users\\a'$(Write-Output INJECTED)";
  assert.equal((await transport.directory('win-fixture', target)).folders[0].name, '中文');
  assert.ok(commands.at(-1).includes("a''$(Write-Output INJECTED)"));
  await assert.rejects(transport.directory('win-fixture', 'C:relative'), /绝对文件夹/);
  await assert.rejects(transport.directory('win-fixture', '\\\\server\\share'), /绝对文件夹/);
  assert.deepEqual(await transport.rpc('win-fixture', 'snapshot', {text:'中文🙂'}), {text:'中文🙂'});
  assert.equal(JSON.parse(payloads.at(-1)).params.text, '中文🙂');
  const resumed = createBotTransport({runner}); resumed.setPlatform('win-fixture', 'win32');
  await resumed.rpc('win-fixture', 'handshake');
  assert.ok(commands.at(-1).includes('current.json'));
  assert.ok(!commands.at(-1).includes('/bin/sh'));
});

test('large Windows RPC requests upload bounded ASCII blocks and clean their private staging file', async () => {
  const chunks=[], scripts=[],text='中文🙂'.repeat(40000);
  const runner={async exec({command,stdin}){
    const script=decode(command);scripts.push(script);
    if(script.includes('$encoded = New-Object IO.MemoryStream')){
      assert.ok(stdin.length<=65536);assert.match(stdin.toString(),/^[A-Za-z0-9+/=]+$/);chunks.push(Buffer.from(stdin.toString(),'base64'));
    }
    return{code:0,stdout:Buffer.from(script.includes('Diagnostics.ProcessStartInfo')?JSON.stringify({ok:true,result:{ok:true}}):''),stderr:''};
  }};
  const transport=createBotTransport({runner});transport.setPlatform('fixture','win32');
  await transport.rpc('fixture','session.draft',{text});
  const sent=JSON.parse(Buffer.concat(chunks).toString());assert.equal(sent.params.text,text);
  const launch=scripts.find(script=>script.includes('Diagnostics.ProcessStartInfo'));
  assert.ok(launch.includes('[IO.File]::OpenRead'));
  assert.ok(scripts.at(-1).includes('Remove-Item -LiteralPath'));
});

test('PowerShell payloads parse, including quotes, Unicode, downloads and rollback', {skip: !ps}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-powershell-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const samples = [windowsProbeScript, windowsCliScript('rpc'), windowsCliScript('rpc-stream'), windowsCliScript('watch'), windowsDirectoryScript("C:\\用户 a'$(Write-Output BAD)"), windowsInstallScript({nodeBin:"C:\\用户 a'\\node.exe",runtimeNeeded:true},{release:'release-test',digest:'a'.repeat(64)}), windowsRollbackScript, windowsControlScript('start'), windowsControlScript('stop')];
  for (let i=0; i<samples.length; i++) await fs.writeFile(path.join(root, `${i}.ps1`), '\ufeff' + powershellSource(samples[i]));
  const check = `$failed=$false; Get-ChildItem -LiteralPath '${root.replaceAll("'","''")}' -Filter '*.ps1' | ForEach-Object { $e=$null; $tokens=$null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$e) | Out-Null; if($e){$failed=$true; $e | ForEach-Object { [Console]::Error.WriteLine($_.Message) }} }; if($failed){exit 1}`;
  await exec(ps, ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(check,'utf16le').toString('base64')]);
});

test('Windows resident task settings keep interactive resource priority and unlimited service lifetime', {skip: process.platform !== 'win32'}, async () => {
  const install = windowsInstallScript({nodeBin: process.execPath, runtimeNeeded: false}, {release: 'release-test', digest: 'a'.repeat(64)});
  const settings = install.match(/^\s*\$settings = New-ScheduledTaskSettingsSet[^\n]+/m)?.[0];
  assert.ok(settings, 'exercise the production task settings through the native ScheduledTasks module');
  const source = powershellSource(`${settings}\n[Console]::WriteLine((@{priority=$settings.Priority;limit=$settings.ExecutionTimeLimit;restart=$settings.RestartCount;instances=[string]$settings.MultipleInstances} | ConvertTo-Json -Compress))`);
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.priority, 4);
  assert.equal(value.limit, 'PT0S');
  assert.equal(value.restart, 3);
  assert.equal(value.instances, 'IgnoreNew');
});

test('Windows production desktop task uses the logged-in session and its desktop launcher argument', {skip: process.platform !== 'win32', timeout: 30000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-desktop-registration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const taskName = 'HemiDesktopRegistration-' + path.basename(root);
  const launcher = path.join(root, 'launcher.mjs'), resultFile = path.join(root, 'result.json');
  await fs.writeFile(launcher, `import fs from 'node:fs';import {execFileSync} from 'node:child_process';fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({args:process.argv.slice(2),session:Number(execFileSync('powershell.exe',['-NoProfile','-Command','(Get-Process -Id '+process.pid+').SessionId'],{encoding:'utf8'}).trim())}));`);
  const install = windowsInstallScript({nodeBin: process.execPath, runtimeNeeded: false}, {release: 'release-test', digest: 'a'.repeat(64)});
  const definitions = ['trigger', 'settings', 'desktopAction', 'desktopPrincipal', 'desktopTriggers'].map(name => {
    const line = install.match(new RegExp('^\\s*\\$' + name + ' = [^\\n]+', 'm'))?.[0];assert.ok(line, name);return line;
  }).join('\n');
  const registration = install.match(/^\s*Register-ScheduledTask -TaskName \$desktopTaskName -Action[^\n]+/m)?.[0];assert.ok(registration);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const source = powershellSource(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$desktopTaskName=${quote(taskName)};$node=${quote(process.execPath)};$launcher=${quote(launcher)};$networkEnv=${quote(path.join(root, 'network.env'))};$envProxyFlag=''
try {
${definitions}
${registration}
$task=Get-ScheduledTask -TaskName $desktopTaskName
if($task.Principal.LogonType -ne 'Interactive' -or $task.Settings.Priority -ne 4){throw 'Incorrect desktop task principal or priority'}
if(@($task.Triggers).Count -ne 2){throw 'Missing desktop task triggers'}
Start-ScheduledTask -TaskName $desktopTaskName
for($i=0;$i -lt 100 -and -not (Test-Path -LiteralPath ${quote(resultFile)});$i++){Start-Sleep -Milliseconds 100}
if(-not (Test-Path -LiteralPath ${quote(resultFile)})){throw 'Desktop task did not execute in the logged-in session'}
} finally {Stop-ScheduledTask -TaskName $desktopTaskName -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $desktopTaskName -Confirm:$false -ErrorAction SilentlyContinue}`);
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  assert.deepEqual(result.args, ['desktop']);assert.ok(result.session > 0);
});

test('Windows dependency installation inherits the Bot network file before npm starts', {skip: process.platform !== 'win32'}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-network-install-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'src/main/bot'), {recursive: true});
  await fs.writeFile(path.join(root, 'network.env'), 'HTTPS_PROXY=http://proxy.example.test:7897\nNODE_USE_ENV_PROXY=1\n');
  await fs.writeFile(path.join(root, 'src/main/bot/install-dependencies.mjs'), `console.log(JSON.stringify({proxy:process.env.HTTPS_PROXY,enabled:process.env.NODE_USE_ENV_PROXY,root:process.argv[2]}));`);
  const install = windowsInstallScript({nodeBin: process.execPath, runtimeNeeded: false}, {release: 'release-test', digest: 'a'.repeat(64)});
  const invocation = install.match(/^\s*& \$node .*'src\/main\/bot\/install-dependencies\.mjs'[^\n]+/m)?.[0];
  assert.ok(invocation);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const source = powershellSource(`$root=${quote(root)}\n$node=${quote(process.execPath)}\n$reuse=''\n$networkEnv=Join-Path $root 'network.env'\nRemove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue\nPush-Location -LiteralPath $root\ntry { ${invocation} } finally { Pop-Location }`);
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {proxy: 'http://proxy.example.test:7897', enabled: '1', root});
});

test('Windows start repairs an existing task priority and the actual action runs at normal priority', {skip: process.platform !== 'win32', timeout: 20000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-task-priority-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const taskName = 'HemiPriorityTest-' + path.basename(root);
  const probe = path.join(root, 'probe.mjs'), resultFile = path.join(root, 'result.json');
  await fs.writeFile(probe, `import fs from 'node:fs';import os from 'node:os';fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({priority:os.getPriority()}));`);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const start = windowsControlScript('start').replace("$taskName = 'HemiBot-' + $sid", '$taskName = ' + quote(taskName));
  const source = powershellSource(`$name=${quote(taskName)}
$action=New-ScheduledTaskAction -Execute ${quote(process.execPath)} -Argument ${quote('"' + probe + '"')}
$settings=New-ScheduledTaskSettingsSet -Priority 7 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType S4U -RunLevel Limited
try {
  Register-ScheduledTask -TaskName $name -Action $action -Settings $settings -Principal $principal -Force | Out-Null
  ${start}
  $task=Get-ScheduledTask -TaskName $name
  if($task.Settings.Priority -ne 4 -or $task.Actions.Execute -ne ${quote(process.execPath)}) {throw 'Task repair changed the action or did not restore priority'}
  for($i=0;$i -lt 100 -and -not (Test-Path -LiteralPath ${quote(resultFile)});$i++){Start-Sleep -Milliseconds 100}
  [Console]::WriteLine([IO.File]::ReadAllText(${quote(resultFile)}))
} finally {Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue}`);
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
  assert.equal(JSON.parse(result.stdout.trim()).priority, 0);
});

test('PowerShell stdin reader preserves binary bytes without requiring EOF', {skip: !ps, timeout:10000}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-stdin-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'payload.bin'),input=Buffer.from(Array.from({length:65536},(_,i)=>i%256));
  const source=powershellSource(`$stream=[IO.File]::Create('${file.replaceAll("'","''")}');try{${copyWindowsInput('$stream',input.length)}}finally{$stream.Dispose()}`);
  const child=spawn(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{stdio:['pipe','ignore','pipe']});
  let error='';child.stderr.on('data',chunk=>error+=chunk);child.stdin.on('error',()=>{});
  child.stdin.write(input); // Keep the pipe open: the byte count must end the read.
  const [code]=await once(child,'exit');child.stdin.destroy();
  assert.equal(code,0,error);assert.deepEqual(await fs.readFile(file),input);
});

test('persistent PowerShell forwards a small UTF-8 request before stdin closes', {skip: !ps, timeout: 15000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-stream-flush-'));
  await fs.mkdir(path.join(root, 'src/main/bot'), {recursive: true});
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify({node: process.execPath, release: root}));
  await fs.writeFile(path.join(root, 'src/main/bot/cli.mjs'), "process.stdin.on('data', bytes => process.stdout.write(bytes));");
  const source = powershellSource(windowsCliScript('rpc-stream').replace(/\$root = Join-Path \$env:USERPROFILE '[^']+'/, "$root = '" + root.replaceAll("'", "''") + "'"));
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {stdio: ['pipe', 'pipe', 'pipe']});
  let errors = ''; child.stderr.on('data', bytes => {errors += bytes;});
  t.after(async () => {child.stdin.end(); if (child.exitCode === null) {const exited = once(child, 'exit'); child.kill(); await exited;} await fs.rm(root, {recursive: true, force: true});});
  const input = Buffer.from('small request 中文🙂\n'), received = Promise.withResolvers();
  let body = Buffer.alloc(0);
  child.stdout.on('data', bytes => {body = Buffer.concat([body, bytes]); if (body.length >= input.length) received.resolve(body);});
  child.on('exit', () => received.reject(new Error(errors || 'PowerShell exited before forwarding the request')));
  child.stdin.write(input); // Deliberately keep stdin open, as a persistent SSH channel does.
  assert.deepEqual(await received.promise, input);
});

test('real resident Host starts through the cross-platform control channel and rejects a duplicate Host', {timeout:90000}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-resident-'))), dataDir = path.join(root,'data');
  const env = {...process.env, HEMI_BOT_DATA_DIR:dataDir, HEMI_BOT_ISOLATED_TEST:'1'};
  const entry = path.join(import.meta.dirname,'cli.mjs');
  const child = spawn(process.execPath,[entry,'serve'],{env,stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await fs.rm(root,{recursive:true,force:true});});
  let hello, token, socket;
  // Windows cold imports can take tens of seconds; bound elapsed time, not retries.
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    try{token=controlToken(dataDir);socket=botControlEndpoint(dataDir,process.platform,token);hello=await rpc({method:'handshake'},{socket,token,timeoutMs:500});break;}
    catch{if(child.exitCode!==null)throw new Error(errors);await delay(25);}
  }
  assert.ok(hello,'resident Host responds');
  assert.equal(hello.platform,process.platform);
  if(process.platform==='win32')await assert.rejects(rpc({method:'handshake'},{socket,token:'0'.repeat(64)}),e=>e.code==='permission');
  const duplicate=spawn(process.execPath,[entry,'serve'],{env,stdio:'ignore'});
  assert.notEqual((await once(duplicate,'exit'))[0],0);
  assert.equal((await rpc({method:'handshake'},{socket,token})).bootId,hello.bootId);
});

test('the real CLI preserves UTF-8 split across stdin and control-pipe chunks', {timeout:15000}, async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-cli-utf8-')));
  const token=controlToken(root,{create:true}),socket=botControlEndpoint(root,process.platform,token);
  const server=net.createServer({allowHalfOpen:true},client=>{
    const decoder=new StringDecoder('utf8');let body='';
    client.on('data',chunk=>{body+=decoder.write(chunk);if(body.includes('\n')){const request=JSON.parse(body);assert.equal(request.controlToken,token);client.end(JSON.stringify({ok:true,result:request.params.text})+'\n');}});
    client.on('error',()=>{});
  });
  server.listen(socket);await once(server,'listening');
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'cli.mjs'),'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:root},stdio:['pipe','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const text='中文🙂'.repeat(24000),input=Buffer.from(JSON.stringify({method:'echo',params:{text}}));
  const output=[];let error='';child.stdout.on('data',chunk=>output.push(chunk));child.stderr.on('data',chunk=>error+=chunk);child.stdin.on('error',()=>{});
  const split=input.indexOf(Buffer.from('中文'))+1;
  child.stdin.write(input.subarray(0,split));
  await delay(200);child.stdin.end(input.subarray(split));
  const [code]=await once(child,'exit');assert.equal(code,0,error);
  const reply=JSON.parse(Buffer.concat(output).toString());
  assert.equal(reply.result.length,text.length);assert.ok(reply.result===text,'CLI changed Unicode across a chunk boundary');
});

test('Windows pre-install directory browser executes the real PowerShell path handling', {skip:process.platform!=='win32'}, async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"hemi 中文'目录-")));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'中文 folder'));
  const runner={async exec({command}){try{const result=await exec('cmd.exe',['/d','/s','/c',command],{encoding:'buffer',windowsHide:true});return{code:0,stdout:result.stdout,stderr:result.stderr.toString()};}catch(e){return{code:e.code,stdout:e.stdout,stderr:e.stderr.toString()};}}};
  const transport=createBotTransport({runner});transport.setPlatform('local','win32');
  const view=await transport.directory('local',root);
  assert.equal(view.path,root);assert.equal(view.folders[0].path,path.join(root,'中文 folder'));
  await assert.rejects(transport.directory('local',path.join(root,'missing')),e=>e.code==='missing');
});

test('Windows installation gives a new root only owner/SYSTEM access and preserves the ACL on repeat', {skip:process.platform!=='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-root-acl-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const script=powershellSource(windowsRootSetupScript+`\n$before=(Get-Acl -LiteralPath $root).Sddl\n${windowsRootSetupScript}\nif((Get-Acl -LiteralPath $root).Sddl -ne $before){throw 'Existing private ACL changed'}\n$acl=Get-Acl -LiteralPath $root; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2){throw 'Root is not private'}\nforeach($rule in $rules){if($rule.IdentityReference.Value -notin @($sid,'S-1-5-18')){throw 'Unexpected ACL identity'}}`);
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,USERPROFILE:root}});
});

test('Windows PowerShell can atomically replace the active pointer without creating a backup path', {skip:process.platform!=='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-pointer-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const old=path.join(root,'current.json'),next=path.join(root,'next.json');
  await fs.writeFile(old,'old');await fs.writeFile(next,'new');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const script=powershellSource(`[IO.File]::Replace(${quote(next)},${quote(old)},[NullString]::Value)`);
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
  assert.equal(await fs.readFile(old,'utf8'),'new');
});

test('Windows command execution preserves nested quotes and waits for process registration before writing', {skip:process.platform!=='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-cmd-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const gated of [false,true]){
    const file=gated?'gated.md':'plain.md';let registered=false;
    const out=await runCommand({command:`node -e "require('fs').writeFileSync('${file}','quoted command bytes')"`,cwd:root,
      ...(gated?{onSpawn:async()=>{assert.equal(await fs.stat(path.join(root,file)).then(()=>true,()=>false),false);registered=true;}}:{})});
    assert.equal(out.status,'succeeded',JSON.stringify(out));
    assert.equal(await fs.readFile(path.join(root,file),'utf8'),'quoted command bytes');
    if(gated)assert.equal(registered,true);
  }
});

test('Windows registration failure prevents command side effects', {skip:process.platform!=='win32'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-cmd-denied-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const out=await runCommand({command:'node -e "require(\'fs\').writeFileSync(\'must-not-exist\',\'bad\')"',cwd:root,onSpawn:async()=>{throw new Error('registration rejected');}});
  assert.equal(out.status,'start-failed');
  assert.equal(await fs.stat(path.join(root,'must-not-exist')).then(()=>true,()=>false),false);
});
