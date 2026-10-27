// Existing owned Linux fixture: strict SSH management + real paired ES256/TLS device RPC.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createSshRunner} from '../src/main/remote/ssh-runner.mjs';
import {createBotTransport} from '../src/main/bot/transport.mjs';
const exec=promisify(execFile),repo=path.resolve(import.meta.dirname,'..'),baseline=JSON.parse(await fs.readFile(path.join(repo,'.visual/workflow/bot-implementation/linux-validation.json'),'utf8'));
if(!baseline.name.startsWith('hemi-bot-verify-'))throw Error('Expected owned fixture');
const report={checks:[],container:baseline.name},host='hemi-bot-isolated';
const runner=createSshRunner({controlDir:path.join(baseline.root,'device-sockets'),sshBin:baseline.sshBin,strictHostKeyChecking:true}),transport=createBotTransport({runner});
const docker=(...args)=>exec('docker',args,{timeout:30000,maxBuffer:1024*1024});
const check=(name,value=true)=>{assert.ok(value,name);report.checks.push(name);console.log('PASS',name);};
try{
 const hello=await transport.rpc(host,'handshake');const call=(method,params={})=>transport.rpc(host,method,{instanceId:hello.instanceId,requestId:randomUUID(),...params});
 const endpoint='https://hemi-bot-model:29421';await call('pairing.configure',{endpoint});
 await docker('cp',path.join(repo,'scripts/fixtures/cloud-bot/native-memory-device.mjs'),baseline.name+':/tmp/native-memory-device.mjs');
 await docker('exec',baseline.name,'chown','hemi:hemi','/tmp/native-memory-device.mjs');
 const device=async(mode,body)=>JSON.parse((await docker('exec','-u','hemi',baseline.name,'node','/tmp/native-memory-device.mjs',mode,JSON.stringify(body))).stdout);
 const {deviceId}=await device('init',{endpoint,instanceId:hello.instanceId});
 check('unpaired device cannot read Bot memory',!(await device('rpc',{method:'agent-environment.read-file',params:{path:'MEMORY.md'}})).ok);
 const invite=JSON.parse((await call('pairing.create')).qr),requestId=randomUUID();
 const applied=await device('apply',{inviteId:invite.inviteId,ticket:invite.requestTicket,requestId,name:'Isolated native memory device'});assert.equal(applied.ok,true);
 const pending=(await call('pairing.status',{inviteId:invite.inviteId})).invitation.request;assert.equal(pending.deviceId,deviceId);assert.equal(pending.code,applied.result.code);
 await call('pairing.approve',{inviteId:invite.inviteId,deviceRequestId:pending.requestId,deviceId,code:pending.code,operationId:randomUUID()});check('real Linux TLS pairing requires exact SSH-side approval');
 const session=await device('rpc',{method:'session.create',params:{requestId:randomUUID()}});assert.equal(session.ok,true);const id=session.result.id;
 const control=await device('rpc',{method:'session.control',params:{id,action:'takeover',requestId:randomUUID()}});assert.equal(control.result.ok,true);
 const op={name:'memory_write',args:{target:'long_term',content:'PAIRED_DEVICE_NATIVE_SHARED_FACT'}};
 const receipt=await device('rpc',{method:'flow.command',params:{id,controlEpoch:control.result.control?.epoch,requestId:randomUUID(),command:{type:'send',input:{inputId:randomUUID(),text:'NATIVE_TOOL_'+Buffer.from(JSON.stringify(op)).toString('base64url')}}}});assert.equal(receipt.result.ok,true);
 const end=Date.now()+30000;let completed=false;while(Date.now()<end){const d=await call('session.open',{id});if(!d.flow.activeRunId&&Object.values(d.flow.runs).length){assert.equal(Object.values(d.flow.runs).at(-1).outcome,'completed');completed=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}check('paired device input executes original memory tool on Linux Host',completed);
 const desktop=await call('agent-environment.read-file',{path:'MEMORY.md'}),paired=await device('rpc',{method:'agent-environment.read-file',params:{path:'MEMORY.md'}});check('SSH desktop and paired device read byte-identical shared original file',paired.ok&&paired.result.text===desktop.text&&paired.result.text.includes('PAIRED_DEVICE_NATIVE_SHARED_FACT'));
 for(const params of [{path:'../state.json'},{path:'MEMORY.md',instanceId:'another-bot'}])check('paired device cannot read arbitrary or foreign instance files',!(await device('rpc',{method:'agent-environment.read-file',params})).ok);
 await call('devices.revoke',{deviceId,operationId:randomUUID()});check('revoked device loses memory access',!(await device('rpc',{method:'agent-environment.inspect',params:{}})).ok);
 report.ok=true;
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{runner.close();await fs.writeFile(path.join(repo,'.visual/workflow/native-memory/linux/device-report.json'),JSON.stringify(report,null,2));}
