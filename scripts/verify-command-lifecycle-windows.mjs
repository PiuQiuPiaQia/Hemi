// Isolated real Windows processes only. Never updates/restarts the resident Bot.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {build} from 'esbuild';
import {powershellCommand} from '../src/main/bot/windows-transport.mjs';
import {buildBotRuntime} from './build-bot-runtime.mjs';
const exec=promisify(execFile),repo=path.resolve(import.meta.dirname,'..');
const host=process.env.HEMI_BOT_TEST_HOST;
if(!host)throw Error('Set HEMI_BOT_TEST_HOST to an authorized Windows SSH target');
const socket=process.env.HEMI_BOT_TEST_SSH_SOCKET;
const protectedPids=String(process.env.HEMI_BOT_PROTECTED_PIDS??'').split(',').filter(Boolean).map(Number);
if(!protectedPids.length||protectedPids.some(pid=>!Number.isSafeInteger(pid)||pid<=1))throw Error('Set HEMI_BOT_PROTECTED_PIDS to the production process IDs whose identities must stay unchanged');
const options=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',...(socket?['-o','ControlPath='+socket]:[])];
const output=path.join(repo,'.visual/workflow/command-lifecycle');await fs.mkdir(output,{recursive:true});
const report={date:new Date().toISOString(),commit:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),workingTree:true,checks:[],sources:{},remote:null};
const ssh=async(script,timeout=45000)=>exec('ssh',[...options,'-o','ControlMaster=no',host,powershellCommand(script)],{timeout,maxBuffer:1024*1024});
let remote;
try{
  const prepare=await ssh(`$d=Join-Path $env:TEMP 'hemi-command-lifecycle-${randomUUID()}';[IO.Directory]::CreateDirectory($d)|Out-Null;$r=Join-Path $env:USERPROFILE '.local\\share\\hemi-bot';$a=Get-Content -LiteralPath (Join-Path $r 'current.json') -Encoding UTF8 -Raw|ConvertFrom-Json;[Console]::WriteLine('__TEST__'+(@{dir=$d;node=$a.node;nodeVersion=(& $a.node --version);os=(Get-CimInstance Win32_OperatingSystem|Select-Object Caption,Version,BuildNumber);dotnetOnPath=[bool](Get-Command dotnet.exe -ErrorAction SilentlyContinue);cscOnPath=[bool](Get-Command csc.exe -ErrorAction SilentlyContinue);production=@(Get-Process -Id ${protectedPids.join(',')} -ErrorAction SilentlyContinue|Select-Object Id,StartTime)}|ConvertTo-Json -Depth 4 -Compress))`);
  remote=JSON.parse(prepare.stdout.split(/\r?\n/).find(line=>line.startsWith('__TEST__')).slice(8));report.remote=remote;
  if(remote.production.length!==protectedPids.length)throw Error('A protected production process is missing before verification');
  const fixed=path.join(output,'fixed.test.mjs');
  await build({entryPoints:[path.join(repo,'src/main/agent/gate/command-lifecycle.test.mjs')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:fixed});
  const files=[fixed,...['cs','exe','json'].map(extension=>path.join(repo,'src/main/agent/gate/windows-command-job.'+extension))];
  const archive=path.join(output,'source.tgz');
  await exec('tar',['--no-xattrs','--no-acls','--exclude=._*','-czf',archive,'src/main','src/shared','scripts/lib'],{cwd:repo,env:{...process.env,COPYFILE_DISABLE:'1'},maxBuffer:65536});
  files.push(archive);
  const runtime=path.join(output,'hemi-bot-runtime.tgz');await buildBotRuntime({output:runtime});files.push(runtime);
  const probe=path.join(output,'packaged-probe.mjs');
  await fs.writeFile(probe,`import assert from 'node:assert/strict';
import {runCommand} from './packaged/src/main/agent/gate/command-execution.mjs';
const result=await runCommand({command:'echo PACKAGED_SUPERVISOR',timeoutMs:5000});
assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.cleanupConfirmed,true);assert.match(result.stdout,/PACKAGED_SUPERVISOR/);
console.log(JSON.stringify({status:result.status,cleanupConfirmed:result.cleanupConfirmed,compilerInvoked:false}));\n`);
  files.push(probe);
  const baseline=path.join(output,'baseline-command-lifecycle.test.mjs');
  if(process.env.HEMI_COMMAND_BASELINE==='1'){
    await fs.copyFile(path.join(output,'baseline-windows-command-entry.mjs'),path.join(output,'windows-command-entry.mjs'));
    files.push(baseline,path.join(output,'windows-command-entry.mjs'));
  }
  for(const file of files){
    report.sources[path.basename(file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    await exec('scp',[...options,file,host+':'+remote.dir.replaceAll('\\','/')+'/'+path.basename(file)],{timeout:45000,maxBuffer:65536});
  }
  const literal=s=>"'"+s.replaceAll("'","''")+"'";
  const isolatedTemp=`$env:TEMP=Join-Path ${literal(remote.dir)} 'tmp';[IO.Directory]::CreateDirectory($env:TEMP)|Out-Null;$env:TMP=$env:TEMP;`;
  if(process.env.HEMI_COMMAND_BASELINE==='1'){
    try{
      const before=await ssh(`${isolatedTemp}$env:HEMI_USER_DATA_DIR=Join-Path ${literal(remote.dir)} 'baseline-profile';& ${literal(remote.node)} --test --test-name-pattern 'detached grandchild' ${literal(path.win32.join(remote.dir,path.basename(baseline)))}`,45000);
      await fs.writeFile(path.join(output,'windows-baseline.log'),before.stdout+before.stderr);
      report.checks.push({name:'baseline inherited-pipe reproduction',result:'did-not-fail'});
    }catch(error){
      await fs.writeFile(path.join(output,'windows-baseline.log'),String(error.stdout??'')+String(error.stderr??''));
      report.checks.push({name:'baseline inherited-pipe reproduction',result:'failed-as-expected',exitCode:error.code});
    }
  }
  const result=await ssh(`${isolatedTemp}$env:HEMI_USER_DATA_DIR=Join-Path ${literal(remote.dir)} 'fixed-profile';& ${literal(remote.node)} --test ${literal(path.win32.join(remote.dir,'fixed.test.mjs'))}`,60000);
  await fs.writeFile(path.join(output,'windows-fixed.log'),result.stdout+result.stderr);
  console.log(result.stdout);report.checks.push({name:'actual Windows command lifecycle tests',result:'passed'});
  const hostResult=await ssh(`${isolatedTemp}$d=${literal(remote.dir)};$s=Join-Path $d 'source';[IO.Directory]::CreateDirectory($s)|Out-Null;& tar.exe -xzf (Join-Path $d 'source.tgz') -C $s;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};$r=Join-Path $env:USERPROFILE '.local\\share\\hemi-bot';$a=Get-Content -LiteralPath (Join-Path $r 'current.json') -Encoding UTF8 -Raw|ConvertFrom-Json;New-Item -ItemType Junction -Path (Join-Path $s 'node_modules') -Value (Join-Path $a.release 'node_modules')|Out-Null;$env:HEMI_USER_DATA_DIR=Join-Path $d 'host-profile';& ${literal(remote.node)} --test (Join-Path $s 'src\\main\\bot\\command-lifecycle.test.mjs')`,60000);
  await fs.writeFile(path.join(output,'windows-host.log'),hostResult.stdout+hostResult.stderr);
  console.log(hostResult.stdout);report.checks.push({name:'actual Windows Host/SDK commands, stop and queue handoff',result:'passed'});
  const recoveryFiles=['src/main/agent-runtime/model-failure.test.mjs','src/main/agent-runtime/model-recovery.test.mjs','src/main/agent-runtime/run-journal.test.mjs','src/main/agent/model-timeout.test.mjs','src/main/bot/task-identity.integration.test.mjs'];
  const recovery=await ssh(`${isolatedTemp}$d=${literal(remote.dir)};Set-Location (Join-Path $d 'source');$env:HEMI_USER_DATA_DIR=Join-Path $d 'recovery-profile';& ${literal(remote.node)} --experimental-test-isolation=none --test-force-exit --test ${recoveryFiles.map(literal).join(' ')};if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`,60000);
  await fs.writeFile(path.join(output,'windows-recovery.log'),recovery.stdout+recovery.stderr);
  console.log(recovery.stdout);report.checks.push({name:'actual Windows SDK timeout recovery, request journal and restart task identity',result:'passed'});
  const quoting=await ssh(`${isolatedTemp}$env:HEMI_USER_DATA_DIR=Join-Path ${literal(remote.dir)} 'quoting-profile';$env:PATH=(Split-Path -Parent ${literal(remote.node)})+';'+$env:PATH;& ${literal(remote.node)} --test --test-name-pattern 'Windows command execution|Windows registration failure' ${literal(path.win32.join(remote.dir,'source/src/main/bot/windows.test.mjs'))};if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`,30000);
  await fs.writeFile(path.join(output,'windows-quoting.log'),quoting.stdout+quoting.stderr);
  report.checks.push({name:'existing nested quoting and durable-registration regressions',result:'passed'});
  const packaged=await ssh(`${isolatedTemp}$d=${literal(remote.dir)};$p=Join-Path $d 'packaged';[IO.Directory]::CreateDirectory($p)|Out-Null;& tar.exe -xzf (Join-Path $d 'hemi-bot-runtime.tgz') -C $p;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};$env:HEMI_USER_DATA_DIR=Join-Path $d 'package-profile';& ${literal(remote.node)} (Join-Path $d 'packaged-probe.mjs');if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`,30000);
  await fs.writeFile(path.join(output,'windows-packaged.log'),packaged.stdout+packaged.stderr);
  report.checks.push({name:'packaged supervisor executes without a compiler or SDK invocation',result:'passed'});
  const after=await ssh(`[Console]::WriteLine('__TEST__'+(@{production=@(Get-Process -Id ${protectedPids.join(',')} -ErrorAction SilentlyContinue|Select-Object Id,StartTime)}|ConvertTo-Json -Depth 4 -Compress))`);
  report.after=JSON.parse(after.stdout.split(/\r?\n/).find(line=>line.startsWith('__TEST__')).slice(8));
  const identity=items=>JSON.stringify([...items].sort((a,b)=>a.Id-b.Id));
  if(identity(remote.production)!==identity(report.after.production))throw Error('Production process identities changed during verification; inspect evidence');
  report.checks.push({name:'production Host and DSH process identities unchanged',result:'passed'});
}catch(error){
  report.error={message:error.killed?'Remote verification exceeded its deadline':error.code?'Verification command failed; inspect windows-failure.log':error.message,code:error.code};
  if(error.stdout||error.stderr)await fs.writeFile(path.join(output,'windows-failure.log'),String(error.stdout??'')+String(error.stderr??''));
  throw error;
}finally{
  // Keep the isolated folder if verification failed, for scoped recovery/inspection.
  if(remote&&!report.error)await ssh(`$s=Join-Path '${remote.dir.replaceAll("'","''")}' 'source\\node_modules';if(Test-Path -LiteralPath $s){[IO.Directory]::Delete($s)};Remove-Item -LiteralPath '${remote.dir.replaceAll("'","''")}' -Recurse -Force`).catch(()=>{});
  await fs.writeFile(path.join(output,'windows-report.json'),JSON.stringify(report,null,2)+'\n');
}
