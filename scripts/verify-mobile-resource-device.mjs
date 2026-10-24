import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import {execFile} from 'node:child_process';import {promisify}from'node:util';import{randomUUID}from'node:crypto';import{resourceFixture,wait}from'../apps/mobile/test/resource-fixture.mjs';
const exec=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-resource-native-')),f=await resourceFixture();
try{
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 await f.call('pairing.configure',{endpoint:`https://127.0.0.1:${port}`});const invite=await f.call('pairing.create');await fs.writeFile(path.join(root,'invite.json'),invite.qr);
 const binary=path.join(root,'native-resource-client');await exec('xcrun',['swiftc','-parse-as-library','apps/mobile/ios/App/App/HemiDeviceClient.swift','apps/mobile/ios/App/App/HemiResourceStore.swift','apps/mobile/test/NativeResourceDeviceIntegration.swift','-o',binary],{timeout:60000});
 const native=exec(binary,[root,f.id,f.byName['大文件.zip']],{timeout:30000});native.catch(()=>{});
 let pending;await wait(async()=>{pending=(await f.call('pairing.status',{inviteId:JSON.parse(invite.qr).inviteId})).invitation.request;return!!pending;});
 await f.call('pairing.approve',{inviteId:JSON.parse(invite.qr).inviteId,deviceRequestId:pending.requestId,deviceId:pending.deviceId,code:pending.code,operationId:randomUUID()});
 console.log((await native).stdout.trim());
}finally{await f.close();await fs.rm(root,{recursive:true,force:true});}
