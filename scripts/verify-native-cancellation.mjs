import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {createDeviceGateway} from '../src/main/bot/device-gateway.mjs';
const exec=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-cancel-')),instanceId=randomUUID();
const port=net.createServer();await new Promise(r=>port.listen(0,'127.0.0.1',r));const endpoint=`https://127.0.0.1:${port.address().port}`;await new Promise(r=>port.close(r));
let finishRead,child,stderr='';const requests=[];
const gateway=await createDeviceGateway({dataDir:root,instanceId,listenHost:'127.0.0.1',request:async(method,params)=>{
 requests.push(method+':'+(params.id??''));
 if(method==='flow.snapshot'){await fs.writeFile(path.join(root,'read-started'),'');await new Promise(r=>finishRead=r);return {history:'x'.repeat(5*1024*1024)}}
 return {instanceId,live:true};
}});
const read=async name=>fs.readFile(path.join(root,name),'utf8').then(JSON.parse,()=>null);
const wait=async fn=>{const until=Date.now()+15000;while(!await fn()){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Native fixture exited: '+stderr);assert.ok(Date.now()<until,'Native cancellation timed out');await new Promise(r=>setTimeout(r,20));}};
const report={date:new Date().toISOString(),node:process.version,platform:process.platform+'/'+process.arch};
try {
 await gateway.management('pairing.configure',{endpoint});await fs.writeFile(path.join(root,'invite.json'),(await gateway.management('pairing.create')).qr);
 const binary=path.join(root,'native');await exec('xcrun',['swiftc','-parse-as-library','apps/mobile/ios/App/App/HemiDeviceClient.swift','apps/mobile/test/NativeCancellationIntegration.swift','-o',binary],{timeout:60000});
 child=spawn(binary,[root],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>stderr+=b);
 await wait(()=>read('requested.json'));const invitation=(await gateway.management('pairing.status')).invitation,pending=invitation.request;
 await gateway.management('pairing.approve',{operationId:randomUUID(),inviteId:invitation.inviteId,deviceRequestId:pending.requestId,deviceId:pending.deviceId,code:pending.code});await fs.writeFile(path.join(root,'approved'),'');
 await wait(()=>read('result.json'));report.native=await read('result.json');assert.equal(report.native.otherRequestSucceeded,true);assert.equal(requests.filter(x=>x.startsWith('flow.snapshot')).length,1);
 await wait(()=>child.exitCode!==null);assert.equal(child.exitCode,0,stderr);report.success=true;report.readOnlyRequests=requests.length;
 console.log(JSON.stringify(report));
} finally {
 finishRead?.();child?.kill();await gateway.close();await fs.rm(root,{recursive:true,force:true});
 const folder='.visual/workflow/shared-sdk-sync';await fs.mkdir(folder,{recursive:true});report.sourceSha256=createHash('sha256').update(await fs.readFile('apps/mobile/ios/App/App/HemiDeviceClient.swift')).digest('hex');await fs.writeFile(path.join(folder,'native-cancellation.json'),JSON.stringify(report,null,2));
}
