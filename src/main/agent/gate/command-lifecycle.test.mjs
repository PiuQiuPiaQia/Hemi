import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runCommand,createCommandScope} from './command-execution.mjs';
import {withExecutionScope} from '../../agent-runtime/execution-scope.mjs';
import {assertCommandCleanup} from './command-deadline.mjs';
import {processBirth,recoverOwnedProcesses} from '../../agent-runtime/owned-processes.mjs';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile), pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>process.platform==='win32'?`'${s.replaceAll("'","''")}'`:`'${s.replaceAll("'","'\\''")}'`;
const deadline=(promise,ms=15000)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('command did not settle')),ms);timer.unref();})]);

test('detached grandchild inheriting pipes is reaped after its launching shell exits', {timeout:30000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-tree-'));
  const child=path.join(dir,'child.cjs'), marker=path.join(dir,'pid'), late=path.join(dir,'late');
  await fs.writeFile(child,`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'leaked'),20000);setInterval(()=>{},1000);`);
  t.after(async()=>{
    const pid=Number(await fs.readFile(marker,'utf8').catch(()=>0));
    if(pid){
      if(process.platform==='win32')await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p -and $p.CommandLine.Contains('${child.replaceAll("'","''")}')){Stop-Process -Id ${pid} -Force}`],{timeout:10000}).catch(()=>{});
      else {try{process.kill(pid,'SIGKILL');}catch{}}
    }
    await fs.rm(dir,{recursive:true,force:true});
  });
  const command=process.platform==='win32'
    ? `powershell.exe -NoProfile -NonInteractive -Command "$p=Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @(${quote(child)}) -RedirectStandardOutput ${quote(path.join(dir,'out'))} -RedirectStandardError ${quote(path.join(dir,'err'))} -PassThru -WindowStyle Hidden; Write-Output ('PID='+$p.Id)"`
    : `${quote(process.execPath)} ${quote(child)} & sleep 0.2; printf started`;
  const result=await deadline(runCommand({command,timeoutMs:0,onSpawn:async()=>{}}));
  assert.equal(result.cleanupConfirmed,true,JSON.stringify(result));
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  const pid=Number(await fs.readFile(marker,'utf8').catch(()=>0));
  // Windows Job accounting and POSIX process-group confirmation must both drain.
  if(pid){await pause(100);assert.equal(await processBirth(pid).catch(()=>null),null);}
  assert.equal(await fs.readFile(late,'utf8').catch(()=>null),null);
});

for(const mode of ['abort','timeout','registration-failure','registration-stall'])test(`real command ${mode} settles without executing late effects`,{timeout:30000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-cancel-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'late'), script=path.join(dir,'child.cjs');
  await fs.writeFile(script,`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'leaked'),10000);`);
  const command=`"${process.execPath}" "${script}"`, controller=new AbortController();
  const run=runCommand({command,signal:controller.signal,timeoutMs:mode==='timeout'?200:0,registrationTimeoutMs:200,
    onSpawn:mode==='registration-failure'?async()=>{throw Error('disk unavailable');}:mode==='registration-stall'?()=>new Promise(()=>{}):async()=>{}});
  if(mode==='abort'){await pause(100);controller.abort();}
  const result=await deadline(run);
  assert.equal(result.cleanupConfirmed,true,JSON.stringify(result));
  assert.equal(result.status,mode==='timeout'?'timed-out':mode==='abort'?'cancelled':'start-failed',JSON.stringify(result));
  assert.equal(await fs.readFile(marker,'utf8').catch(()=>null),null);
});

