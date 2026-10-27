// Run after HEMI_KEEP_BOT_TEST_CONTAINER=1 node scripts/verify-bot-linux.mjs.
// Uses that owned fixture only: actual SSH, systemd Host, SDK and official plugin; no optional search dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createSshRunner} from '../src/main/remote/ssh-runner.mjs';
import {createBotTransport} from '../src/main/bot/transport.mjs';
import {buildBotRuntime} from './build-bot-runtime.mjs';
const exec=promisify(execFile),repo=path.resolve(import.meta.dirname,'..'),baseline=JSON.parse(await fs.readFile(path.join(repo,'.visual/workflow/bot-implementation/linux-validation.json'),'utf8'));
const output=path.join(repo,'.visual/workflow/native-memory/linux');await fs.mkdir(output,{recursive:true});
if(!baseline.name.startsWith('hemi-bot-verify-')||baseline.host)throw Error('Unexpected baseline fixture');
const report={checks:[],container:baseline.name,environment:baseline.hello,errors:[]};
const docker=(...args)=>exec('docker',args,{timeout:600000,maxBuffer:4*1024*1024});
const runner=createSshRunner({controlDir:path.join(baseline.root,'memory-sockets'),sshBin:baseline.sshBin,strictHostKeyChecking:true});
let transport,hello;
const host='hemi-bot-isolated',data='/home/hemi/.local/share/hemi-bot/data';
const check=(name,value=true)=>{assert.ok(value,name);report.checks.push(name);console.log('PASS',name);};
const wait=async(fn,label,timeout=240000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,400));}throw last??Error('Timed out '+label);};
const call=(method,params={})=>transport.rpc(host,method,{instanceId:hello.instanceId,requestId:randomUUID(),...params});
const asUser=(...args)=>docker('exec','-u','hemi','-e','XDG_RUNTIME_DIR=/run/user/1001',baseline.name,...args);
const remoteNode=(script,...args)=>docker('exec',baseline.name,'node','--input-type=module','-e',script,...args);
try{
 await docker('inspect',baseline.name);
 await remoteNode(`import fs from 'node:fs';for(const name of fs.readdirSync('/proc'))if(/^[0-9]+$/.test(name)){try{const args=fs.readFileSync('/proc/'+name+'/cmdline','utf8').split(String.fromCharCode(0));if((args.includes('/tmp/model-server.mjs')||args.includes('/tmp/native-memory-model.mjs')))process.kill(Number(name),'SIGTERM');}catch{}}`);
 await docker('cp',path.join(repo,'scripts/fixtures/cloud-bot/native-memory-model.mjs'),baseline.name+':/tmp/native-memory-model.mjs');await docker('exec','-d',baseline.name,'node','/tmp/native-memory-model.mjs');
 const archivePath=await buildBotRuntime();transport=createBotTransport({runner,archivePath});const info=await transport.probe(host);hello=await transport.install(host,info);check('new actual Bot component installed over strict SSH and systemd',hello.platform==='linux');
 await remoteNode(`import fs from 'node:fs';fs.mkdirSync(${JSON.stringify(data+'/memory')},{recursive:true});fs.writeFileSync(${JSON.stringify(data+'/memory/USER.md')},'LINUX_LEGACY_MUST_NOT_LOAD');fs.mkdirSync('/home/hemi/native-project-two',{recursive:true});fs.chownSync('/home/hemi/native-project-two',1001,1001);`);
 async function send(id,name,args={},delay=false){const receipt=await call('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text:'NATIVE_TOOL_'+Buffer.from(JSON.stringify({name,args})).toString('base64url')+(delay?' NATIVE_DELAY':'')}}});assert.equal(receipt.ok,true);if(delay)runner.close();return wait(async()=>{const detail=await call('session.open',{id});if(!detail.flow.activeRunId&&Object.values(detail.flow.runs).length){assert.equal(Object.values(detail.flow.runs).at(-1).outcome,'completed',JSON.stringify(detail.flow.timeline));return detail;}},name);}
 const a=await call('session.create'),b=await call('session.create',{dir:'/home/hemi/native-project-two'});
 await Promise.all([send(a.id,'memory_write',{target:'long_term',content:'LINUX_NATIVE_ONE: default replies are in Chinese.'}),send(b.id,'memory_write',{target:'long_term',content:'LINUX_NATIVE_TWO: The lighthouse project uses PostgreSQL as its database.'})]);
 await send(a.id,'memory_read',{target:'long_term'},true);
 const read=()=>call('agent-environment.read-file',{path:'MEMORY.md'});const text=(await read()).text;check('two Linux conversations and projects retain concurrent original writes after SSH disconnect',text.includes('LINUX_NATIVE_ONE')&&text.includes('LINUX_NATIVE_TWO'));
 await send(b.id,'memory_read',{target:'long_term'});await send(a.id,'memory_write',{target:'daily',content:'LINUX_DAILY_FACT'});await send(b.id,'scratchpad',{action:'add',text:'LINUX_SCRATCH_ITEM'});
 check('original daily and scratchpad files visible through actual RPC',(await call('agent-environment.inspect')).files.some(file=>file.path==='SCRATCHPAD.md'));
 const priorRecoveries=new Set((await call('agent-environment.inspect')).files.filter(file=>file.path.startsWith('recovery/')).map(file=>file.path));
 await send(a.id,'memory_forget',{target:'long_term',match:'LINUX_NATIVE_ONE'});check('native forget removes actual Linux file content',!(await read()).text.includes('LINUX_NATIVE_ONE'));
 const recovery=(await call('agent-environment.inspect')).files.find(file=>file.path.startsWith('recovery/')&&!priorRecoveries.has(file.path));assert.ok(recovery);await send(b.id,'memory_restore',{recoveryId:recovery.path.slice(9,-5)});check('native recovery ID restores actual content',(await read()).text.includes('LINUX_NATIVE_ONE'));
 await assert.rejects(call('agent-environment.read-file',{path:'../state.json'}));await assert.rejects(call('agent-environment.read-file',{path:'MEMORY.md',instanceId:'other-instance'}));check('Linux RPC rejects arbitrary paths and foreign Bot instance');
 await transport.control(host,'stop');await transport.control(host,'start');hello=await call('handshake');
 const files=(await call('agent-environment.inspect')).files;let daily='';for(const file of files.filter(file=>file.path.startsWith('daily/')))daily+=(await call('agent-environment.read-file',{path:file.path})).text;
 check('systemd normal shutdown awaits original plugin summaries',daily.includes('LINUX_NATIVE_SHUTDOWN_SUMMARY'));
 check('native shared library survives service restart',(await read()).text.includes('LINUX_NATIVE_TWO'));
 const inspection=await call('agent-environment.inspect');
 check('Linux viewer has no retired summary or search preferences',!('search' in inspection)&&!('exitSummaryEnabled' in inspection));
 await assert.rejects(call('agent-environment.install-dependencies'));
 check('Linux has no manual search installer');
 const traces=JSON.parse((await remoteNode(`const r=await fetch('http://127.0.0.1:3030/fixture-state');console.log(await r.text());`)).stdout);
 check('legacy bytes remain outside native context',!traces.some(trace=>trace.legacyPresent));
 check('cross-session native snapshot includes current shared fact',traces.some(trace=>trace.factPresent));
 report.ok=true;
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{runner.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));}
