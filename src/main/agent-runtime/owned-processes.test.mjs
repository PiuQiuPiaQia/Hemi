import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRunJournal} from './run-journal.mjs';
import {recoverOwnedProcesses,processBirth} from './owned-processes.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('宿主崩溃后按随机归属标记回收实际进程组；相同PID但标记不符的独立工作存活', {skip:process.platform==='win32'?'Windows进程树需真机验证':false}, async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hemi064-orphans-'));
 let child,independent;
 try{
  const marker=path.join(dir,'started'),late=path.join(dir,'late'),separate=path.join(dir,'independent');
  const journalUrl=new URL('./run-journal.mjs',import.meta.url).href,scopeUrl=new URL('./execution-scope.mjs',import.meta.url).href,commandUrl=new URL('../agent/gate/command-execution.mjs',import.meta.url).href;
  const source=`import {createRunJournal} from ${JSON.stringify(journalUrl)};import {withExecutionScope} from ${JSON.stringify(scopeUrl)};import {createCommandScope} from ${JSON.stringify(commandUrl)};const journal=createRunJournal({dir:${JSON.stringify(dir)}}),owner={conversationId:'c',rootRunId:'r',generation:0};await journal.beginRoot(owner);await withExecutionScope({journal,owner},null,()=>createCommandScope().run({command:${JSON.stringify(`printf started > '${marker}'; sleep 2; printf forbidden > '${late}'`)}}));`;
  child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore'});
  const deadline=Date.now()+5000;while(!(await readFile(marker,'utf8').catch(()=>null))){assert.ok(Date.now()<deadline,'命令没有实际开始');await pause(20);}
  const ended=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await ended;
  const journal=createRunJournal({dir});const active=Object.values((await journal.snapshot()).processes);assert.equal(active.length,1);assert.equal(active[0].state,'active');
  await recoverOwnedProcesses(journal);assert.ok(['gone','recovered'].includes((await journal.snapshot()).processes[active[0].id].state));
  // 单独制造带可信启动标记的遗留进程，确保重启清理分支实际发送信号，而非只验已消失分支。
  const orphan=spawn('/bin/bash',['-c','sleep 30; __hemi_status=$?; exit "$__hemi_status"','hemi-command:recovery-test'],{detached:true,stdio:'ignore'});
  await new Promise(r=>orphan.once('spawn',r));const orphanExited=new Promise(r=>orphan.once('exit',r));
  const ownerForOrphan={conversationId:'c',rootRunId:'r',generation:0};
  await journal.processStart({id:'orphan',pid:orphan.pid,token:'recovery-test',birth:await processBirth(orphan.pid),owner:ownerForOrphan});
  await recoverOwnedProcesses(journal);await orphanExited;assert.equal((await journal.snapshot()).processes.orphan.state,'recovered');
  independent=spawn('/bin/bash',['-c',`sleep 0.3; printf safe > '${separate}'`],{detached:true,stdio:'ignore',env:{...process.env,HEMI_COMMAND_TOKEN:'independent'}});
  const owner={conversationId:'c',rootRunId:'r',generation:0};await journal.processStart({id:'stale',pid:independent.pid,birth:'different-birth',token:'wrong-token',owner});
  await recoverOwnedProcesses(journal);await pause(2200);
  assert.equal(await readFile(late,'utf8').catch(()=>null),null);assert.equal(await readFile(separate,'utf8'),'safe');
 }finally{if(child&&!child.killed)child.kill('SIGKILL');if(independent){try{process.kill(-independent.pid,'SIGKILL');}catch{}}await rm(dir,{recursive:true,force:true});}
});