test('late or failed persistence quarantines execution and cannot start a command after settlement',{timeout:30000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-persist-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const script=path.join(dir,'effect.cjs'),marker=path.join(dir,'marker');
  await fs.writeFile(script,`require('fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  let release;const ended=[];
  const journal={processStart:()=>new Promise(resolve=>{release=resolve;}),processEnd:async(id,result)=>{ended.push(result);}};
  const execution={owner:{conversationId:'c',rootRunId:'r',generation:1},journal};
  const commands=createCommandScope({persistenceTimeoutMs:100,settleTimeoutMs:1000});
  await assert.rejects(deadline(withExecutionScope(execution,null,()=>commands.run({command:`"${process.execPath}" "${script}"`}))),{code:'cleanup-unconfirmed'});
  assert.equal(await fs.readFile(marker,'utf8').catch(()=>null),null);
  assert.throws(()=>assertCommandCleanup(journal),{code:'cleanup-unconfirmed'});
  release();await pause(100);
  assert.equal(ended.at(-1).state,'unknown');
  await assert.rejects(commands.run({command:'echo forbidden'}),{code:'cleanup-unconfirmed'});

  const failing={processStart:async()=>{},processEnd:async()=>{throw Error('disk failure');}};
  const second=createCommandScope({persistenceTimeoutMs:100});
  await assert.rejects(deadline(withExecutionScope({...execution,journal:failing},null,()=>second.run({command:'echo done'}))),{code:'cleanup-unconfirmed'});
  await assert.rejects(deadline(second.abort()),{code:'cleanup-unconfirmed'});

  const backgroundJournal={processStart:async()=>{},processEnd:async()=>{},processBackground:()=>new Promise(()=>{})};
  const third=createCommandScope({persistenceTimeoutMs:100,settleTimeoutMs:1500});
  const long=path.join(dir,'long.cjs');await fs.writeFile(long,'setInterval(()=>{},1000);');
  await assert.rejects(deadline(withExecutionScope({...execution,journal:backgroundJournal},null,()=>third.run({command:`"${process.execPath}" "${long}"`,runInBackground:true}))),{code:'cleanup-unconfirmed'});
  await assert.rejects(third.abort(),{code:'cleanup-unconfirmed'});
});

test('supervisor death reaps owned descendants; stale Windows PID records cannot kill another Job',{timeout:30000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-owner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'child.cjs'),marker=path.join(dir,'pid');
  await fs.writeFile(file,`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
  let guard;
  const pending=runCommand({command:`"${process.execPath}" "${file}"`,timeoutMs:12000,onSpawn:async pid=>{guard=pid;}});
  const until=Date.now()+10000;while(!await fs.readFile(marker,'utf8').catch(()=>false)){assert.ok(Date.now()<until);await pause(30);}
  const pid=Number(await fs.readFile(marker,'utf8'));
  if(process.platform==='win32'){
    // Model a recycled PID now owned by a different Job, without killing that PID.
    const stale={id:'stale',state:'active',isolation:'windows-job-v1',pid:guard,token:randomUUID()};
    await recoverOwnedProcesses({snapshot:async()=>({processes:{stale}}),processEnd:async()=>{}});
    assert.ok(await processBirth(pid));
  }
  process.kill(guard,'SIGKILL');
  const result=await deadline(pending);
  assert.equal(result.cleanupConfirmed,true,JSON.stringify(result));
  assert.equal(result.status,'failed');
  assert.equal(await processBirth(pid).catch(()=>null),null);
});

test('Windows recovery drains the recorded Job even when the saved parent PID is gone',{timeout:20000,skip:process.platform!=='win32'},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-recovery-'));
  const file=path.join(dir,'child.cjs'),marker=path.join(dir,'pid'),token=randomUUID(),controller=new AbortController();
  await fs.writeFile(file,`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
  const pending=runCommand({command:`"${process.execPath}" "${file}"`,ownerToken:token,timeoutMs:8000,signal:controller.signal});
  t.after(async()=>{controller.abort();await deadline(pending);await fs.rm(dir,{recursive:true,force:true});});
  const until=Date.now()+7000;while(!await fs.readFile(marker,'utf8').catch(()=>false)){assert.ok(Date.now()<until);await pause(30);}
  const pid=Number(await fs.readFile(marker,'utf8')),ended=[];
  const legacy={id:'legacy',state:'active',pid,birth:await processBirth(pid),token:randomUUID()};
  await assert.rejects(recoverOwnedProcesses({snapshot:async()=>({processes:{legacy}}),processEnd:async(_id,result)=>{assert.equal(result.cleanupConfirmed,false);}}),{code:'cleanup-unconfirmed'});
  assert.ok(await processBirth(pid),'legacy recovery must not kill an unowned service');
  const record={id:'interrupted',state:'unknown',cleanupConfirmed:false,isolation:'windows-job-v1',pid:2147483647,token};
  await recoverOwnedProcesses({snapshot:async()=>({processes:{interrupted:record}}),processEnd:async(id,result)=>{ended.push({id,...result});}});
  assert.equal((await deadline(pending)).cleanupConfirmed,true);
  assert.equal(await processBirth(pid).catch(()=>null),null);
  assert.equal(ended[0].cleanupConfirmed,true);assert.equal(ended[0].state,'recovered');
});
