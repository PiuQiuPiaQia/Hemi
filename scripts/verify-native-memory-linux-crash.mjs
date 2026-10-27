// Actual systemd recovery after killing the owned Host during an external model request.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createSshRunner} from '../src/main/remote/ssh-runner.mjs';
import {createBotTransport} from '../src/main/bot/transport.mjs';
const exec=promisify(execFile),repo=path.resolve(import.meta.dirname,'..'),baseline=JSON.parse(await fs.readFile(path.join(repo,'.visual/workflow/bot-implementation/linux-validation.json'),'utf8'));
if(!baseline.name.startsWith('hemi-bot-verify-'))throw Error('Unexpected fixture');
const report={checks:[]},docker=(...args)=>exec('docker',args,{timeout:30000,maxBuffer:1024*1024});
const runner=createSshRunner({controlDir:path.join(baseline.root,'crash-sockets'),sshBin:baseline.sshBin,strictHostKeyChecking:true}),transport=createBotTransport({runner}),host='hemi-bot-isolated';
const wait=async fn=>{const until=Date.now()+20000;let last;while(Date.now()<until){try{const value=await fn();if(value)return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}throw last??Error('Timed out');};
const remote=script=>docker('exec',baseline.name,'node','--input-type=module','-e',script);
const traces=async()=>JSON.parse((await remote("console.log(await(await fetch('http://127.0.0.1:3030/fixture-state')).text());")).stdout);
try{
 await remote("import fs from 'node:fs';for(const pid of fs.readdirSync('/proc'))if(/^[0-9]+$/.test(pid)){try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0)).includes('/tmp/native-memory-model.mjs'))process.kill(Number(pid),'SIGTERM');}catch{}}");
 await docker('cp',path.join(repo,'scripts/fixtures/cloud-bot/native-memory-model.mjs'),baseline.name+':/tmp/native-memory-model.mjs');await docker('exec','-d',baseline.name,'node','/tmp/native-memory-model.mjs');
 const hello=await transport.rpc(host,'handshake'),call=(method,params={})=>transport.rpc(host,method,{instanceId:hello.instanceId,requestId:randomUUID(),...params});
 const session=await call('session.create');const op={name:'memory_write',args:{target:'long_term',content:'LINUX_CRASH_MUST_NOT_REPLAY'}};
 await call('flow.command',{id:session.id,command:{type:'send',input:{inputId:randomUUID(),text:'NATIVE_TOOL_'+Buffer.from(JSON.stringify(op)).toString('base64url')+' NATIVE_CRASH_DELAY'}}});
 await wait(async()=> (await traces()).length>0);const before=(await traces()).length;
 const pid=Number((await docker('exec','-u','hemi','-e','XDG_RUNTIME_DIR=/run/user/1001',baseline.name,'systemctl','--user','show','hemi-bot','--property','MainPID','--value')).stdout.trim());assert.ok(pid>1);
 await docker('exec','-u','hemi',baseline.name,'kill','-KILL',String(pid));
 const restarted=await wait(async()=>{const value=await transport.rpc(host,'handshake');return value.bootId!==hello.bootId?value:null;});assert.equal(restarted.instanceId,hello.instanceId);
 const detail=await call('session.open',{id:session.id});assert.equal(detail.flow.activeRunId,null);assert.notEqual(Object.values(detail.flow.runs).at(-1).outcome,'completed');report.checks.push('systemd restarts killed Host and reports interrupted run');
 assert.equal((await traces()).length,before);assert.ok(!(await call('agent-environment.read-file',{path:'MEMORY.md'})).text.includes('LINUX_CRASH_MUST_NOT_REPLAY'));report.checks.push('accepted unknown native write is neither replayed nor reported as saved');
 report.ok=true;console.log('PASS Linux SIGKILL recovery, stable instance and no native write replay');
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{runner.close();await fs.writeFile(path.join(repo,'.visual/workflow/native-memory/linux/crash-report.json'),JSON.stringify(report,null,2));}
